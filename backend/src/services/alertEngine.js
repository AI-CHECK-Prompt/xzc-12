const config = require('../config');
const Alert = require('../models/Alert');
const Pond = require('../models/Pond');
const { isAlertDuplicate, markAlertSent } = require('./redisClient');
const { broadcastAlert } = require('./websocket');
const { publishControl } = require('./mqttClient');
const { supportsControlAck, getCommandAckTimeoutMs } = require('../utils/firmware');

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
// 修复"假启动"：先发 MQTT 并等待 broker ack，仅在命令确实下发到 broker 时才将
// 状态置为 running；下发失败时只标记 pending 状态，DB 不显示为"已启动"
// 同时设置 commandPendingExpiresAt，老固件 5s/新固件 30s 后由 commandTimeoutChecker 兜底
async function triggerAerator(pondId) {
  try {
    // 先查塘口以读取固件版本，决定超时与是否标记无回执
    const pondDoc = await Pond.findOne({ pondId });
    const hasAck = supportsControlAck(pondDoc?.deviceFirmwareVersion);
    const ackTimeoutMs = getCommandAckTimeoutMs(pondDoc?.deviceFirmwareVersion);

    // 1) 先发 MQTT 命令，等待真实的 publish 结果
    const pubResult = await publishControl(pondId, 'aerator_on');

    if (pubResult.success) {
      // 命令已下发到 broker：标记为 pending 等待设备回执
      // 真正的 running 状态由设备 ack（handleControlAck）来确认
      // 老固件 5s 后由 commandTimeoutChecker 乐观更新
      const expiresAt = new Date(Date.now() + ackTimeoutMs);
      await Pond.findOneAndUpdate(
        { pondId },
        {
          $set: {
            commandPending: true,
            commandPendingExpiresAt: expiresAt,
            lastCommand: 'aerator_on',
            lastCommandId: pubResult.commandId,
            lastCommandTime: new Date(),
            lastCommandFailReason: '',
            // 暂不把 aeratorStatus 置 true，等设备 ack 成功后再置
            aeratorMode: 'auto',
            aeratorStatusFault: false,
            lastCommandNoAck: !hasAck
          }
        }
      );
      console.log(`[自动控制] ${pondId} 增氧机自动启动命令已下发（commandId=${pubResult.commandId}, hasAck=${hasAck}），等待设备回执或 ${ackTimeoutMs}ms 超时`);
    } else {
      // 下发失败：DB 不显示为已启动，但提示运维人员命令未确认
      // 仍设置短超时，避免 commandPending 一直停留
      const failDeadline = new Date(Date.now() + ackTimeoutMs);
      await Pond.findOneAndUpdate(
        { pondId },
        {
          $set: {
            commandPending: true,
            commandPendingExpiresAt: failDeadline,
            lastCommand: 'aerator_on',
            lastCommandId: pubResult.commandId || '',
            lastCommandTime: new Date(),
            lastCommandFailReason: pubResult.reason || 'unknown',
            aeratorStatus: false,
            aeratorMode: 'auto',
            lastCommandNoAck: !hasAck
          }
        }
      );
      console.error(`[自动控制] ${pondId} 增氧机自动启动命令下发失败：${pubResult.message}（reason=${pubResult.reason}）`);

      // 创建 critical 告警：命令未下发成功，存在缺氧风险
      const isDuplicate = await isAlertDuplicate(pondId, 'aerator_command_failed');
      if (!isDuplicate) {
        const alert = new Alert({
          pondId,
          type: 'aerator_command_failed',
          level: 'critical',
          value: 0,
          threshold: 0,
          message: `增氧机自动启动命令下发失败（${pubResult.reason}），请检查 MQTT/网络/设备，鱼虾存在缺氧风险`
        });
        await alert.save();
        await markAlertSent(pondId, 'aerator_command_failed');
        broadcastAlert(alert.toObject());
      }
    }
  } catch (err) {
    console.error('[自动控制] 触发增氧机失败:', err.message);
  }
}

// 定时检查设备离线
// 修复点：
// 1) Redis last_seen 缺失时回退到 MongoDB Device.lastOnline，避免"6 小时掉线但 key 过期"导致漏判
// 2) 离线时长按真实 lastSeen 计算（不是写死阈值），并在告警 message 中展示
// 3) 防御 lastSeen 在未来的场景（设备/服务端时钟漂移），按阈值兜底并打日志
async function checkDeviceOffline() {
  try {
    const Device = require('../models/Device');
    const Pond = require('../models/Pond');
    const { getDeviceLastSeen } = require('./redisClient');

    const now = Date.now();
    const threshold = now - config.deviceOfflineMinutes * 60 * 1000;

    const devices = await Device.find({ status: 'online' });
    for (const device of devices) {
      // 优先 Redis，缺失时回退到 MongoDB Device.lastOnline
      // 解决：设备长时间离线（> Redis TTL）后 key 过期，getDeviceLastSeen 返回 null
      let lastSeenMs = await getDeviceLastSeen(device.deviceId);
      if (lastSeenMs === null && device.lastOnline) {
        const mongoTs = new Date(device.lastOnline).getTime();
        if (Number.isFinite(mongoTs)) {
          lastSeenMs = mongoTs;
          console.log(`[离线检查] ${device.deviceId} Redis last_seen 已过期，回退到 MongoDB lastOnline=${new Date(mongoTs).toISOString()}`);
        }
      }

      if (lastSeenMs && lastSeenMs < threshold) {
        // 计算实际离线时长（毫秒 → 分钟，向下取整）
        const offlineMinutes = Math.floor((now - lastSeenMs) / 60000);
        // 防御：lastSeen 在未来（时钟漂移）会算出负值，按阈值兜底并打日志
        const safeOfflineMinutes = offlineMinutes > 0
          ? offlineMinutes
          : config.deviceOfflineMinutes;
        if (offlineMinutes <= 0) {
          console.warn(`[离线检查] ${device.deviceId} lastSeen 在未来（${new Date(lastSeenMs).toISOString()}），疑似时钟漂移，使用阈值 ${config.deviceOfflineMinutes} 分钟兜底`);
        }

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
            const lastSeenStr = new Date(lastSeenMs).toLocaleString('zh-CN', { hour12: false });
            const alert = new Alert({
              pondId: device.pondId,
              type: 'device_offline',
              level: 'critical',
              value: safeOfflineMinutes,
              threshold: config.deviceOfflineMinutes,
              message: `设备 ${device.deviceId} 已离线 ${safeOfflineMinutes} 分钟（最后在线：${lastSeenStr}）`
            });
            await alert.save();
            await markAlertSent(device.pondId, 'device_offline');
            broadcastAlert(alert.toObject());
            console.log(`[告警] 设备离线: ${device.deviceId} (${device.pondId}) 离线 ${safeOfflineMinutes} 分钟，最后在线 ${lastSeenStr}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[离线检查] 故障:', err.message);
  }
}

module.exports = { checkThresholds, triggerAerator, checkDeviceOffline };