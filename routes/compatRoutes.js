const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getDashboard, getMentorAttention, getAnalytics } = require('../controllers/insightController');

router.use(protect);
router.get('/dashboard/stats', getDashboard);
router.get('/analytics/overview', getAnalytics);
router.get('/mentor/attention', getMentorAttention);

module.exports = router;
