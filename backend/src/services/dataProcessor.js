const SensorData = require('../models/SensorData');
const Device = require('../models/Device');
const Pond = require('../models/Pond');
const { setPondRealtime, setDeviceLastSeen } = require('./redisClient');
const { broadcastRealtimeData } = require('./websocket');

// 处理传感器数据
async function processSensorData(data) {
  try {
    const { pondId, deviceId, temperature, ph, dissolvedOxygen, timestamp } = data;

    if (!pondId) {
      console.error('[数据处理] 缺少 pondId，跳过');
      return;
    }

    // 1. 存储到 MongoDB
    const sensorData = new SensorData({
      pondId,
      deviceId: deviceId || '',
      temperature: parseFloat(temperature) || 0,
      ph: parseFloat(ph) || 0,
      dissolvedOxygen: parseFloat(dissolvedOxygen) || 0,
      timestamp: timestamp ? new Date(timestamp) : new Date()
    });
    await sensorData.save();

    // 2. 更新 Redis 实时状态缓存
    const realtimeData = {
      temperature: sensorData.temperature,
      ph: sensorData.ph,
      dissolvedOxygen: sensorData.dissolvedOxygen,
      timestamp: sensorData.timestamp,
      deviceId: sensorData.deviceId
    };
    await setPondRealtime(pondId, realtimeData);

    // 3. 更新设备在线状态
    if (deviceId) {
      const device = await Device.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            status: 'online',
            lastOnline: new Date(),
            pondId
          }
        },
        { upsert: true, new: true }
      );

      // 更新设备最后在线时间缓存
      await setDeviceLastSeen(deviceId);
    }

    // 4. 更新塘口状态
    await Pond.findOneAndUpdate(
      { pondId },
      { $set: { status: 'online' } }
    );

    // 5. 调用告警引擎检查阈值
    const alertEngine = require('./alertEngine');
    await alertEngine.checkThresholds({
      pondId,
      temperature: sensorData.temperature,
      ph: sensorData.ph,
      dissolvedOxygen: sensorData.dissolvedOxygen
    });

    // 6. 通过 WebSocket 广播实时数据
    broadcastRealtimeData(pondId, realtimeData);

    console.log(`[数据处理] ${pondId}: 温度=${sensorData.temperature}°C, pH=${sensorData.ph}, 溶氧=${sensorData.dissolvedOxygen}mg/L`);
  } catch (err) {
    console.error('[数据处理] 处理传感器数据失败:', err.message);
  }
}

module.exports = { processSensorData };