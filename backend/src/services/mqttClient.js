const mqtt = require('mqtt');
const config = require('../config');

let client = null;
let connected = false;

function initMqttClient() {
  return new Promise((resolve, reject) => {
    const options = {
      clientId: config.mqtt.clientId,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000
    };

    if (config.mqtt.username) {
      options.username = config.mqtt.username;
    }
    if (config.mqtt.password) {
      options.password = config.mqtt.password;
    }

    client = mqtt.connect(config.mqtt.brokerUrl, options);

    client.on('connect', () => {
      console.log('[MQTT] 已连接到 Broker:', config.mqtt.brokerUrl);
      connected = true;

      // 订阅传感器数据 topic
      client.subscribe('pond/+/data', { qos: 1 }, (err) => {
        if (err) {
          console.error('[MQTT] 订阅 pond/+/data 失败:', err.message);
        } else {
          console.log('[MQTT] 已订阅 pond/+/data');
        }
      });

      // 订阅设备状态 topic
      client.subscribe('pond/+/status', { qos: 1 }, (err) => {
        if (err) {
          console.error('[MQTT] 订阅 pond/+/status 失败:', err.message);
        } else {
          console.log('[MQTT] 已订阅 pond/+/status');
        }
      });

      // 订阅控制回执 topic：设备执行控制命令后的 ack
      client.subscribe('pond/+/control/ack', { qos: 1 }, (err) => {
        if (err) {
          console.error('[MQTT] 订阅 pond/+/control/ack 失败:', err.message);
        } else {
          console.log('[MQTT] 已订阅 pond/+/control/ack');
        }
      });

      resolve(client);
    });

    client.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        // 提取 topic 中的 pondId
        const topicParts = topic.split('/');
        const pondId = topicParts[1];

        if (topic.endsWith('/data')) {
          // 传感器数据
          const dataProcessor = require('./dataProcessor');
          dataProcessor.processSensorData({
            ...payload,
            pondId: payload.pondId || pondId
          });
        } else if (topic.endsWith('/status')) {
          // 设备状态
          handleDeviceStatus(pondId, payload);
        } else if (topic.endsWith('/control/ack')) {
          // 控制回执
          handleControlAck(pondId, payload);
        }
      } catch (err) {
        console.error('[MQTT] 消息解析失败:', err.message, 'topic:', topic);
      }
    });

    client.on('error', (err) => {
      console.error('[MQTT] 连接错误:', err.message);
    });

    client.on('reconnect', () => {
      console.log('[MQTT] 正在重连...');
    });

    client.on('close', () => {
      console.log('[MQTT] 连接已关闭');
      connected = false;
    });

    client.on('offline', () => {
      console.log('[MQTT] 离线');
      connected = false;
    });

    // 连接超时
    setTimeout(() => {
      if (!connected) {
        console.warn('[MQTT] 连接超时，将以离线模式运行');
        resolve(null);
      }
    }, 10000);
  });
}

// 处理设备状态消息
// 修复点：
// 1) /status 主题消息必须同步更新 Redis last_seen，否则后续离线检查会数据不一致
// 2) 设备从 offline 重连回 online 时，先按"上次 lastOnline"生成补发离线告警（真实时长），
//    再刷新 lastOnline，避免"6 小时掉线后短暂恢复"把离线事件吞掉、运维收不到告警
async function handleDeviceStatus(pondId, payload) {
  try {
    const Device = require('../models/Device');
    const Pond = require('../models/Pond');
    const { setDeviceLastSeen, isAlertDuplicate, markAlertSent } = require('./redisClient');
    const { broadcastDeviceStatus, broadcastAlert } = require('./websocket');
    const Alert = require('../models/Alert');
    const config = require('../config');

    const { deviceId, status } = payload;
    const newStatus = status || 'online';

    if (deviceId) {
      const existingDevice = await Device.findOne({ deviceId });
      const wasOffline = existingDevice && existingDevice.status === 'offline';
      const previousLastOnline = existingDevice?.lastOnline;

      // 设备从 offline 重连回 online：先按上次 lastOnline 补发真实离线告警
      // 防止 checkDeviceOffline 漏检（设备长时间离线后 checkDeviceOffline 可能因为各种原因没生成告警）
      if (wasOffline && newStatus === 'online' && previousLastOnline) {
        const lastSeenMs = new Date(previousLastOnline).getTime();
        if (Number.isFinite(lastSeenMs)) {
          const now = Date.now();
          const offlineMinutes = Math.floor((now - lastSeenMs) / 60000);
          const safeOfflineMinutes = offlineMinutes > 0
            ? offlineMinutes
            : config.deviceOfflineMinutes;
          if (offlineMinutes <= 0) {
            console.warn(`[MQTT-状态] ${deviceId} 历史 lastOnline 异常（${previousLastOnline}），疑似时钟漂移，使用阈值 ${config.deviceOfflineMinutes} 分钟兜底`);
          }
          // 只在确实超过阈值时补告警
          if (offlineMinutes >= config.deviceOfflineMinutes) {
            const targetPondId = pondId || existingDevice.pondId;
            if (targetPondId) {
              const isDuplicate = await isAlertDuplicate(targetPondId, 'device_offline');
              if (!isDuplicate) {
                const lastSeenStr = new Date(lastSeenMs).toLocaleString('zh-CN', { hour12: false });
                const alert = new Alert({
                  pondId: targetPondId,
                  type: 'device_offline',
                  level: 'critical',
                  value: safeOfflineMinutes,
                  threshold: config.deviceOfflineMinutes,
                  message: `设备 ${deviceId} 已离线 ${safeOfflineMinutes} 分钟（最后在线：${lastSeenStr}）`
                });
                await alert.save();
                await markAlertSent(targetPondId, 'device_offline');
                broadcastAlert(alert.toObject());
                console.log(`[MQTT-状态] 补发离线告警: ${deviceId} (${targetPondId}) 离线 ${safeOfflineMinutes} 分钟，最后在线 ${lastSeenStr}`);
              }
            }
          }
        }
      }

      const updateFields = { status: newStatus };
      if (newStatus === 'online') {
        // 重连时刷新 lastOnline 为"现在"
        updateFields.lastOnline = new Date();
      }
      // 终端上报的固件版本同步到 Device + Pond（能力判定依赖此字段）
      if (payload.firmwareVersion) {
        updateFields.firmwareVersion = payload.firmwareVersion;
      }

      await Device.findOneAndUpdate(
        { deviceId },
        { $set: updateFields },
        { upsert: true }
      );

      // 同步 Redis 缓存，保证 /status 消息也会刷新 last_seen（之前只 dataProcessor 刷新）
      if (newStatus === 'online') {
        await setDeviceLastSeen(deviceId);
      }
    }

    if (pondId) {
      // 同步固件版本到 Pond，用于控制接口判定是否支持回执
      const pondUpdate = { status: newStatus };
      if (payload.firmwareVersion) {
        pondUpdate.deviceFirmwareVersion = payload.firmwareVersion;
      }
      await Pond.findOneAndUpdate(
        { pondId },
        { $set: pondUpdate }
      );
    }

    broadcastDeviceStatus(pondId, newStatus);
  } catch (err) {
    console.error('[MQTT] 处理设备状态失败:', err.message);
  }
}

// 发布控制命令（返回 Promise，准确反映 broker ack 结果）
function publishControl(pondId, command, options = {}) {
  const { commandId, timeoutMs = 5000 } = options;
  return new Promise((resolve) => {
    if (!client || !connected) {
      console.error(`[MQTT] 无法发送控制命令：未连接，pondId=${pondId}, command=${command}`);
      return resolve({
        success: false,
        reason: 'mqtt_disconnected',
        message: 'MQTT 未连接，命令未下发'
      });
    }

    const topic = `pond/${pondId}/control`;
    const cid = commandId || `${pondId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const payload = JSON.stringify({
      command,
      commandId: cid,
      timestamp: new Date().toISOString()
    });

    let settled = false;
    // 超时保护：若 broker 长时间不 ack，按失败处理
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[MQTT] 发布控制命令超时（${timeoutMs}ms），pondId=${pondId}, command=${command}`);
      resolve({
        success: false,
        commandId: cid,
        reason: 'publish_timeout',
        message: 'MQTT 发布超时，未收到 broker 确认'
      });
    }, timeoutMs);

    try {
      client.publish(topic, payload, { qos: 1 }, (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          console.error(`[MQTT] 发布控制命令失败: ${err.message}, pondId=${pondId}, command=${command}`);
          return resolve({
            success: false,
            commandId: cid,
            reason: 'publish_error',
            message: `MQTT 发布失败: ${err.message}`
          });
        }
        console.log(`[MQTT] 已发送控制命令: ${command} -> ${topic} (commandId=${cid})`);
        resolve({
          success: true,
          commandId: cid,
          reason: 'published',
          message: '命令已成功下发到 broker'
        });
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[MQTT] 发布抛出异常: ${e.message}, pondId=${pondId}, command=${command}`);
      resolve({
        success: false,
        commandId: cid,
        reason: 'publish_exception',
        message: `MQTT 发布异常: ${e.message}`
      });
    }
  });
}

// 处理设备对控制命令的回执（ack）：清掉 pending 状态
async function handleControlAck(pondId, payload) {
  try {
    const { commandId, command, result, error } = payload || {};
    if (!pondId || !commandId) return;

    const Pond = require('../models/Pond');
    const pond = await Pond.findOne({ pondId });
    if (!pond) return;

    // 只在 pending 与当前 commandId 匹配时清除，避免乱序覆盖
    if (pond.commandPending && pond.lastCommandId === commandId) {
      const success = result === 'ok' || result === 'success' || result === true;
      const update = {
        $set: {
          commandPending: false,
          commandPendingExpiresAt: null,
          lastCommandAckAt: new Date(),
          // 收到明确回执后，老固件无回执标记也清掉
          lastCommandNoAck: false
        }
      };
      if (success) {
        // 硬件确认执行成功：以硬件回执为准设置最终状态
        if (command === 'aerator_on') {
          update.$set.aeratorStatus = true;
          update.$set.aeratorMode = 'auto';
        } else if (command === 'aerator_off') {
          update.$set.aeratorStatus = false;
        }
      } else {
        // 硬件回执失败：还原 DB 状态，并标记 fault
        if (command === 'aerator_on') {
          update.$set.aeratorStatus = false;
          update.$set.aeratorStatusFault = true;
        }
      }
      await Pond.findOneAndUpdate({ pondId }, update);

      const { broadcastDeviceStatus } = require('./websocket');
      broadcastDeviceStatus(pondId, success ? 'control_ack_ok' : 'control_ack_fail');

      console.log(`[MQTT] 设备回执 ${commandId} (${command}) -> ${success ? 'OK' : 'FAIL'}${error ? ', err=' + error : ''}`);
    } else {
      console.log(`[MQTT] 收到过期的设备回执 ${commandId}，忽略（当前 pending=${pond?.commandPending}, lastCommandId=${pond?.lastCommandId}）`);
    }
  } catch (err) {
    console.error('[MQTT] 处理控制回执失败:', err.message);
  }
}

function getClient() {
  return client;
}

function isConnected() {
  return connected;
}

module.exports = { initMqttClient, publishControl, handleControlAck, getClient, isConnected };
