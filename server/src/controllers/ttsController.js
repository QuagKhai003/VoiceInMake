const { OpenAI } = require('openai');

const getClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY is required for TTS');
    err.status = 500;
    err.code = 'TTS_CONFIG_ERROR';
    throw err;
  }
  return new OpenAI({ apiKey });
};

// Map language codes to TTS voice — 'nova' and 'shimmer' handle Vietnamese well
const voiceForLanguage = (lang = 'vi') => {
  if (lang === 'en') return 'nova';
  return 'nova'; // nova handles Vietnamese naturally
};

exports.synthesise = async (req, res) => {
  const { text, language = 'vi' } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ message: 'text is required', code: 'TTS_TEXT_REQUIRED' });
  }

  // Truncate to 4096 chars (OpenAI TTS limit)
  const input = text.trim().slice(0, 4096);

  try {
    const client = getClient();
    const mp3 = await client.audio.speech.create({
      model: 'tts-1',
      voice: voiceForLanguage(language),
      input,
      response_format: 'mp3',
      speed: 1.0
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({
      message: 'Text-to-speech failed',
      code: 'TTS_ERROR',
      error: error.message
    });
  }
};
