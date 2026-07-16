const mongoose = require('mongoose');

const sensorDataSchema = new mongoose.Schema({
  pondId: {
    type: String,
    required: true,
    index: true
  },
  deviceId: {
    type: String,
    required: true
  },
  temperature: {
    type: Number,
    required: true
  },
  ph: {
    type: Number,
    required: true
  },
  dissolvedOxygen: {
    type: Number,
    required: true
  },
  timestamp: {
    type: Date,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

sensorDataSchema.index({ pondId: 1, timestamp: -1 });

module.exports = mongoose.model('SensorData', sensorDataSchema);