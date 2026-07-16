const Redis = require('ioredis');
const config = require('../config');

let redis = null;

function initRedis() {
  redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    maxRetriesPerRequest: 3
  });

  redis.on('connect', () => {
    console.log('[Redis] 连接成功');
  });

  redis.on('error', (err) => {
    console.error('[Redis] 连接错误:', err.message);
  });

  return redis;
}

function getRedis() {
  if (!redis) {
    throw new Error('Redis 未初始化，请先调用 initRedis()');
  }
  return redis;
}

// 设置塘口实时数据缓存
async function setPondRealtime(pondId, data) {
  const client = getRedis();
  const key = `pond:${pondId}:realtime`;
  await client.setex(key, 600, JSON.stringify(data));
}

// 获取塘口实时数据
async function getPondRealtime(pondId) {
  const client = getRedis();
  const key = `pond:${pondId}:realtime`;
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

// 获取所有塘口实时数据
async function getAllPondsRealtime() {
  const client = getRedis();
  const keys = await client.keys('pond:*:realtime');
  if (keys.length === 0) return [];

  const pipeline = client.pipeline();
  keys.forEach((key) => pipeline.get(key));
  const results = await pipeline.exec();

  const data = [];
  results.forEach(([err, value], index) => {
    if (!err && value) {
      const pondId = keys[index].split(':')[1];
      const parsed = JSON.parse(value);
      data.push({ pondId, ...parsed });
    }
  });
  return data;
}

// 告警去重：检查是否在去重窗口内
async function isAlertDuplicate(pondId, type) {
  const client = getRedis();
  const key = `alert:${pondId}:${type}`;
  const exists = await client.exists(key);
  return exists === 1;
}

// 标记告警已发送（设置去重缓存）
async function markAlertSent(pondId, type) {
  const client = getRedis();
  const key = `alert:${pondId}:${type}`;
  await client.setex(key, config.alertDedupSeconds, '1');
}

// 更新设备最后在线时间缓存
async function setDeviceLastSeen(deviceId) {
  const client = getRedis();
  const key = `device:${deviceId}:last_seen`;
  await client.setex(key, 1200, Date.now().toString());
}

// 获取设备最后在线时间
async function getDeviceLastSeen(deviceId) {
  const client = getRedis();
  const key = `device:${deviceId}:last_seen`;
  const timestamp = await client.get(key);
  return timestamp ? parseInt(timestamp, 10) : null;
}

module.exports = {
  initRedis,
  getRedis,
  setPondRealtime,
  getPondRealtime,
  getAllPondsRealtime,
  isAlertDuplicate,
  markAlertSent,
  setDeviceLastSeen,
  getDeviceLastSeen
};