const express = require('express');
const Alert = require('../models/Alert');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/alerts - 获取告警列表
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { pondId, type, level, acknowledged, page, limit } = req.query;
    const pageSize = parseInt(limit, 10) || 20;
    const pageNum = parseInt(page, 10) || 1;

    const query = {};

    if (pondId) {
      query.pondId = pondId;
    }
    if (type) {
      query.type = type;
    }
    if (level) {
      query.level = level;
    }
    if (acknowledged !== undefined) {
      query.acknowledged = acknowledged === 'true';
    }

    const total = await Alert.countDocuments(query);
    // 修复：按 detectedAt（设备真实检测时间）倒序展示，
    // 缺失 detectedAt 的历史告警回退到 createdAt，不影响排序稳定性
    const alerts = await Alert.find(query)
      .sort({ detectedAt: -1, createdAt: -1 })
      .skip((pageNum - 1) * pageSize)
      .limit(pageSize)
      .lean();

    res.json({
      success: true,
      data: {
        list: alerts,
        total,
        page: pageNum,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      }
    });
  } catch (err) {
    console.error('[告警列表] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取告警列表失败' });
  }
});

// GET /api/alerts/unread-count - 获取未确认告警数量
router.get('/unread-count', authMiddleware, async (req, res) => {
  try {
    const count = await Alert.countDocuments({ acknowledged: false });
    res.json({ success: true, data: { count } });
  } catch (err) {
    console.error('[未读告警] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取未读告警数失败' });
  }
});

// PUT /api/alerts/:alertId/acknowledge - 确认告警
router.put('/:alertId/acknowledge', authMiddleware, async (req, res) => {
  try {
    const alert = await Alert.findById(req.params.alertId);
    if (!alert) {
      return res.status(404).json({ success: false, message: '告警不存在' });
    }

    if (alert.acknowledged) {
      return res.status(400).json({ success: false, message: '告警已确认' });
    }

    alert.acknowledged = true;
    alert.acknowledgedBy = req.user.username;
    alert.acknowledgedAt = new Date();
    await alert.save();

    res.json({ success: true, data: alert.toObject() });
  } catch (err) {
    console.error('[确认告警] 错误:', err.message);
    res.status(500).json({ success: false, message: '确认告警失败' });
  }
});

module.exports = router;