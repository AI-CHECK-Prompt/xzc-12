const mongoose = require('mongoose');

const pondSchema = new mongoose.Schema({
  pondId: {
    type: String,
    unique: true,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  area: {
    type: Number,
    required: true
  },
  // 养殖品种：南美白对虾 / 淡水鱼 / 加州鲈 等
  species: {
    type: String,
    default: ''
  },
  // 所属片区：用于塘口横向对比的分组维度之一
  region: {
    type: String,
    default: ''
  },
  deviceId: {
    type: String,
    default: ''
  },
  aeratorStatus: {
    type: Boolean,
    default: false
  },

  // 命令下发相关：解决"假启动"问题
  commandPending: {
    type: Boolean,
    default: false
  },
  // 命令等待回执的截止时间（毫秒精度）。
  // - 老固件（无回执）：setInterval 到点后乐观更新 aeratorStatus
  // - 新固件（有回执）：超时未收到 ack 则标记 fault
  commandPendingExpiresAt: {
    type: Date,
    default: null
  },
  lastCommand: {
    type: String,
    default: ''
  },
  lastCommandId: {
    type: String,
    default: ''
  },
  lastCommandTime: {
    type: Date,
    default: null
  },
  lastCommandAckAt: {
    type: Date,
    default: null
  },
  lastCommandFailReason: {
    type: String,
    default: ''
  },
  // 标记"老固件无回执"：超时兜底已生效，前端可据此提示运维现场确认
  lastCommandNoAck: {
    type: Boolean,
    default: false
  },
  // 终端固件版本（从 Device.firmwareVersion 同步，用于能力判定）
  deviceFirmwareVersion: {
    type: String,
    default: ''
  },
  aeratorStatusFault: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ['online', 'offline'],
    default: 'offline'
  },
  createTime: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Pond', pondSchema);
