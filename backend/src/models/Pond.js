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
  aeratorMode: {
    type: String,
    enum: ['auto', 'manual', 'off'],
    default: 'auto'
  },
  // 命令下发相关：解决"假启动"问题
  commandPending: {
    type: Boolean,
    default: false
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
