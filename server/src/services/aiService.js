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
You are a structured extraction assistant. The user may speak in Vietnamese or English.
Convert every transcript into a JSON object with the following keys:
- buyerName (string) — tên người mua / buyer or company name
- taxId (string) — mã số thuế / tax identification number
- vatNumber (string) — số VAT / VAT registration number
- buyerAddress (string) — địa chỉ / buyer address
- invoiceType (string) — loại hóa đơn / invoice type (e.g. digital, printed)
- issueDate (ISO 8601 date string) — ngày phát hành / issue date
- lineItems (array of { description, quantity, unitPrice, vatRate, lineTotal }) — danh sách hàng hóa / line items

Understand Vietnamese number words: "nghìn"=1000, "triệu"=1000000, "phần trăm"=percent, "chiếc/cái"=unit.
Only reply with the JSON object. Use null or empty arrays for missing values.
`.trim();

const buildUserPrompt = (transcript, context) => {
  const contextText = context ? JSON.stringify(context) : 'None';
  return `Transcript:
${transcript}

Context:
${contextText}

Return the JSON payload described in the system instructions.`;
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

const generateAssistantResponse = (missingFields = [], intent = 'collect_more', capturedFields = []) => {
  if (intent === 'submit') {
    return 'Hoàn tất! Đang tạo hóa đơn. / All done! Submitting your invoice now.';
  }
  if (!missingFields.length) {
    return (
      'Tuyệt vời! Tôi đã có đủ thông tin. Bạn có muốn tạo hóa đơn ngay bây giờ không? Hãy nói "gửi hóa đơn" để xác nhận.\n' +
      'Great! All required details are captured. Say "submit invoice" to confirm, or review the fields on the right.'
    );
  }

  const remaining = missingFields.length;
  const target = missingFields[0];

  // Acknowledgement phrases when something was just captured
  const acks = [
    'Tốt lắm! / Got it!',
    'Được rồi! / Noted!',
    'Cảm ơn! / Thanks!',
    'OK!'
  ];
  const ack = capturedFields.length
    ? acks[capturedFields.length % acks.length] + ' '
    : '';

  const questions = {
    buyerName: (
      `${ack}Hóa đơn này dành cho ai? Hãy nói tên công ty hoặc tên người mua.\n` +
      `(${ack}Who is this invoice for? Say the buyer or company name.)`
    ),
    taxId: (
      `${ack}Mã số thuế của người mua là gì? Đọc từng chữ số rõ ràng.\n` +
      `(${ack}What's the buyer's tax ID? Read each digit clearly.)`
    ),
    vatNumber: (
      `${ack}Bạn có số VAT không? Nếu không có hãy nói "bỏ qua".\n` +
      `(${ack}Do you have a VAT number? Say "skip" if none.)`
    ),
    buyerAddress: (
      `${ack}Địa chỉ của người mua là gì? Nói số nhà, đường, quận, thành phố.\n` +
      `(${ack}What's the buyer's address? Include street, district, city.)`
    ),
    invoiceType: (
      `${ack}Đây là hóa đơn điện tử hay giấy? Nói "điện tử" hoặc "giấy".\n` +
      `(${ack}Digital or printed invoice? Say "digital" or "printed".)`
    ),
    issueDate: (
      `${ack}Ngày phát hành hóa đơn là ngày nào?\n` +
      `(${ack}What is the invoice issue date? E.g. "March 15, 2026".)`
    ),
    lineItems: (
      `${ack}Hàng hóa hoặc dịch vụ là gì? Ví dụ: "Tư vấn, 1 cái, 5 triệu, VAT 10%".\n` +
      `(${ack}What are the items? E.g. "Consulting, qty 1, 5 million, VAT 10%".)`
    )
  };

  const suffix = remaining > 1 ? ` (còn ${remaining - 1} trường nữa / ${remaining - 1} more fields)` : '';
  return (questions[target] || `${ack}Vui lòng cung cấp: ${target}. / Please provide: ${target}.`) + suffix;
};

const shouldSubmitNow = (transcript = '') => {
  const value = String(transcript).toLowerCase();
  return /\b(submit|send|finalize|finish|done)\b/.test(value);
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

  const client = getClient();
  const completion = await client.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserPrompt(transcript, context) }
    ]
  });

  const rawText = completion?.choices?.[0]?.message?.content ?? '';
  const extracted = extractJson(rawText);
  const mergedEntities = mergeContexts(context, extracted);
  const missingFields = determineMissingFields(mergedEntities);
  const intent = buildIntent(missingFields, transcript);

  // Fields that were just newly captured in this turn (not already in context)
  const newlyCaptured = HEADER_FIELDS.filter(
    (f) => mergedEntities[f] && !String(context[f] ?? '').trim()
  );
  const assistantResponse = generateAssistantResponse(missingFields, intent, newlyCaptured);
  const confidence = buildConfidence(missingFields);
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
exports.generateAssistantResponse = generateAssistantResponse;
