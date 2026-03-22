const aiService = require('../services/aiService');
const path = require('path');

const ALLOWED_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a'
]);

const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.webm', '.ogg', '.m4a', '.mp4']);

const hasKnownAudioHeader = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }

  const riff = buffer.subarray(0, 4).toString('ascii') === 'RIFF';
  const wave = buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  if (riff && wave) {
    return true;
  }

  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') {
    return true;
  }

  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    return true;
  }

  // EBML signature for WebM/Matroska
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return true;
  }

  // "ftyp" box for MP4/M4A containers
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return true;
  }

  return false;
};

const isSupportedAudioFile = (file) => {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  const mimeType = String(file?.mimetype || '').toLowerCase();
  const hasMimeOrExtMatch = ALLOWED_MIME_TYPES.has(mimeType) || ALLOWED_EXTENSIONS.has(extension);
  return hasMimeOrExtMatch && hasKnownAudioHeader(file?.buffer);
};

const parseContext = (contextPayload) => {
  if (!contextPayload) {
    return {};
  }
  if (typeof contextPayload === 'string') {
    try {
      return JSON.parse(contextPayload);
    } catch (err) {
      console.warn('Unable to parse context payload; falling back to empty object.');
      return {};
    }
  }
  return contextPayload;
};

/**
 * POST /api/voice/text
 * Accepts a pre-transcribed text (from browser Web Speech API) and skips Whisper.
 * Body: { transcript: string, context?: object, language?: string }
 */
exports.processText = async (req, res) => {
  const { transcript, context: rawContext, automationContext: rawAutoContext, language = 'vi' } = req.body || {};

  if (!transcript || !String(transcript).trim()) {
    return res.status(400).json({
      message: 'transcript is required.',
      code: 'VOICE_TRANSCRIPT_REQUIRED'
    });
  }

  const context = parseContext(rawContext);
  const automationContext = parseContext(rawAutoContext);

  try {
    const payload = await aiService.extractInvoiceEntities(String(transcript).trim(), context, automationContext);
    res.status(200).json({ transcript, ...payload, language });
  } catch (error) {
    console.error('Text processing failed', error);
    res.status(502).json({
      message: 'Failed to process transcript.',
      code: 'VOICE_PROCESSING_ERROR',
      error: error.message
    });
  }
};

exports.processVoice = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      message: 'Missing audio payload (field name should be "audio").',
      code: 'VOICE_AUDIO_REQUIRED'
    });
  }

  if (!isSupportedAudioFile(req.file)) {
    return res.status(400).json({
      message: 'Unsupported or invalid audio file. Use a valid MP3/WAV/WEBM/OGG/M4A recording.',
      code: 'VOICE_INVALID_AUDIO_FORMAT'
    });
  }

  const context = parseContext(req.body.context);
  const language = req.body.language || 'vi';

  try {
    const transcript = await aiService.transcribeAudio(req.file.buffer, req.file.originalname, req.file.mimetype || 'audio/webm', language);
    const payload = await aiService.extractInvoiceEntities(transcript, context);

    res.status(200).json({
      transcript,
      ...payload,
      language,
      message: 'Voice payload processed successfully'
    });
  } catch (error) {
    console.error('Voice processing failed', error);
    const isConfigError = /OPENAI_API_KEY/.test(error.message);
    const normalizedMessage = String(error?.error?.message || error.message || '').toLowerCase();
    const isInvalidAudioError = /invalid file format|could not be decoded|format is not supported|audio file is too short/.test(normalizedMessage);
    const statusCode = isConfigError ? 500 : isInvalidAudioError ? 400 : 502;
    const message = normalizedMessage.includes('too short')
      ? 'Recording was too short. Hold the mic button longer, then release to send.'
      : isInvalidAudioError
        ? 'The recording could not be decoded. Try again and keep holding the mic while speaking.'
        : 'Voice processing failed';

    res.status(statusCode).json({
      message,
      code: isConfigError
        ? 'VOICE_CONFIG_ERROR'
        : isInvalidAudioError
          ? 'VOICE_INVALID_AUDIO_FORMAT'
          : 'VOICE_PROCESSING_ERROR',
      error: error.message
    });
  }
};
