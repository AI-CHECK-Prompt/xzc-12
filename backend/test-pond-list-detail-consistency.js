// 端到端 HTTP 验证：列表接口 /api/ponds 与详情接口 /api/ponds/:pondId
// 都从同一份 Redis 实时数据中拿数据，确保运维人员看到的两个数字一致。
//
// 关键点：
//  1) /api/ponds 返回的 pond.realtime 与 /api/ponds/:pondId 返回的 pond.realtime 是同一份
//  2) /api/data/:pondId/realtime 也从 Redis 拿同源数据（这是前端详情页的数据源）
//  3) 当前端用 pond.realtime 作为兜底，列表 / 详情一定能对齐

const http = require('http');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');

const fakePondStore = {};
class FakePond {
  constructor(doc) { Object.assign(this, doc); }
  toObject() { return { ...this }; }
  async save() { fakePondStore[this.pondId] = { ...this }; return this; }
}
FakePond.find = () => {
  // 返回 thenable 支持 .sort() 链式调用
  const thenable = Promise.resolve(Object.values(fakePondStore).map(p => new FakePond(p)));
  thenable.sort = function () { return this; };
  return thenable;
};
FakePond.findOne = (q) => {
  const item = fakePondStore[q.pondId];
  const thenable = Promise.resolve(item ? new FakePond({ ...item }) : null);
  thenable.select = function () { return this; };
  thenable.lean = function () { return this; };
  return thenable;
};
FakePond.findOneAndUpdate = async (q, update) => {
  const prev = fakePondStore[q.pondId] || { pondId: q.pondId, aeratorStatus: false, aeratorMode: 'auto' };
  const setOps = (update && update.$set) || {};
  const next = { ...prev, ...setOps };
  fakePondStore[q.pondId] = next;
  return new FakePond(next);
};

class FakeSensorData {
  constructor(doc) { Object.assign(this, doc); }
  async save() { return this; }
  toObject() { return { ...this }; }
}
FakeSensorData.findOne = () => {
  const thenable = Promise.resolve(null);
  thenable.sort = function () { return this; };
  thenable.lean = function () { return this; };
  return thenable;
};
FakeSensorData.find = () => {
  const thenable = Promise.resolve([]);
  thenable.sort = function () { return this; };
  thenable.skip = function () { return this; };
  thenable.limit = function () { return this; };
  thenable.lean = function () { return this; };
  return thenable;
};
FakeSensorData.countDocuments = async () => 0;

class FakeUser {
  constructor(doc) { Object.assign(this, doc); this._id = 'u-' + Date.now(); }
  async save() { return this; }
  async comparePassword(c) { return c === this.password; }
}
FakeUser.findOne = async (q) => q.username === 'admin'
  ? new FakeUser({ username: 'admin', password: 'admin123', role: 'admin' })
  : null;
FakeUser.findById = () => {
  const thenable = Promise.resolve({ _id: 'admin-id', username: 'admin', role: 'admin' });
  thenable.select = function () { return this; };
  return thenable;
};

// Redis 桩：保留 key/value 语义
const fakeRedisKv = {};
const fakeRedis = {
  initRedis: () => {},
  isAlertDuplicate: async () => false,
  markAlertSent: async () => 'OK',
  setPondRealtime: async (pondId, data) => {
    fakeRedisKv[`pond:${pondId}:realtime`] = JSON.stringify(data);
    return 'OK';
  },
  getPondRealtime: async (pondId) => {
    const v = fakeRedisKv[`pond:${pondId}:realtime`];
    return v ? JSON.parse(v) : null;
  },
  getAllPondsRealtime: async () => {
    const out = [];
    for (const [k, v] of Object.entries(fakeRedisKv)) {
      if (k.endsWith(':realtime')) {
        const pondId = k.split(':')[1];
        out.push({ pondId, ...JSON.parse(v) });
      }
    }
    return out;
  },
  setDeviceLastSeen: async () => 'OK',
  getDeviceLastSeen: async () => null,
  getRedis: () => ({ set: async () => 'OK', get: async () => null })
};

const fakeWebSocket = {
  initWebSocket: () => {},
  broadcastAlert: () => {},
  broadcastDeviceStatus: () => {},
  broadcastRealtimeData: () => {}
};

const fakeMqtt = {
  initMqttClient: async () => null,
  publishControl: async () => ({ success: true, reason: 'published' }),
  handleControlAck: async () => {},
  getClient: () => null,
  isConnected: () => true
};

mongoose.model = () => FakePond;
mongoose.Schema = function () {
  return { pre: () => mongoose.Schema(), index: () => mongoose.Schema() };
};
mongoose.connect = async () => 'fake-connection';
mongoose.connection = { close: async () => {} };

function injectMock(p, exports) {
  const abs = require.resolve(path.join(__dirname, 'src', p));
  require.cache[abs] = { exports };
}
injectMock('models/Pond.js', FakePond);
injectMock('models/SensorData.js', FakeSensorData);
injectMock('models/User.js', FakeUser);
injectMock('models/Device.js', class { static find = async () => [] });
injectMock('services/redisClient.js', fakeRedis);
injectMock('services/websocket.js', fakeWebSocket);
injectMock('services/mqttClient.js', fakeMqtt);

const pondRoutes = require('./src/routes/pond');
const dataRoutes = require('./src/routes/data');
const authRoutes = require('./src/routes/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/ponds', pondRoutes);
app.use('/api/data', dataRoutes);

const server = app.listen(0, async () => {
  const port = server.address().port;

  function request(method, url, body, token) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        host: '127.0.0.1', port, path: url, method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(token ? { 'Authorization': 'Bearer ' + token } : {})
        }
      }, (res) => {
        let buf = '';
        res.on('data', (d) => buf += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  let pass = 0, fail = 0;
  function assert(cond, msg) { cond ? (pass++, console.log('  ✓', msg)) : (fail++, console.log('  ✗', msg)); }

  try {
    // 登录拿 token
    const login = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    const token = login.body && login.body.data && login.body.data.token;
    assert(typeof token === 'string' && token.length > 10, '登录成功');

    // 创建两个塘口
    await request('POST', '/api/ponds', { pondId: 'P001', name: '1号塘', area: 10, species: '虾' }, token);
    await request('POST', '/api/ponds', { pondId: 'P002', name: '2号塘', area: 5, species: '鱼' }, token);

    // 直接向 Redis 写入"上报数据"（模拟 dataProcessor 收到 MQTT 后的写入）
    await fakeRedis.setPondRealtime('P001', {
      temperature: 25.0, ph: 7.2, dissolvedOxygen: 5.8, timestamp: '2026-07-17T08:00:00Z', deviceId: 'D001'
    });
    await fakeRedis.setPondRealtime('P002', {
      temperature: 24.0, ph: 7.0, dissolvedOxygen: 6.2, timestamp: '2026-07-17T08:00:00Z', deviceId: 'D002'
    });

    console.log('\n========== 验证 1：/api/ponds 列表的 pond.realtime 与 /api/ponds/:pondId 详情同源同值 ==========');
    const listRes = await request('GET', '/api/ponds', null, token);
    assert(listRes.status === 200, 'GET /api/ponds 返回 200');
    const listP001 = listRes.body.data.find(p => p.pondId === 'P001');
    const listP002 = listRes.body.data.find(p => p.pondId === 'P002');
    assert(listP001 && listP001.realtime && listP001.realtime.dissolvedOxygen === 5.8,
      `列表 P001 溶氧 = 5.8（实际=${listP001 && listP001.realtime && listP001.realtime.dissolvedOxygen}）`);
    assert(listP002 && listP002.realtime && listP002.realtime.dissolvedOxygen === 6.2,
      `列表 P002 溶氧 = 6.2（实际=${listP002 && listP002.realtime && listP002.realtime.dissolvedOxygen}）`);

    const detail1 = await request('GET', '/api/ponds/P001', null, token);
    assert(detail1.status === 200, 'GET /api/ponds/P001 返回 200');
    assert(detail1.body.data.realtime.dissolvedOxygen === 5.8,
      `详情 P001 溶氧 = 5.8（实际=${detail1.body.data.realtime.dissolvedOxygen}）`);

    // 关键：列表与详情同源同值
    assert(
      listP001.realtime.dissolvedOxygen === detail1.body.data.realtime.dissolvedOxygen,
      '列表 P001 与详情 P001 溶氧完全一致（5.8 === 5.8）'
    );

    console.log('\n========== 验证 2：/api/data/:pondId/realtime 是前端详情页正确路径 ==========');
    const realtime1 = await request('GET', '/api/data/P001/realtime', null, token);
    assert(realtime1.status === 200, 'GET /api/data/P001/realtime 返回 200');
    assert(realtime1.body.data.dissolvedOxygen === 5.8,
      `详情实时接口溶氧 = 5.8（实际=${realtime1.body.data.dissolvedOxygen}）`);

    // 模拟 1s 后设备再次上报（Redis 更新）
    await fakeRedis.setPondRealtime('P001', {
      temperature: 25.1, ph: 7.2, dissolvedOxygen: 5.2, timestamp: '2026-07-17T08:00:01Z', deviceId: 'D001'
    });

    // 运维人员再次请求列表和详情
    const listRes2 = await request('GET', '/api/ponds', null, token);
    const detail1b = await request('GET', '/api/ponds/P001', null, token);
    const realtime1b = await request('GET', '/api/data/P001/realtime', null, token);
    const listP001b = listRes2.body.data.find(p => p.pondId === 'P001');
    assert(listP001b.realtime.dissolvedOxygen === 5.2, '再次列表拉取 P001 已更新为 5.2');
    assert(detail1b.body.data.realtime.dissolvedOxygen === 5.2, '再次详情拉取 P001 也是 5.2');
    assert(realtime1b.body.data.dissolvedOxygen === 5.2, '实时接口也是 5.2');
    assert(
      listP001b.realtime.dissolvedOxygen === detail1b.body.data.realtime.dissolvedOxygen &&
        detail1b.body.data.realtime.dissolvedOxygen === realtime1b.body.data.dissolvedOxygen,
      '三个数据源完全一致：列表 === 详情 === 实时接口'
    );

    console.log('\n========== 验证 3：路径错误拦截（防止 /api/ponds/:pondId/realtime 这种 404 路径再次出现）==========');
    const wrong = await request('GET', '/api/ponds/P001/realtime', null, token);
    assert(wrong.status === 404, '旧路径 /api/ponds/P001/realtime 现在 404（路由表已不再支持，避免误用）');

    console.log('\n=========================================');
    console.log(`通过: ${pass}, 失败: ${fail}`);
    console.log('=========================================');
    server.close();
    process.exit(fail > 0 ? 1 : 0);
  } catch (e) {
    console.error('测试异常:', e);
    server.close();
    process.exit(1);
  }
});
