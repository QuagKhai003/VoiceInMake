const assistantPlanningService = require('./assistantPlanningService');

// Backward-compatible wrapper: keeps the old service name while enforcing
// semantic planning only (no browser automation, no DOM selectors).
exports.draftInvoiceOnWebsite = async ({
  invoiceContext = {},
  websiteContext = {},
  transcript = '',
  voiceSession = {}
} = {}) => {
  return assistantPlanningService.buildAssistantPlan({
    invoiceContext,
    websiteContext,
    transcript,
    voiceSession
  });
};
