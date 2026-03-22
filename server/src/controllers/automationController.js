const { getAgent, resetAgent } = require('../services/browserAgentService');

/**
 * POST /api/automation/start
 * Body: { websiteUrl, credentials: { username, password }, invoiceData }
 */
exports.start = async (req, res) => {
  const { websiteUrl, credentials, invoiceData } = req.body || {};

  if (!websiteUrl || !credentials?.username || !credentials?.password) {
    return res.status(400).json({ message: 'websiteUrl và credentials (username, password) là bắt buộc.' });
  }

  if (!invoiceData || typeof invoiceData !== 'object') {
    return res.status(400).json({ message: 'invoiceData là bắt buộc.' });
  }

  const agent = resetAgent();

  // Start automation in background
  agent.run({ websiteUrl, credentials, invoiceData }).catch((err) => {
    console.error('Automation error:', err);
  });

  res.status(200).json({ message: 'Đã bắt đầu tự động hóa.', status: 'running' });
};

/**
 * POST /api/automation/instruct
 * Body: { message: string }
 */
exports.instruct = async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ message: 'message is required.' });
  }
  const agent = getAgent();
  if (!agent.running) {
    return res.status(409).json({ message: 'Không có tự động hóa đang chạy.' });
  }
  agent.injectMessage(message.trim());
  res.status(200).json({ message: 'Đã nhận hướng dẫn.' });
};

/**
 * POST /api/automation/stop
 */
exports.stop = async (req, res) => {
  const agent = getAgent();
  await agent.stop();
  res.status(200).json({ message: 'Đã dừng tự động hóa.' });
};

/**
 * GET /api/automation/events (SSE)
 */
exports.events = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const agent = getAgent();
  agent.addListener(res);

  req.on('close', () => {
    agent.removeListener(res);
  });
};
