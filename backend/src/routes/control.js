const express = require('express');
const Pond = require('../models/Pond');
const { authMiddleware, requireOperator } = require('../middleware/auth');
const { publishControl } = require('../services/mqttClient');

const router = express.Router();

// POST /api/control/:pondId/aerator - 远程控制增氧机
router.post('/:pondId/aerator', authMiddleware, requireOperator, async (req, res) => {
  try {
    const { action } = req.body;

    if (!action || !['on', 'off'].includes(action)) {
      return res.status(400).json({ success: false, message: '无效的操作，请使用 on 或 off' });
    }

    const pond = await Pond.findOne({ pondId: req.params.pondId });
    if (!pond) {
      return res.status(404).json({ success: false, message: '塘口不存在' });
    }

    const command = action === 'on' ? 'aerator_on' : 'aerator_off';
    const success = publishControl(req.params.pondId, command);

    // 更新增氧机状态
    pond.aeratorStatus = action === 'on';
    pond.aeratorMode = 'manual';
    await pond.save();

    res.json({
      success: true,
      data: {
        pondId: req.params.pondId,
        aeratorStatus: pond.aeratorStatus,
        command,
        mqttSent: success
      },
      message: `增氧机已${action === 'on' ? '启动' : '关闭'}`
    });
  } catch (err) {
    console.error('[控制增氧机] 错误:', err.message);
    res.status(500).json({ success: false, message: '控制增氧机失败' });
  }
});

module.exports = router;