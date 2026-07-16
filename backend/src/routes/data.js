const express = require('express');
const SensorData = require('../models/SensorData');
const { authMiddleware } = require('../middleware/auth');
const { getPondRealtime } = require('../services/redisClient');

const router = express.Router();

// GET /api/data/:pondId/realtime - 获取塘口实时数据
router.get('/:pondId/realtime', authMiddleware, async (req, res) => {
  try {
    const data = await getPondRealtime(req.params.pondId);
    if (!data) {
      // 如果 Redis 中没有，尝试从 MongoDB 取最新一条
      const latest = await SensorData.findOne({ pondId: req.params.pondId })
        .sort({ timestamp: -1 })
        .lean();

      if (!latest) {
        return res.json({ success: true, data: null });
      }

      return res.json({
        success: true,
        data: {
          temperature: latest.temperature,
          ph: latest.ph,
          dissolvedOxygen: latest.dissolvedOxygen,
          timestamp: latest.timestamp,
          deviceId: latest.deviceId
        }
      });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('[实时数据] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取实时数据失败' });
  }
});

// GET /api/data/:pondId/history - 获取历史数据
router.get('/:pondId/history', authMiddleware, async (req, res) => {
  try {
    const { startTime, endTime, limit, page } = req.query;
    const pageSize = parseInt(limit, 10) || 1000;
    const pageNum = parseInt(page, 10) || 1;

    const query = { pondId: req.params.pondId };

    if (startTime || endTime) {
      query.timestamp = {};
      if (startTime) {
        query.timestamp.$gte = new Date(startTime);
      }
      if (endTime) {
        query.timestamp.$lte = new Date(endTime);
      }
    }

    const total = await SensorData.countDocuments(query);
    const data = await SensorData.find(query)
      .sort({ timestamp: -1 })
      .skip((pageNum - 1) * pageSize)
      .limit(pageSize)
      .lean();

    res.json({
      success: true,
      data: {
        list: data,
        total,
        page: pageNum,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      }
    });
  } catch (err) {
    console.error('[历史数据] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取历史数据失败' });
  }
});

// GET /api/data/:pondId/latest - 获取最新一条数据
router.get('/:pondId/latest', authMiddleware, async (req, res) => {
  try {
    const latest = await SensorData.findOne({ pondId: req.params.pondId })
      .sort({ timestamp: -1 })
      .lean();

    if (!latest) {
      return res.json({ success: true, data: null });
    }

    res.json({ success: true, data: latest });
  } catch (err) {
    console.error('[最新数据] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取最新数据失败' });
  }
});

module.exports = router;