const express = require('express');
const SensorData = require('../models/SensorData');
const Pond = require('../models/Pond');
const { authMiddleware } = require('../middleware/auth');
const { getPondRealtime } = require('../services/redisClient');

const router = express.Router();

// 把 Pond 模型中的控制状态字段合并到返回数据中
// 解决"假启动"问题：实时数据必须携带 commandPending/lastCommand*，前端据此判断显示
function buildRealtimePayload(pondId, sensorData) {
  const payload = sensorData ? { ...sensorData } : {};
  return Pond.findOne({ pondId })
    .select(
      'aeratorStatus aeratorMode commandPending commandPendingExpiresAt lastCommand lastCommandId lastCommandTime lastCommandAckAt lastCommandFailReason lastCommandNoAck aeratorStatusFault deviceFirmwareVersion'
    )
    .lean()
    .then((pond) => {
      if (pond) {
        payload.aeratorStatus = pond.aeratorStatus;
        payload.aeratorMode = pond.aeratorMode;
        payload.commandPending = !!pond.commandPending;
        payload.commandPendingExpiresAt = pond.commandPendingExpiresAt || null;
        payload.lastCommand = pond.lastCommand || '';
        payload.lastCommandId = pond.lastCommandId || '';
        payload.lastCommandTime = pond.lastCommandTime || null;
        payload.lastCommandAckAt = pond.lastCommandAckAt || null;
        payload.lastCommandFailReason = pond.lastCommandFailReason || '';
        payload.lastCommandNoAck = !!pond.lastCommandNoAck;
        payload.aeratorStatusFault = !!pond.aeratorStatusFault;
        payload.deviceFirmwareVersion = pond.deviceFirmwareVersion || '';
      }
      return payload;
    });
}

// GET /api/data/:pondId/realtime - 获取塘口实时数据
router.get('/:pondId/realtime', authMiddleware, async (req, res) => {
  try {
    const cached = await getPondRealtime(req.params.pondId);
    let sensorData = null;
    if (cached) {
      sensorData = cached;
    } else {
      // 如果 Redis 中没有，尝试从 MongoDB 取最新一条
      const latest = await SensorData.findOne({ pondId: req.params.pondId })
        .sort({ timestamp: -1 })
        .lean();
      if (latest) {
        sensorData = {
          temperature: latest.temperature,
          ph: latest.ph,
          dissolvedOxygen: latest.dissolvedOxygen,
          timestamp: latest.timestamp,
          deviceId: latest.deviceId
        };
      }
    }

    const payload = await buildRealtimePayload(req.params.pondId, sensorData);
    res.json({ success: true, data: payload });
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