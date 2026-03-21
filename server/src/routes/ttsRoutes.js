const express = require('express');
const router = express.Router();
const ttsController = require('../controllers/ttsController');

router.post('/', ttsController.synthesise);

module.exports = router;
