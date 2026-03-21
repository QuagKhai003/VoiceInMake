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
You are a structured extraction assistant. Convert every transcript into a JSON object with the following keys:
- buyerName (string)
- taxId (string)
- vatNumber (string)
- buyerAddress (string)
- invoiceType (string)
- issueDate (ISO 8601 date string)
- lineItems (array of { description, quantity, unitPrice, vatRate, lineTotal })

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

const generateAssistantResponse = (missingFields = [], intent = 'collect_more') => {
  if (intent === 'submit') {
    return 'Invoice data looks complete. Submitting now.';
  }
  if (!missingFields.length) {
    return 'All required invoice details are captured. Confirm if you want to submit now.';
  }
  const target = missingFields[0];
  const prompts = {
    buyerName: 'Who is the buyer or company? Provide the full name.',
    taxId: 'Please speak or type the buyer tax identification number.',
    vatNumber: 'Do you have the VAT number? Share it so I can fill it.',
    buyerAddress: 'Where should the invoice be addressed? Give me the buyer address.',
    invoiceType: 'Is this a digital or printed invoice? Say the type.',
    issueDate: 'What is the invoice issue date? Provide it in YYYY-MM-DD format.',
    lineItems: 'List at least one item with quantity, unit price, and VAT rate so I can capture line items.'
  };
  return prompts[target] || `Please provide ${target}.`;
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

exports.transcribeAudio = async (buffer, filename = 'audio.webm') => {
  const client = getClient();
  const file = await toFile(buffer, filename);
  const transcription = await client.audio.transcriptions.create({
    file,
    model: 'whisper-1'
  });

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
  const assistantResponse = generateAssistantResponse(missingFields, intent);
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
