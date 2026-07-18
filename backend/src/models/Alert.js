const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  pondId: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['low_oxygen', 'high_ph', 'low_ph', 'high_temperature', 'device_offline'],
    required: true
  },
  level: {
    type: String,
    enum: ['warning', 'critical'],
    required: true
  },
  value: {
    type: Number,
    required: true
  },
  threshold: {
    type: Number,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  // 告警实际检测时间（来自设备 / 离线事件中的最后在线时刻）
  // 修复：此前只用 createdAt 表示告警时间，但 createdAt 是后端入库时刻，
  // 与设备检测时刻存在 3-5s 链路延迟，导致运维人员现场处理时间早于平台告警时间
  // 此字段用于前端展示"告警时间"，与 createdAt 分离
  detectedAt: {
    type: Date,
    required: false
  },
  acknowledged: {
    type: Boolean,
    default: false
  },
  acknowledgedBy: {
    type: String,
    default: ''
  },
  acknowledgedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// 列表按 detectedAt 倒序展示（缺失时回退到 createdAt）；(pondId, detectedAt) 联合索引便于塘口维度查询
alertSchema.index({ pondId: 1, detectedAt: -1 });
alertSchema.index({ detectedAt: -1 });

module.exports = mongoose.model('Alert', alertSchema);