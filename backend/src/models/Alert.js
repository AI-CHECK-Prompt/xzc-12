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

alertSchema.index({ pondId: 1, createdAt: -1 });

module.exports = mongoose.model('Alert', alertSchema);