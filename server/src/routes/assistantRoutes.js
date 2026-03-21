const express = require('express');
const assistantController = require('../controllers/assistantController');

const router = express.Router();

router.post('/plan', assistantController.plan);

module.exports = router;
