const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    unique: true,
    required: true
  },
  pondId: {
    type: String,
    default: ''
  },
  firmwareVersion: {
    type: String,
    default: ''
  },
  lastOnline: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['online', 'offline'],
    default: 'offline'
  },
  ipAddress: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Device', deviceSchema);