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
  species: {
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