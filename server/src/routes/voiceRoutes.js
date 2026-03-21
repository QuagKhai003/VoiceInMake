const express = require('express');
const multer = require('multer');
const voiceController = require('../controllers/voiceController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB cap
});

const router = express.Router();

router.post('/text', voiceController.processText);
router.post('/', upload.single('audio'), voiceController.processVoice);

module.exports = router;
