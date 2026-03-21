const { OpenAI } = require('openai');

const ALLOWED_INTENTS = new Set(['collect_more', 'fill_field', 'navigate_tab', 'confirm', 'submit']);

const REQUIRED_HEADER_FIELDS = [
  'buyerName',
  'taxId',
  'vatNumber',
  'buyerAddress',
  'invoiceType',
  'issueDate'
];

const FIELD_CONFIG = {
  buyerName: {
    label: 'buyer name',
    targetTab: 'Buyer',
    targetSection: 'Buyer details',
    expectedValuePattern: 'Full legal customer/company name'
  },
  taxId: {
    label: 'tax ID',
    targetTab: 'Buyer',
    targetSection: 'Buyer details',
    expectedValuePattern: 'Tax identifier string (letters/numbers)'
  },
  vatNumber: {
    label: 'VAT number',
    targetTab: 'Buyer',
    targetSection: 'Buyer details',
    expectedValuePattern: 'VAT registration number format for buyer country'
  },
  buyerAddress: {
    label: 'buyer address',
    targetTab: 'Buyer',
    targetSection: 'Address',
    expectedValuePattern: 'Street, city, region, postal code, country'
  },
  invoiceType: {
    label: 'invoice type',
    targetTab: 'Invoice',
    targetSection: 'Invoice settings',
    expectedValuePattern: 'One of: digital, printed, or equivalent supported type'
  },
  issueDate: {
    label: 'issue date',
    targetTab: 'Invoice',
    targetSection: 'Invoice settings',
    expectedValuePattern: 'YYYY-MM-DD'
  },
  lineItems: {
    label: 'line items',
    targetTab: 'Items',
    targetSection: 'Item table',
    expectedValuePattern: 'At least one item with description, quantity, unitPrice, vatRate'
  }
};

const normalizeString = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const normalizeNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeDate = (value) => {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

const normalizeLineItems = (lineItems) => {
  if (!Array.isArray(lineItems)) {
    return [];
  }

  return lineItems
    .map((item) => ({
      description: normalizeString(item?.description),
      quantity: normalizeNumber(item?.quantity),
      unitPrice: normalizeNumber(item?.unitPrice),
      vatRate: normalizeNumber(item?.vatRate),
      lineTotal: normalizeNumber(item?.lineTotal)
    }))
    .filter((item) => item.description || item.quantity || item.unitPrice || item.lineTotal);
};

const normalizeInvoiceContext = (source = {}) => ({
  buyerName: normalizeString(source.buyerName),
  taxId: normalizeString(source.taxId),
  vatNumber: normalizeString(source.vatNumber),
  buyerAddress: normalizeString(source.buyerAddress),
  invoiceType: normalizeString(source.invoiceType),
  issueDate: normalizeDate(source.issueDate),
  lineItems: normalizeLineItems(source.lineItems)
});

const normalizeWebsiteContext = (source = {}) => ({
  page: normalizeString(source.page),
  currentTab: normalizeString(source.currentTab),
  currentSection: normalizeString(source.currentSection),
  activeField: normalizeString(source.activeField),
  lastAction: normalizeString(source.lastAction),
  notes: normalizeString(source.notes)
});

const parseWebsiteContextFromString = (rawText = '') => {
  const text = normalizeString(rawText);
  const lowered = text.toLowerCase();

  const tabMap = [
    { key: 'buyer', label: 'Buyer' },
    { key: 'item', label: 'Items' },
    { key: 'invoice', label: 'Invoice' },
    { key: 'review', label: 'Review' }
  ];

  const matchedTab = tabMap.find((entry) => lowered.includes(entry.key));
  const currentTab = matchedTab ? matchedTab.label : '';

  const fieldMap = [
    { key: 'buyer name', field: 'buyerName' },
    { key: 'tax id', field: 'taxId' },
    { key: 'vat', field: 'vatNumber' },
    { key: 'address', field: 'buyerAddress' },
    { key: 'issue date', field: 'issueDate' },
    { key: 'line item', field: 'lineItems' },
    { key: 'item', field: 'lineItems' }
  ];

  const matchedField = fieldMap.find((entry) => lowered.includes(entry.key));
  const activeField = matchedField ? matchedField.field : '';

  return {
    page: '',
    currentTab,
    currentSection: '',
    activeField,
    lastAction: '',
    notes: text
  };
};

const normalizeVoiceSession = (source = {}) => ({
  sessionId: normalizeString(source.sessionId),
  turnIndex: Number.isFinite(Number(source.turnIndex)) ? Number(source.turnIndex) : 0,
  speaker: normalizeString(source.speaker),
  locale: normalizeString(source.locale),
  channel: normalizeString(source.channel),
  metadata: source?.metadata && typeof source.metadata === 'object' ? source.metadata : {}
});

const computeMissingFields = (invoiceContext = {}) => {
  const missingFields = REQUIRED_HEADER_FIELDS.filter((field) => !invoiceContext[field]);
  if (!Array.isArray(invoiceContext.lineItems) || invoiceContext.lineItems.length === 0) {
    missingFields.push('lineItems');
  }
  return missingFields;
};

const inferIntentHeuristic = ({ transcript, missingFields }) => {
  const lowered = normalizeString(transcript).toLowerCase();
  const asksSubmit = /\b(submit|send|finalize|finish|done|complete)\b/.test(lowered);
  const asksNavigate = /\b(open|switch|go|move|navigate)\b.*\b(tab|section|field|buyer|invoice|items)\b/.test(lowered);

  if (asksSubmit) {
    return missingFields.length ? 'collect_more' : 'submit';
  }
  if (asksNavigate) {
    return 'navigate_tab';
  }
  if (missingFields.length) {
    return 'collect_more';
  }
  return 'confirm';
};

const firstMissingField = (missingFields = []) => missingFields[0] || '';

const sanitizeAction = (action = {}, fallbackField) => {
  const field = normalizeString(action.targetField) || fallbackField;
  const fieldConfig = FIELD_CONFIG[field] || FIELD_CONFIG.lineItems;
  const type = normalizeString(action.type) || 'fill_field';

  return {
    type,
    label: normalizeString(action.label) || `Fill ${fieldConfig.label}`,
    targetTab: normalizeString(action.targetTab) || fieldConfig.targetTab,
    targetSection: normalizeString(action.targetSection) || fieldConfig.targetSection,
    targetField: field,
    expectedValuePattern: normalizeString(action.expectedValuePattern) || fieldConfig.expectedValuePattern,
    userCommand:
      normalizeString(action.userCommand) ||
      `Please enter ${fieldConfig.label} and confirm the exact value back to me.`,
    reason: normalizeString(action.reason) || `${fieldConfig.label} is required before submit.`
  };
};

const buildFallbackPlan = ({ websiteContext, transcript, missingFields }) => {
  const missingField = firstMissingField(missingFields);
  const fallbackIntent = inferIntentHeuristic({ transcript, missingFields });

  if (!missingField && fallbackIntent === 'submit') {
    const submitAction = {
      type: 'submit',
      label: 'Submit invoice',
      targetTab: websiteContext.currentTab || 'Review',
      targetSection: websiteContext.currentSection || 'Summary',
      targetField: '',
      expectedValuePattern: 'All required invoice fields complete',
      userCommand: 'Click Submit invoice now and confirm success message.',
      reason: 'All required fields are present and user asked to submit.'
    };

    return {
      intent: 'submit',
      recommendedActions: [submitAction],
      assistantResponse: 'All required data is complete. Please submit the invoice now.',
      dynamicCommands: [submitAction.userCommand]
    };
  }

  const targetField = missingField || 'lineItems';
  const fieldConfig = FIELD_CONFIG[targetField] || FIELD_CONFIG.lineItems;
  const action = sanitizeAction(
    {
      type: fallbackIntent === 'navigate_tab' ? 'navigate_tab' : 'fill_field',
      targetField,
      targetTab: fieldConfig.targetTab,
      targetSection: fieldConfig.targetSection,
      expectedValuePattern: fieldConfig.expectedValuePattern,
      userCommand: `Open ${fieldConfig.targetTab} tab and fill ${fieldConfig.label}.`,
      reason: `${fieldConfig.label} is currently missing.`
    },
    targetField
  );

  const assistantResponse =
    fallbackIntent === 'navigate_tab'
      ? `Open ${action.targetTab} tab and tell me when ${action.targetField} is visible.`
      : `Please provide ${fieldConfig.label} so I can continue.`;

  return {
    intent: fallbackIntent,
    recommendedActions: [action],
    assistantResponse,
    dynamicCommands: [action.userCommand]
  };
};

const extractJson = (rawText) => {
  const text = normalizeString(rawText);
  if (!text) {
    throw new Error('Planner model returned empty content.');
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Planner model did not return JSON content.');
  }

  return JSON.parse(text.slice(start, end + 1));
};

const getClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is required for assistant planning service.');
    error.status = 500;
    error.code = 'ASSISTANT_PLAN_CONFIG_ERROR';
    throw error;
  }

  return new OpenAI({ apiKey });
};

const buildPlannerPrompt = ({ invoiceContext, websiteContext, transcript, voiceSession, missingFields }) => {
  return [
    'You are an invoice speech-to-action orchestration planner for vinvoice.com.',
    'Return JSON only. No markdown. No selectors. No CSS/XPath.',
    'Your plan must be deterministic, concise, and field-level actionable.',
    'Allowed intent values: collect_more, fill_field, navigate_tab, confirm, submit.',
    'Each recommended action must include:',
    '- type',
    '- label',
    '- targetTab',
    '- targetSection',
    '- targetField',
    '- expectedValuePattern',
    '- userCommand',
    '- reason',
    'Also return:',
    '- assistantResponse (one concise sentence)',
    '- dynamicCommands (array of short executable/speakable commands)',
    'If required fields remain missing, intent cannot be submit.',
    '',
    `invoiceContext: ${JSON.stringify(invoiceContext)}`,
    `websiteContext: ${JSON.stringify(websiteContext)}`,
    `transcript: ${JSON.stringify(transcript || '')}`,
    `voiceSession: ${JSON.stringify(voiceSession || {})}`,
    `missingFields: ${JSON.stringify(missingFields)}`
  ].join('\n');
};

const callPlannerModel = async ({ invoiceContext, websiteContext, transcript, voiceSession, missingFields }) => {
  const client = getClient();
  const model = process.env.OPENAI_PLANNER_MODEL || 'gpt-4o-mini';

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Return strict JSON only with keys: intent, recommendedActions, assistantResponse, dynamicCommands.'
      },
      {
        role: 'user',
        content: buildPlannerPrompt({
          invoiceContext,
          websiteContext,
          transcript,
          voiceSession,
          missingFields
        })
      }
    ]
  });

  const rawText = completion?.choices?.[0]?.message?.content;
  return extractJson(rawText);
};

const sanitizeModelPlan = ({ modelPlan, missingFields, transcript, websiteContext }) => {
  const fallback = buildFallbackPlan({ websiteContext, transcript, missingFields });
  const rawIntent = normalizeString(modelPlan?.intent);
  let intent = ALLOWED_INTENTS.has(rawIntent) ? rawIntent : fallback.intent;

  if (missingFields.length > 0 && intent === 'submit') {
    intent = 'collect_more';
  }

  const targetFallbackField = firstMissingField(missingFields) || 'lineItems';
  const recommendedActions = Array.isArray(modelPlan?.recommendedActions)
    ? modelPlan.recommendedActions.map((action) => sanitizeAction(action, targetFallbackField))
    : fallback.recommendedActions;

  const assistantResponse = normalizeString(modelPlan?.assistantResponse) || fallback.assistantResponse;

  const dynamicCommandsFromModel = Array.isArray(modelPlan?.dynamicCommands)
    ? modelPlan.dynamicCommands.map((command) => normalizeString(command)).filter(Boolean)
    : [];

  const dynamicCommands = dynamicCommandsFromModel.length
    ? dynamicCommandsFromModel
    : recommendedActions.map((action) => action.userCommand).filter(Boolean);

  return {
    intent,
    recommendedActions,
    assistantResponse,
    dynamicCommands
  };
};

const validatePayload = ({ invoiceContext, websiteContext }) => {
  if (!invoiceContext || typeof invoiceContext !== 'object' || Array.isArray(invoiceContext)) {
    const error = new Error('invoiceContext must be an object.');
    error.status = 400;
    error.code = 'ASSISTANT_PLAN_INVALID_INVOICE_CONTEXT';
    throw error;
  }

  if (typeof websiteContext === 'string') {
    return;
  }

  if (!websiteContext || typeof websiteContext !== 'object' || Array.isArray(websiteContext)) {
    const error = new Error('websiteContext must be an object.');
    error.status = 400;
    error.code = 'ASSISTANT_PLAN_INVALID_WEBSITE_CONTEXT';
    throw error;
  }
};

exports.buildAssistantPlan = async ({ invoiceContext, websiteContext, transcript = '', voiceSession = {} }) => {
  validatePayload({ invoiceContext, websiteContext });

  const normalizedInvoiceContext = normalizeInvoiceContext(invoiceContext);
  const normalizedWebsiteContext = typeof websiteContext === 'string'
    ? parseWebsiteContextFromString(websiteContext)
    : normalizeWebsiteContext(websiteContext);
  const normalizedTranscript = normalizeString(transcript);
  const normalizedVoiceSession = normalizeVoiceSession(voiceSession);
  const missingFields = computeMissingFields(normalizedInvoiceContext);

  try {
    const modelPlan = await callPlannerModel({
      invoiceContext: normalizedInvoiceContext,
      websiteContext: normalizedWebsiteContext,
      transcript: normalizedTranscript,
      voiceSession: normalizedVoiceSession,
      missingFields
    });

    const sanitized = sanitizeModelPlan({
      modelPlan,
      missingFields,
      transcript: normalizedTranscript,
      websiteContext: normalizedWebsiteContext
    });

    return {
      intent: sanitized.intent,
      recommendedActions: sanitized.recommendedActions,
      assistantResponse: sanitized.assistantResponse,
      missingFields,
      dynamicCommands: sanitized.dynamicCommands
    };
  } catch (error) {
    if (error.code === 'ASSISTANT_PLAN_CONFIG_ERROR') {
      throw error;
    }

    const fallback = buildFallbackPlan({
      websiteContext: normalizedWebsiteContext,
      transcript: normalizedTranscript,
      missingFields
    });

    return {
      intent: fallback.intent,
      recommendedActions: fallback.recommendedActions,
      assistantResponse: fallback.assistantResponse,
      missingFields,
      dynamicCommands: fallback.dynamicCommands
    };
  }
};
