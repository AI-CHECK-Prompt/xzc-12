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
    const { pondId, deviceId, temperature, ph, dissolvedOxygen, timestamp, aeratorStatus } = data;

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
      // 先查设备当前的 pondId，若与上报 pondId 不一致说明"设备切塘口"（典型场景：临时调试、备用顶替）
      // 需要保留旧塘口关联：检测旧塘口是否还有其他在线设备，没有则把旧塘口置为 offline
      // 避免"原塘口数据流被静默切断但状态仍 online"导致前端误判
      const DeviceModel = require('../models/Device');
      const previousDevice = await DeviceModel.findOne({ deviceId });
      const previousPondId = previousDevice?.pondId;

      const device = await DeviceModel.findOneAndUpdate(
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

      // 【多终端修复】设备切塘口：旧塘口若无其他在线设备，纠正为 offline
      if (previousPondId && previousPondId !== pondId) {
        const PondModel = require('../models/Pond');
        const otherOnlineForOldPond = await DeviceModel.countDocuments({
          pondId: previousPondId,
          status: 'online',
          deviceId: { $ne: deviceId }
        });
        if (otherOnlineForOldPond === 0) {
          await PondModel.findOneAndUpdate(
            { pondId: previousPondId },
            { $set: { status: 'offline' } }
          );
          console.warn(`[数据处理] 设备 ${deviceId} 从 ${previousPondId} 切到 ${pondId}，旧塘口无其他在线设备，已置为 offline`);
        } else {
          console.log(`[数据处理] 设备 ${deviceId} 从 ${previousPondId} 切到 ${pondId}，旧塘口仍有 ${otherOnlineForOldPond} 台在线设备，保持 online`);
        }
      }
    }

    // 4. 更新塘口状态
    await Pond.findOneAndUpdate(
      { pondId },
      { $set: { status: 'online' } }
    );

    // 4.1 同步 aeratorStatus：data payload 现在携带该字段
    // 仅在不一致时写 DB，避免每次 5 分钟上报都触发更新
    // 不清 commandPending：保留命令回执的状态机完整性
    if (typeof aeratorStatus === 'boolean') {
      const cur = await Pond.findOne({ pondId });
      if (cur && cur.aeratorStatus !== aeratorStatus) {
        await Pond.findOneAndUpdate(
          { pondId },
          { $set: { aeratorStatus } }
        );
        console.log(`[数据处理] ${pondId} data 同步 aeratorStatus: ${cur.aeratorStatus} -> ${aeratorStatus}`);
      }
    }

    // 5. 调用告警引擎检查阈值
    // 修复：把设备真实检测时间（sensorData.timestamp）透传到告警引擎，
    // 避免告警入库时间比设备检测时间晚 3-5 秒，导致运维人员现场处理时间早于平台告警时间
    const alertEngine = require('./alertEngine');
    await alertEngine.checkThresholds({
      pondId,
      temperature: sensorData.temperature,
      ph: sensorData.ph,
      dissolvedOxygen: sensorData.dissolvedOxygen,
      detectedAt: sensorData.timestamp
    });

    // 6. 通过 WebSocket 广播实时数据
    broadcastRealtimeData(pondId, realtimeData);

    console.log(`[数据处理] ${pondId}: 温度=${sensorData.temperature}°C, pH=${sensorData.ph}, 溶氧=${sensorData.dissolvedOxygen}mg/L`);
  } catch (err) {
    console.error('[数据处理] 处理传感器数据失败:', err.message);
  }
}

module.exports = { processSensorData };