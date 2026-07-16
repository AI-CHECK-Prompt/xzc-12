const config = require('../config');
const Alert = require('../models/Alert');
const Pond = require('../models/Pond');
const { isAlertDuplicate, markAlertSent } = require('./redisClient');
const { broadcastAlert } = require('./websocket');
const { publishControl } = require('./mqttClient');

// 检查传感器数据是否触发告警
async function checkThresholds(data) {
  const { pondId, temperature, ph, dissolvedOxygen } = data;
  const thresholds = config.thresholds;

  // 检查溶氧
  if (dissolvedOxygen !== undefined && dissolvedOxygen !== null) {
    if (dissolvedOxygen < thresholds.dissolvedOxygen.critical) {
      await createAlert(pondId, 'low_oxygen', 'critical', dissolvedOxygen,
        thresholds.dissolvedOxygen.critical, '溶氧过低，增氧机已自动启动');
      await triggerAerator(pondId);
    } else if (dissolvedOxygen < thresholds.dissolvedOxygen.warning) {
      await createAlert(pondId, 'low_oxygen', 'warning', dissolvedOxygen,
        thresholds.dissolvedOxygen.warning, '溶氧偏低，请关注');
    }
  }

  // 检查 pH
  if (ph !== undefined && ph !== null) {
    if (ph < thresholds.ph.low) {
      await createAlert(pondId, 'low_ph', 'critical', ph,
        thresholds.ph.low, 'pH值过低，请立即处理');
    } else if (ph > thresholds.ph.high) {
      await createAlert(pondId, 'high_ph', 'critical', ph,
        thresholds.ph.high, 'pH值过高，请立即处理');
    }
  }

  // 检查水温
  if (temperature !== undefined && temperature !== null) {
    if (temperature > thresholds.temperature.high) {
      await createAlert(pondId, 'high_temperature', 'warning', temperature,
        thresholds.temperature.high, '水温过高，请关注');
    }
  }
}

// 创建告警（带去重）
async function createAlert(pondId, type, level, value, threshold, message) {
  try {
    // 检查是否在去重窗口内
    const isDuplicate = await isAlertDuplicate(pondId, type);
    if (isDuplicate) {
      return null;
    }

    const alert = new Alert({
      pondId,
      type,
      level,
      value,
      threshold,
      message
    });

    await alert.save();

    // 标记已发送，设置去重
    await markAlertSent(pondId, type);

    // 通过 WebSocket 推送告警
    broadcastAlert(alert.toObject());

    console.log(`[告警] ${pondId} - ${type}(${level}): ${message} (值: ${value})`);
    return alert;
  } catch (err) {
    console.error('[告警] 创建告警失败:', err.message);
    return null;
  }
}

// 溶氧过低时自动发 MQTT 命令启动增氧机
async function triggerAerator(pondId) {
  try {
    // 更新数据库中的增氧机状态
    await Pond.findOneAndUpdate(
      { pondId },
      {
        $set: {
          aeratorStatus: true,
          aeratorMode: 'auto'
        }
      }
    );

    // 发布 MQTT 控制命令
    const success = publishControl(pondId, 'aerator_on');
    if (success) {
      console.log(`[自动控制] ${pondId} 增氧机已自动启动（溶氧过低）`);
    } else {
      console.log(`[自动控制] ${pondId} 增氧机自动启动命令已记录（MQTT未连接）`);
    }
  } catch (err) {
    console.error('[自动控制] 触发增氧机失败:', err.message);
  }
}

// 定时检查设备离线
async function checkDeviceOffline() {
  try {
    const Device = require('../models/Device');
    const Pond = require('../models/Pond');
    const { getDeviceLastSeen } = require('./redisClient');

    const threshold = Date.now() - config.deviceOfflineMinutes * 60 * 1000;

    const devices = await Device.find({ status: 'online' });
    for (const device of devices) {
      const lastSeen = await getDeviceLastSeen(device.deviceId);
      if (lastSeen && lastSeen < threshold) {
        // 设备离线
        await Device.findOneAndUpdate(
          { deviceId: device.deviceId },
          { $set: { status: 'offline' } }
        );

        if (device.pondId) {
          await Pond.findOneAndUpdate(
            { pondId: device.pondId },
            { $set: { status: 'offline' } }
          );

          // 检查去重后创建告警
          const isDuplicate = await isAlertDuplicate(device.pondId, 'device_offline');
          if (!isDuplicate) {
            const alert = new Alert({
              pondId: device.pondId,
              type: 'device_offline',
              level: 'critical',
              value: 0,
              threshold: 0,
              message: `设备 ${device.deviceId} 已离线超过${config.deviceOfflineMinutes}分钟`
            });
            await alert.save();
            await markAlertSent(device.pondId, 'device_offline');
            broadcastAlert(alert.toObject());
            console.log(`[告警] 设备离线: ${device.deviceId} (${device.pondId})`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[离线检查] 故障:', err.message);
  }
}

module.exports = { checkThresholds, triggerAerator, checkDeviceOffline };