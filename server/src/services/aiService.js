const { OpenAI, toFile } = require('openai');

const HEADER_FIELDS = ['buyerName', 'taxId', 'vatNumber', 'buyerAddress', 'invoiceType', 'issueDate'];

const getClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for AI services');
  }

  return new OpenAI({ apiKey });
};

const extractJson = (rawText) => {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('LLM response was empty');
  }
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('LLM response did not contain JSON');
  }
  const jsonChunk = rawText.slice(start, end + 1);
  return JSON.parse(jsonChunk);
};

const systemPrompt = `
Bạn là trợ lý tạo hóa đơn thông minh. Người dùng có thể nói tiếng Việt hoặc tiếng Anh, nhưng bạn LUÔN trả lời bằng tiếng Việt.

Nhiệm vụ của bạn:
1. Trích xuất thông tin hóa đơn từ lời nói của người dùng
2. Trả lời tự nhiên, thân thiện như một cuộc trò chuyện thật

Trả về JSON với các trường:
- extractedFields: object chứa các trường đã trích xuất:
  - buyerName (string) — tên người mua / công ty
  - taxId (string) — mã số thuế
  - vatNumber (string) — số VAT
  - buyerAddress (string) — địa chỉ người mua
  - invoiceType (string) — loại hóa đơn (điện tử / giấy)
  - issueDate (ISO 8601 date string) — ngày phát hành
  - lineItems (array of { description, quantity, unitPrice, vatRate, lineTotal }) — hàng hóa / dịch vụ
- assistantResponse (string) — câu trả lời tự nhiên bằng tiếng Việt

Quy tắc cho assistantResponse:
- Nói chuyện tự nhiên, thân thiện, ngắn gọn (1-2 câu)
- Nếu người dùng vừa cung cấp thông tin, xác nhận lại những gì bạn đã ghi nhận
- Nếu còn thiếu thông tin, hỏi tiếp một cách tự nhiên (không liệt kê)
- Nếu đủ thông tin, hỏi người dùng có muốn gửi hóa đơn không
- Nếu người dùng nói chuyện phiếm hoặc hỏi gì đó, trả lời bình thường rồi quay lại hóa đơn
- Hiểu số tiếng Việt: "nghìn"=1000, "triệu"=1000000, "phần trăm"=percent, "chiếc/cái"=đơn vị

Dùng null hoặc mảng rỗng cho các giá trị chưa có. Chỉ trả về JSON, không markdown.
`.trim();

const buildUserPrompt = (transcript, context, missingFields) => {
  const contextText = context && Object.keys(context).length ? JSON.stringify(context) : 'Chưa có thông tin nào';
  const missingText = missingFields?.length ? missingFields.join(', ') : 'Không còn thiếu';
  return `Người dùng nói: "${transcript}"

Thông tin đã thu thập:
${contextText}

Trường còn thiếu: ${missingText}

Trả về JSON với extractedFields và assistantResponse.`;
};

const parseDateValue = (value) => {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

const normalizeNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeLineItems = (items) => {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      description: item?.description?.trim() ?? '',
      quantity: normalizeNumber(item?.quantity) ?? 0,
      unitPrice: normalizeNumber(item?.unitPrice) ?? 0,
      vatRate: normalizeNumber(item?.vatRate) ?? 0,
      lineTotal: normalizeNumber(item?.lineTotal) ?? 0
    }))
    .filter((item) => item.description || item.quantity || item.unitPrice || item.lineTotal);
};

const normalizeHeaderValue = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const normalizeEntities = (source = {}) => ({
  buyerName: normalizeHeaderValue(source?.buyerName),
  taxId: normalizeHeaderValue(source?.taxId),
  vatNumber: normalizeHeaderValue(source?.vatNumber),
  buyerAddress: normalizeHeaderValue(source?.buyerAddress),
  invoiceType: normalizeHeaderValue(source?.invoiceType),
  issueDate: parseDateValue(source?.issueDate),
  lineItems: normalizeLineItems(source?.lineItems)
});

const mergeContexts = (context = {}, extracted = {}) => {
  const normalizedContext = normalizeEntities(context);
  const normalizedExtracted = normalizeEntities(extracted);

  const merged = {};
  for (const field of HEADER_FIELDS) {
    merged[field] = normalizedExtracted[field] || normalizedContext[field] || '';
  }

  merged.lineItems = normalizedExtracted.lineItems.length
    ? normalizedExtracted.lineItems
    : normalizedContext.lineItems;

  return merged;
};

const determineMissingFields = (entities = {}) => {
  const missing = HEADER_FIELDS.filter((field) => !String(entities[field] ?? '').trim());
  if (!entities.lineItems?.length) {
    missing.push('lineItems');
  }
  return missing;
};


const shouldSubmitNow = (transcript = '') => {
  const value = String(transcript).toLowerCase();
  return /\b(submit|send|finalize|finish|done)\b/.test(value) ||
    /gửi hóa đơn|gửi hoá đơn|xác nhận|hoàn tất|xong rồi|gửi đi/.test(value);
};

const buildIntent = (missingFields = [], transcript = '') => {
  if (missingFields.length) {
    return 'collect_more';
  }
  return shouldSubmitNow(transcript) ? 'submit' : 'confirm';
};

const buildConfidence = (missingFields = []) => {
  const total = HEADER_FIELDS.length + 1;
  const ratio = Math.min(missingFields.length / total, 1);
  return Number((1 - ratio).toFixed(2));
};

exports.transcribeAudio = async (buffer, filename = 'audio.webm', mimeType = 'audio/webm', language = 'vi') => {
  const client = getClient();
  const file = await toFile(buffer, filename, { type: mimeType });
  const transcriptionOptions = { file, model: 'whisper-1' };
  // Pass language hint to Whisper for faster, more accurate transcription
  // 'auto' means let Whisper detect; otherwise pass ISO 639-1 code (vi, en, etc.)
  if (language && language !== 'auto') {
    transcriptionOptions.language = language;
  }
  const transcription = await client.audio.transcriptions.create(transcriptionOptions);

  if (!transcription?.text) {
    throw new Error('Whisper did not return any transcription text');
  }

  return transcription.text.trim();
};

exports.extractInvoiceEntities = async (transcript, context = {}) => {
  if (!transcript) {
    throw new Error('Transcript is required for extraction');
  }

  // Pre-compute missing fields from current context to inform GPT
  const currentEntities = normalizeEntities(context);
  const currentMissing = determineMissingFields(currentEntities);

  const client = getClient();
  const completion = await client.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.7,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserPrompt(transcript, context, currentMissing) }
    ]
  });

  const rawText = completion?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(rawText);
  const extracted = parsed.extractedFields || parsed;
  const mergedEntities = mergeContexts(context, extracted);
  const missingFields = determineMissingFields(mergedEntities);
  const intent = buildIntent(missingFields, transcript);
  const confidence = buildConfidence(missingFields);

  // Use GPT-generated response, fall back to simple prompt if missing
  const assistantResponse = parsed.assistantResponse ||
    (missingFields.length ? 'Bạn có thể cho tôi biết thêm thông tin không?' : 'Đã đủ thông tin. Bạn có muốn gửi hóa đơn không?');

  const normalizedContext = {
    ...mergedEntities,
    assistantMetadata: {
      missingFields,
      confidence,
      intent,
      lastQuestion: assistantResponse
    }
  };

  return {
    extractedEntities: mergedEntities,
    normalizedContext,
    missingFields,
    assistantResponse,
    intent,
    confidence,
    lastQuestion: assistantResponse
  };
};

exports.extractInvoiceData = exports.extractInvoiceEntities;
