const SensorData = require('../models/SensorData');
const Device = require('../models/Device');
const Pond = require('../models/Pond');
const { setPondRealtime, setDeviceLastSeen } = require('./redisClient');
const { broadcastRealtimeData } = require('./websocket');

// 安全解析传感器数值：缺失或非法时返回 null（绝不默认填 0，否则会触发阈值误告警）
function parseSensorValue(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

// 处理传感器数据
async function processSensorData(data) {
  try {
    const { pondId, deviceId, temperature, ph, dissolvedOxygen, timestamp } = data;

    if (!pondId) {
      console.error('[数据处理] 缺少 pondId，跳过');
      return;
    }

    // 解析各字段，缺失则保持 null
    const temperatureValue = parseSensorValue(temperature);
    const phValue = parseSensorValue(ph);
    const dissolvedOxygenValue = parseSensorValue(dissolvedOxygen);

    // 校验：若核心字段（pH、溶氧）全部缺失，则视为无效数据包，仅更新设备在线状态、不入库、不告警
    const missingFields = [];
    if (phValue === null) missingFields.push('pH');
    if (dissolvedOxygenValue === null) missingFields.push('溶氧');
    if (temperatureValue === null) missingFields.push('温度');

    if (missingFields.length === 3) {
      console.warn(`[数据处理] ${pondId} 数据包全部字段缺失（设备可能故障），已丢弃。来源 deviceId=${deviceId || '未知'}`);
      if (deviceId) {
        const Device = require('../models/Device');
        await Device.findOneAndUpdate(
          { deviceId },
          { $set: { lastOnline: new Date(), pondId } }
        );
        const { setDeviceLastSeen } = require('./redisClient');
        await setDeviceLastSeen(deviceId);
      }
      return;
    }

    if (missingFields.length > 0) {
      console.warn(`[数据处理] ${pondId} 数据包字段缺失: ${missingFields.join('、')}，将跳过对应字段的告警判断`);
    }

    // 1. 存储到 MongoDB
    const sensorData = new SensorData({
      pondId,
      deviceId: deviceId || '',
      temperature: temperatureValue,
      ph: phValue,
      dissolvedOxygen: dissolvedOxygenValue,
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