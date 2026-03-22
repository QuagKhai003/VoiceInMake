const express = require('express');
const automationController = require('../controllers/automationController');

const router = express.Router();

router.post('/start', automationController.start);
router.post('/instruct', automationController.instruct);
router.post('/stop', automationController.stop);
router.get('/events', automationController.events);

module.exports = router;
