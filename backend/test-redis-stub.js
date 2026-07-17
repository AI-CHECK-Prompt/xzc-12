/**
 * 测试用 Redis stub：完全在内存中实现 setex/get/exists/keys/del/pipeline
 * 替换了 backend/src/services/redisClient.js
 */

const memory = {}; // { key: { value, expireAt } }
let initialized = false;

function maybeExpire(key) {
  const e = memory[key];
  if (e && e.expireAt && e.expireAt < Date.now()) {
    delete memory[key];
    return false;
  }
  return !!e;
}

function getRedis() {
  return {
    setex: async (key, ttl, value) => {
      memory[key] = { value: String(value), expireAt: Date.now() + ttl * 1000 };
      return 'OK';
    },
    get: async (key) => {
      if (!maybeExpire(key)) return null;
      return memory[key].value;
    },
    exists: async (key) => {
      return maybeExpire(key) ? 1 : 0;
    },
    keys: async (pattern) => {
      // 简单通配符：把 * 转成 .*
      const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return Object.keys(memory).filter((k) => re.test(k) && maybeExpire(k));
    },
    del: async (key) => {
      const existed = !!memory[key];
      delete memory[key];
      return existed ? 1 : 0;
    },
    pipeline: () => {
      const ops = [];
      const p = {
        setex: (key, ttl, value) => { ops.push(['setex', key, ttl, value]); return p; },
        get: (key) => { ops.push(['get', key]); return p; },
        del: (key) => { ops.push(['del', key]); return p; },
        exec: async () => {
          const out = [];
          for (const op of ops) {
            try {
              if (op[0] === 'setex') {
                memory[op[1]] = { value: String(op[3]), expireAt: Date.now() + op[2] * 1000 };
                out.push([null, 'OK']);
              } else if (op[0] === 'get') {
                out.push([null, maybeExpire(op[1]) ? memory[op[1]].value : null]);
              } else if (op[0] === 'del') {
                const existed = !!memory[op[1]];
                delete memory[op[1]];
                out.push([null, existed ? 1 : 0]);
              } else {
                out.push([new Error('unsupported op: ' + op[0]), null]);
              }
            } catch (e) {
              out.push([e, null]);
            }
          }
          return out;
        }
      };
      return p;
    }
  };
}

function initRedis() {
  initialized = true;
  return getRedis();
}

async function setPondRealtime(pondId, data) {
  const c = getRedis();
  await c.setex(`pond:${pondId}:realtime`, 600, JSON.stringify(data));
}
async function getPondRealtime(pondId) {
  const c = getRedis();
  const v = await c.get(`pond:${pondId}:realtime`);
  return v ? JSON.parse(v) : null;
}
async function getAllPondsRealtime() {
  const c = getRedis();
  const keys = await c.keys('pond:*:realtime');
  if (keys.length === 0) return [];
  const pipe = c.pipeline();
  keys.forEach((k) => pipe.get(k));
  const results = await pipe.exec();
  const data = [];
  results.forEach(([err, value], idx) => {
    if (!err && value) {
      const pondId = keys[idx].split(':')[1];
      data.push({ pondId, ...JSON.parse(value) });
    }
  });
  return data;
}
async function isAlertDuplicate(pondId, type) {
  const c = getRedis();
  return (await c.exists(`alert:${pondId}:${type}`)) === 1;
}
async function markAlertSent(pondId, type) {
  const c = getRedis();
  await c.setex(`alert:${pondId}:${type}`, 300, '1');
}
async function setDeviceLastSeen(deviceId) {
  const c = getRedis();
  await c.setex(`device:${deviceId}:last_seen`, 7 * 24 * 60 * 60, Date.now().toString());
}
async function getDeviceLastSeen(deviceId) {
  const c = getRedis();
  const v = await c.get(`device:${deviceId}:last_seen`);
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
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
