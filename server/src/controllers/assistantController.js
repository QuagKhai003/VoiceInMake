const assistantPlanningService = require('../services/assistantPlanningService');

exports.plan = async (req, res, next) => {
  try {
    const { invoiceContext, websiteContext, transcript, voiceSession } = req.body || {};
    const plan = await assistantPlanningService.buildAssistantPlan({
      invoiceContext,
      websiteContext,
      transcript,
      voiceSession
    });

    res.status(200).json(plan);
  } catch (error) {
    if (error.code && error.status) {
      const message = error.code === 'ASSISTANT_PLAN_CONFIG_ERROR'
        ? 'Assistant planning service is not configured'
        : 'Invalid planning request payload';
      return res.status(error.status).json({
        message,
        code: error.code,
        error: error.message
      });
    }

    return next(error);
  }
};
