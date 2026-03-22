const { OpenAI, toFile } = require('openai');

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
  return JSON.parse(rawText.slice(start, end + 1));
};

const systemPrompt = `
Bạn là trợ lý hóa đơn. Người dùng nói tiếng Việt hoặc tiếng Anh, bạn LUÔN trả lời tiếng Việt.

Bạn là chatbot hỗ trợ — KHÔNG phải form. Đừng hỏi dồn, đừng yêu cầu thông tin cụ thể, đừng liệt kê trường thiếu. Hãy ĐI THEO người dùng, không dẫn dắt họ.

Cách hoạt động:
- Người dùng nói gì thì ghi nhận cái đó. Không hỏi thêm trừ khi họ yêu cầu.
- Nếu người dùng đưa tên công ty → ghi nhận. Đưa mã số thuế → ghi nhận. Không cần hỏi ngược lại.
- Xác nhận ngắn gọn (1 câu) rồi IM LẶNG chờ. Ví dụ: "Đã ghi nhận công ty ABC." hoặc "OK, mã số thuế 0123456789."
- KHÔNG tự ý hỏi "Còn thông tin gì nữa không?" hay "Bạn có muốn thêm gì không?" liên tục
- Nếu người dùng hỏi gì hoặc nói chuyện → trả lời bình thường
- Nếu người dùng muốn điền hóa đơn trên web → hỏi URL, rồi hỏi đăng nhập
- Khi có đủ URL + username + password → HỎI XÁC NHẬN trước, KHÔNG tự bắt đầu. Chờ người dùng nói đồng ý rồi mới start_automation.
- Lưu ý: giọng nói có thể bị nhận sai. Nếu thấy từ lạ, cố đoán ý đúng từ ngữ cảnh.

Trích xuất (chỉ ghi nhận thông tin MỚI trong câu nói hiện tại):
- buyerName, taxId, vatNumber, buyerAddress, invoiceType, issueDate
- lineItems: array of { description, quantity, unitPrice, vatRate, lineTotal }
- BẤT KỲ trường nào khác người dùng đề cập

Trả về JSON duy nhất:
{
  "extractedFields": { ... chỉ trường MỚI ... },
  "assistantResponse": "xác nhận ngắn gọn",
  "intent": "chat" | "collect_automation" | "confirm_automation" | "start_automation",
  "automationFields": { "websiteUrl": "", "username": "", "password": "" }
}

LOGIC CHỌN intent (QUAN TRỌNG — tuân thủ đúng):
1. "chat" — mặc định, trò chuyện bình thường hoặc ghi nhận thông tin hóa đơn
2. "collect_automation" — người dùng đề cập muốn điền trên web nhưng THIẾU 1 trong 3: websiteUrl, username, password. Hỏi thông tin còn thiếu.
3. "confirm_automation" — automationFields ĐÃ CÓ ĐỦ cả 3 (websiteUrl + username + password) từ tin nhắn hiện tại HOẶC từ "Thông tin tự động hóa đã có" kết hợp. Bạn PHẢI dùng intent này và hỏi xác nhận. assistantResponse ví dụ: "Tôi đã có đủ thông tin: URL vinvoice.viettel.vn, tài khoản 0319080151. Bạn muốn bắt đầu tự động điền hóa đơn không?"
4. "start_automation" — CHỈ dùng khi người dùng đã xác nhận sau confirm_automation (nói "bắt đầu", "ok", "đi", "được", "ừ", "yes", "start", "làm đi", "chạy đi" hoặc tương tự)

QUY TẮC: Nếu trong automationFields bạn trả về đã có cả websiteUrl, username VÀ password → BẮT BUỘC dùng "confirm_automation", KHÔNG ĐƯỢC dùng "collect_automation".

Hiểu số tiếng Việt: nghìn=1000, triệu=1000000, phần trăm=%, chiếc/cái=đơn vị.
Dùng null cho giá trị không đề cập. Chỉ JSON, không markdown.
`.trim();

const buildUserPrompt = (transcript, context, automationContext) => {
  const contextText = context && Object.keys(context).length
    ? JSON.stringify(context, null, 0)
    : 'Chưa có thông tin nào';
  const autoText = automationContext && Object.keys(automationContext).length
    ? `\nThông tin tự động hóa đã có: ${JSON.stringify(automationContext)}`
    : '';

  return `Người dùng nói: "${transcript}"

Thông tin đã thu thập trước đó:
${contextText}${autoText}

Trả về JSON.`;
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
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeLineItems = (items) => {
  if (!Array.isArray(items)) return [];
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

const normalizeValue = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

// Merge new extracted fields into existing context — only overwrite non-empty new values
const mergeIntoContext = (existing = {}, newFields = {}) => {
  const merged = { ...existing };

  for (const [key, value] of Object.entries(newFields)) {
    if (key === 'lineItems') {
      const items = normalizeLineItems(value);
      if (items.length) merged.lineItems = items;
    } else if (key === 'issueDate') {
      const date = parseDateValue(value);
      if (date) merged.issueDate = date;
    } else if (value !== null && value !== undefined && String(value).trim()) {
      merged[key] = normalizeValue(value);
    }
  }

  return merged;
};

exports.transcribeAudio = async (buffer, filename = 'audio.webm', mimeType = 'audio/webm', language = 'vi') => {
  const client = getClient();
  const file = await toFile(buffer, filename, { type: mimeType });
  const transcriptionOptions = { file, model: 'whisper-1' };
  if (language && language !== 'auto') {
    transcriptionOptions.language = language;
  }
  const transcription = await client.audio.transcriptions.create(transcriptionOptions);
  if (!transcription?.text) {
    throw new Error('Whisper did not return any transcription text');
  }
  return transcription.text.trim();
};

exports.extractInvoiceEntities = async (transcript, context = {}, automationContext = {}) => {
  if (!transcript) {
    throw new Error('Transcript is required for extraction');
  }

  const client = getClient();
  const completion = await client.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.7,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserPrompt(transcript, context, automationContext) }
    ]
  });

  const rawText = completion?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(rawText);
  const newFields = parsed.extractedFields || {};
  const mergedEntities = mergeIntoContext(context, newFields);
  const intent = parsed.intent || 'chat';
  const automationFields = parsed.automationFields || {};
  const assistantResponse = parsed.assistantResponse || 'Tôi đã ghi nhận. Bạn muốn tiếp tục thế nào?';

  return {
    extractedEntities: mergedEntities,
    assistantResponse,
    automationFields,
    intent
  };
};

exports.extractInvoiceData = exports.extractInvoiceEntities;
