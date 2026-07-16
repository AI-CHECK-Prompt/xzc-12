const express = require('express');
const Pond = require('../models/Pond');
const { authMiddleware } = require('../middleware/auth');
const { getPondRealtime, getAllPondsRealtime } = require('../services/redisClient');

const router = express.Router();

// GET /api/ponds - 获取所有塘口列表（含实时状态）
router.get('/', authMiddleware, async (req, res) => {
  try {
    const ponds = await Pond.find().sort({ createTime: -1 });

    // 获取实时数据
    const realtimeData = await getAllPondsRealtime();
    const realtimeMap = {};
    realtimeData.forEach((item) => {
      realtimeMap[item.pondId] = item;
    });

    const result = ponds.map((pond) => {
      const obj = pond.toObject();
      obj.realtime = realtimeMap[pond.pondId] || null;
      return obj;
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[塘口列表] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取塘口列表失败' });
  }
});

// GET /api/ponds/:pondId - 获取单个塘口详情
router.get('/:pondId', authMiddleware, async (req, res) => {
  try {
    const pond = await Pond.findOne({ pondId: req.params.pondId });
    if (!pond) {
      return res.status(404).json({ success: false, message: '塘口不存在' });
    }

    const realtime = await getPondRealtime(req.params.pondId);
    const result = pond.toObject();
    result.realtime = realtime;

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[塘口详情] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取塘口详情失败' });
  }
});

// POST /api/ponds - 创建塘口
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { pondId, name, area, species, deviceId } = req.body;

    if (!pondId || !name || !area) {
      return res.status(400).json({ success: false, message: '塘口编号、名称和面积为必填项' });
    }

    const existing = await Pond.findOne({ pondId });
    if (existing) {
      return res.status(400).json({ success: false, message: '塘口编号已存在' });
    }

    const pond = new Pond({
      pondId,
      name,
      area,
      species: species || '',
      deviceId: deviceId || '',
      status: 'offline'
    });

    await pond.save();

    res.json({ success: true, data: pond.toObject() });
  } catch (err) {
    console.error('[创建塘口] 错误:', err.message);
    res.status(500).json({ success: false, message: '创建塘口失败' });
  }
});

// PUT /api/ponds/:pondId - 更新塘口信息
router.put('/:pondId', authMiddleware, async (req, res) => {
  try {
    const { name, area, species, deviceId, aeratorMode } = req.body;

    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (area !== undefined) updateFields.area = area;
    if (species !== undefined) updateFields.species = species;
    if (deviceId !== undefined) updateFields.deviceId = deviceId;
    if (aeratorMode !== undefined) {
      if (!['auto', 'manual', 'off'].includes(aeratorMode)) {
        return res.status(400).json({ success: false, message: '无效的增氧机模式' });
      }
      updateFields.aeratorMode = aeratorMode;
    }

    const pond = await Pond.findOneAndUpdate(
      { pondId: req.params.pondId },
      { $set: updateFields },
      { new: true }
    );

    if (!pond) {
      return res.status(404).json({ success: false, message: '塘口不存在' });
    }

    res.json({ success: true, data: pond.toObject() });
  } catch (err) {
    console.error('[更新塘口] 错误:', err.message);
    res.status(500).json({ success: false, message: '更新塘口失败' });
  }
});

// DELETE /api/ponds/:pondId - 删除塘口
router.delete('/:pondId', authMiddleware, async (req, res) => {
  try {
    const pond = await Pond.findOneAndDelete({ pondId: req.params.pondId });
    if (!pond) {
      return res.status(404).json({ success: false, message: '塘口不存在' });
    }

    res.json({ success: true, message: '塘口已删除' });
  } catch (err) {
    console.error('[删除塘口] 错误:', err.message);
    res.status(500).json({ success: false, message: '删除塘口失败' });
  }
});

module.exports = router;