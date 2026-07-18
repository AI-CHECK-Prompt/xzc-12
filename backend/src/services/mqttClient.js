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

      // 订阅增氧机被动状态事件 topic
      // 场景：固件巡检发现 GPIO 实际电平与内部目标值不一致时主动发布
      // 用于解决"现场人工拉闸后前端一直显示旧值"问题
      client.subscribe('pond/+/event/aerator_state', { qos: 1 }, (err) => {
        if (err) {
          console.error('[MQTT] 订阅 pond/+/event/aerator_state 失败:', err.message);
        } else {
          console.log('[MQTT] 已订阅 pond/+/event/aerator_state');
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
        } else if (topic.endsWith('/event/aerator_state')) {
          // 增氧机被动状态事件
          handleAeratorStateEvent(pondId, payload);
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
                  message: `设备 ${deviceId} 已离线 ${safeOfflineMinutes} 分钟（最后在线：${lastSeenStr}）`,
                  // 修复：告警时间应为设备真实离线时刻（lastSeen），
                  // 而非重连/入库时间（now），避免"运维人员发现时已晚于告警时间"
                  detectedAt: new Date(lastSeenMs)
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
      const pondUpdate = {};
      if (payload.firmwareVersion) {
        pondUpdate.deviceFirmwareVersion = payload.firmwareVersion;
      }

      // 【多终端修复】设备上报 status 时，塘口状态要综合考虑同塘口其他设备的在线情况：
      // - 任一设备上报 online → 塘口应为 online
      // - 仅当本设备上报 offline 且同塘口无其他 online 设备时，塘口才置为 offline
      // 避免"备用终端掉线上报 offline"把"主终端还在流数据"的塘口误标离线
      if (newStatus === 'online') {
        pondUpdate.status = 'online';
      } else if (newStatus === 'offline') {
        const DeviceModel = require('../models/Device');
        const otherOnlineCount = await DeviceModel.countDocuments({
          pondId,
          status: 'online',
          deviceId: { $ne: deviceId }
        });
        if (otherOnlineCount > 0) {
          console.log(`[MQTT-状态] ${deviceId} 上报 offline，但 ${pondId} 仍有 ${otherOnlineCount} 台在线设备，塘口保持 online`);
          // 不覆盖塘口状态
        } else {
          pondUpdate.status = 'offline';
        }
      }

      if (Object.keys(pondUpdate).length > 0) {
        await Pond.findOneAndUpdate(
          { pondId },
          { $set: pondUpdate }
        );
      }
    }

    broadcastDeviceStatus(pondId, newStatus);

    // 修复：status payload 现在携带 aeratorStatus 字段（固件读回 GPIO 实际电平）
    // 当设备主动上报的 aeratorStatus 与 DB 不一致时，同步到 Pond
    // 场景：现场人工拉闸后固件巡检会 publish 事件立即同步；
    //       status 报告（30s 一次）兜底，保证事件丢失时仍能在心跳周期内对齐
    //
    // 不清 pending：保留命令回执路径的状态机完整性。
    // pending 期间 status 报告的 aeratorStatus 不同步，让命令回执/超时兜底独占状态机；
    // 真正的"现场操作覆盖"由 handleAeratorStateEvent 主动事件负责（它会清 pending）。
    if (typeof payload.aeratorStatus === 'boolean' && pondId) {
      try {
        const PondModel = require('../models/Pond');
        const cur = await PondModel.findOne({ pondId });
        // pending 期间不同步 status 报告：让命令回执路径独占
        if (cur && !cur.commandPending && cur.aeratorStatus !== payload.aeratorStatus) {
          await PondModel.findOneAndUpdate(
            { pondId },
            { $set: { aeratorStatus: payload.aeratorStatus } }
          );
          console.log(`[MQTT-状态] ${pondId} 心跳同步 aeratorStatus: ${cur.aeratorStatus} -> ${payload.aeratorStatus}`);
        }
      } catch (e) {
        console.error('[MQTT-状态] 同步 aeratorStatus 失败:', e.message);
      }
    }
  } catch (err) {
    console.error('[MQTT] 处理设备状态失败:', err.message);
  }
}

// 处理增氧机被动状态事件
// 触发：固件巡检（loop 中）发现 digitalRead 与内部 aeratorStatus 不一致时主动发布
// 目的：把平台 Pond.aeratorStatus 同步到设备真实继电器输出电平
// 解决"现场人工拉闸 / 接触器异常 / 设备掉电重启"等场景下前端状态滞留
//
// race-condition 处理：
// - 如果当前 commandPending=true（刚刚下发命令但还没收到 ack），
//   被动事件说明现场已发生变化，应直接清掉 pending 并同步真实状态，
//   避免命令回执回来后覆盖真实状态。
// - 通过 lastCommandTime 限流：避免固件在 RELAY_COOLDOWN 期间重复 publish 风暴
async function handleAeratorStateEvent(pondId, payload) {
  try {
    const { deviceId, aeratorStatus, reason } = payload || {};
    if (!pondId) return;
    if (typeof aeratorStatus !== 'boolean') {
      console.warn(`[MQTT-增氧机事件] ${pondId} payload 缺少 aeratorStatus 字段，已忽略`);
      return;
    }

    const Pond = require('../models/Pond');
    const Alert = require('../models/Alert');
    const { isAlertDuplicate, markAlertSent } = require('./redisClient');
    const { broadcastDeviceStatus } = require('./websocket');

    const pond = await Pond.findOne({ pondId });
    if (!pond) {
      console.warn(`[MQTT-增氧机事件] 塘口不存在: ${pondId}`);
      return;
    }

    // 仅在状态真正变化时同步，避免每次 publish 都写 DB
    if (pond.aeratorStatus === aeratorStatus && !pond.commandPending) {
      console.log(`[MQTT-增氧机事件] ${pondId} aeratorStatus=${aeratorStatus} 与 DB 一致，跳过`);
      return;
    }

    const wasPending = !!pond.commandPending;
    const oldStatus = pond.aeratorStatus;
    const update = {
      $set: {
        aeratorStatus,
        // 被动事件说明真实状态已变，清掉 pending 与 fault，
        // 避免"命令待确认"的橙色提示长期停留
        commandPending: false,
        commandPendingExpiresAt: null,
        aeratorStatusFault: false
      }
    };

    await Pond.findOneAndUpdate({ pondId }, update);
    broadcastDeviceStatus(pondId, 'aerator_state_changed');

    console.log(
      `[MQTT-增氧机事件] ${pondId} aeratorStatus: ${oldStatus} -> ${aeratorStatus} ` +
      `(reason=${reason || 'unknown'}, pending=${wasPending}, deviceId=${deviceId || 'unknown'})`
    );

    // 如果此前在等待命令回执，现场操作覆盖了命令结果，记录 warning 告警（去重）
    if (wasPending) {
      const dup = await isAlertDuplicate(pondId, 'aerator_state_mismatch');
      if (!dup) {
        const alert = new Alert({
          pondId,
          type: 'aerator_state_mismatch',
          level: 'warning',
          value: aeratorStatus ? 1 : 0,
          threshold: 0,
          message: `塘口增氧机状态被现场操作改变：${oldStatus ? '运行中' : '已停止'} → ${aeratorStatus ? '运行中' : '已停止'}（reason=${reason || 'unknown'}）`,
          detectedAt: new Date()
        });
        await alert.save();
        await markAlertSent(pondId, 'aerator_state_mismatch');
        const { broadcastAlert } = require('./websocket');
        broadcastAlert(alert.toObject());
      }
    }
  } catch (err) {
    console.error('[MQTT] 处理增氧机状态事件失败:', err.message);
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
        // 修复模式覆盖 bug：设备回执只能确认动作执行结果，不能改变用户设置的增氧机模式。
        // 此前会把 manual 模式强行改为 auto，导致运维人员设置的模式丢失。
        if (command === 'aerator_on') {
          update.$set.aeratorStatus = true;
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

module.exports = {
  initMqttClient,
  publishControl,
  handleControlAck,
  handleDeviceStatus,
  handleAeratorStateEvent,
  getClient,
  isConnected
};
