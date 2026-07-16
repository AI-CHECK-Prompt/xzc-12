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
async function handleDeviceStatus(pondId, payload) {
  try {
    const Device = require('../models/Device');
    const Pond = require('../models/Pond');
    const { broadcastDeviceStatus } = require('./websocket');

    const { deviceId, status } = payload;

    if (deviceId) {
      await Device.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            status: status || 'online',
            lastOnline: new Date()
          }
        },
        { upsert: true }
      );
    }

    if (pondId) {
      await Pond.findOneAndUpdate(
        { pondId },
        { $set: { status: status || 'online' } }
      );
    }

    broadcastDeviceStatus(pondId, status || 'online');
  } catch (err) {
    console.error('[MQTT] 处理设备状态失败:', err.message);
  }
}

// 发布控制命令
function publishControl(pondId, command) {
  if (!client || !connected) {
    console.error('[MQTT] 无法发送控制命令：未连接');
    return false;
  }
  const topic = `pond/${pondId}/control`;
  const payload = JSON.stringify({
    command,
    timestamp: new Date().toISOString()
  });
  client.publish(topic, payload, { qos: 1 }, (err) => {
    if (err) {
      console.error('[MQTT] 发布控制命令失败:', err.message);
    } else {
      console.log(`[MQTT] 已发送控制命令: ${command} -> ${topic}`);
    }
  });
  return true;
}

function getClient() {
  return client;
}

function isConnected() {
  return connected;
}

module.exports = { initMqttClient, publishControl, getClient, isConnected };