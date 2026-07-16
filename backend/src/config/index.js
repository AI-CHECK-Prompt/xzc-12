require('dotenv').config();

module.exports = {
  // 服务器端口
  port: process.env.PORT || 3000,

  // MongoDB 连接
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/water_quality',

  // Redis 连接
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || '',
    db: parseInt(process.env.REDIS_DB, 10) || 0
  },

  // MQTT Broker
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
    clientId: process.env.MQTT_CLIENT_ID || 'water_quality_server_' + Math.random().toString(16).slice(2, 10)
  },

  // JWT 密钥
  jwtSecret: process.env.JWT_SECRET || 'water_quality_monitor_jwt_secret_key_2024',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // 告警阈值配置
  thresholds: {
    dissolvedOxygen: {
      critical: 3.0,   // 低于 3mg/L 触发 critical 告警
      warning: 4.0     // 低于 4mg/L 触发 warning 告警
    },
    ph: {
      low: 6.5,        // 低于 6.5 触发 critical 告警
      high: 9.0        // 高于 9.0 触发 critical 告警
    },
    temperature: {
      high: 35.0       // 高于 35°C 触发 warning 告警
    }
  },

  // 告警去重时间（秒）
  alertDedupSeconds: 300,

  // 设备离线判定时间（分钟）
  deviceOfflineMinutes: 10,

  // 设备 last_seen 在 Redis 中的 TTL（秒）
  // 必须远大于 deviceOfflineMinutes，避免设备长时间离线后 Redis key 过期
  // 导致 getDeviceLastSeen 返回 null，进而误判离线时长
  // 默认 7 天，覆盖绝大多数"夜间断电/网络中断"场景
  deviceLastSeenTtlSeconds: 7 * 24 * 60 * 60
};