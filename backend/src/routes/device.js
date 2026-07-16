const express = require('express');
const Device = require('../models/Device');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/devices - 获取设备列表
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { pondId, status } = req.query;
    const query = {};

    if (pondId) {
      query.pondId = pondId;
    }
    if (status) {
      query.status = status;
    }

    const devices = await Device.find(query).sort({ lastOnline: -1 }).lean();

    res.json({ success: true, data: devices });
  } catch (err) {
    console.error('[设备列表] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取设备列表失败' });
  }
});

// GET /api/devices/:deviceId - 获取设备详情
router.get('/:deviceId', authMiddleware, async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId }).lean();
    if (!device) {
      return res.status(404).json({ success: false, message: '设备不存在' });
    }

    res.json({ success: true, data: device });
  } catch (err) {
    console.error('[设备详情] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取设备详情失败' });
  }
});

// PUT /api/devices/:deviceId - 更新设备信息
router.put('/:deviceId', authMiddleware, async (req, res) => {
  try {
    const { pondId, firmwareVersion, ipAddress } = req.body;
    const updateFields = {};

    if (pondId !== undefined) updateFields.pondId = pondId;
    if (firmwareVersion !== undefined) updateFields.firmwareVersion = firmwareVersion;
    if (ipAddress !== undefined) updateFields.ipAddress = ipAddress;

    const device = await Device.findOneAndUpdate(
      { deviceId: req.params.deviceId },
      { $set: updateFields },
      { new: true }
    ).lean();

    if (!device) {
      return res.status(404).json({ success: false, message: '设备不存在' });
    }

    res.json({ success: true, data: device });
  } catch (err) {
    console.error('[更新设备] 错误:', err.message);
    res.status(500).json({ success: false, message: '更新设备失败' });
  }
});

module.exports = router;