// 端到端 API 验证：通过真实 HTTP 调用验证 control.js 修复
// 不依赖真实 MongoDB/MQTT，通过 stub mongoose + stub mqtt publish 完成

const http = require('http');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');

// ===== 桩：mock mongoose 模型 =====
const fakePondStore = {};
function buildFakePond() {
  const M = {
    schema: () => ({}),
    model: () => FakePond
  };
  return M;
}

class FakePond {
  constructor(doc) { Object.assign(this, doc); }
  async save() { fakePondStore[this.pondId] = { ...this }; return this; }
  toObject() { return { ...this }; }
}
FakePond.find = async () => Object.values(fakePondStore).map(p => new FakePond(p));
FakePond.findOne = (q) => {
  const item = fakePondStore[q.pondId];
  const result = item ? new FakePond({ ...item }) : null;
  // 返回 thenable（mongoose 风格），既可 await 也支持 .select().lean()
  const thenable = Promise.resolve(result);
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
FakePond.findOneAndDelete = async (q) => {
  const prev = fakePondStore[q.pondId];
  if (prev) { delete fakePondStore[q.pondId]; return new FakePond(prev); }
  return null;
};

class FakeAlert {
  constructor(doc) { Object.assign(this, doc); this._id = 'aid-' + Date.now() + Math.random(); }
  async save() { return this; }
  toObject() { return { ...this }; }
}

const fakeAlertDup = new Set();
const fakeRedis = {
  initRedis: () => {},
  isAlertDuplicate: async (pondId, type) => fakeAlertDup.has(`${pondId}:${type}`),
  markAlertSent: async (pondId, type) => { fakeAlertDup.add(`${pondId}:${type}`); },
  setPondRealtime: async () => 'OK',
  getPondRealtime: async () => null,
  setDeviceLastSeen: async () => 'OK',
  getDeviceLastSeen: async () => null,
  getRedis: () => ({ set: async()=>'OK', get: async()=>null })
};

const fakeWebSocket = {
  initWebSocket: () => {},
  broadcastAlert: () => {},
  broadcastDeviceStatus: () => {},
  broadcastRealtimeData: () => {}
};

// Fake MQTT 客户端：通过 _nextResult 控制 publishControl 下一次返回
let _nextMqttResult = { success: false, reason: 'mqtt_disconnected', message: 'MQTT 未连接' };
// 先用真实实现替换 publishControl 桩，让 handleControlAck 仍走真实实现
const fakeMqtt = {
  initMqttClient: async () => null,
  publishControl: async () => _nextMqttResult,
  // 真实 mqttClient 加载后会被覆盖
  handleControlAck: async () => {},
  getClient: () => null,
  isConnected: () => _nextMqttResult && _nextMqttResult.success,
  setNextResult: (r) => { _nextMqttResult = r; }
};

// 让 mongoose 在 require 时不抛错
mongoose.model = function (name, schema) {
  if (name === 'Pond') return FakePond;
  if (name === 'User') return FakeUser;
  if (name === 'Alert') return FakeAlert;
  return FakePond;
};
function FakeSchema() {
  return {
    pre: () => FakeSchema(),
    index: () => FakeSchema(),
    virtual: () => FakeSchema()
  };
}
mongoose.Schema = FakeSchema;
mongoose.connect = async () => 'fake-connection';
mongoose.connection = { close: async () => {} };

// Fake User 模型
class FakeUser {
  constructor(doc) { Object.assign(this, doc); this._id = doc._id || 'u-' + Date.now(); }
  async save() { fakeUserStore[this.username] = this; return this; }
  async comparePassword(candidate) { return candidate === this.password; }
}
const fakeUserStore = {};
FakeUser.findOne = async (q) => {
  if (q.username) return fakeUserStore[q.username] || null;
  return null;
};
FakeUser.findById = (id) => {
  console.log('[FakeUser.findById] called with id:', id);
  // 返回 thenable（mongoose 风格），既可以 await 也支持链式 .select()
  let foundUser = null;
  for (const u of Object.values(fakeUserStore)) {
    if (u._id === id) {
      foundUser = { _id: u._id, username: u.username, role: u.role, phone: u.phone };
      break;
    }
  }
  const thenable = Promise.resolve(foundUser);
  thenable.select = function () { return this; };
  return thenable;
};
// 预置 admin 账号
fakeUserStore['admin'] = new FakeUser({
  username: 'admin', password: 'admin123', role: 'admin', phone: '', _id: 'admin-id'
});

// Fake SensorData 模型
class FakeSensorData {
  constructor(doc) { Object.assign(this, doc); }
  async save() { return this; }
  toObject() { return { ...this }; }
}
FakeSensorData.findOne = () => {
  // 返回可链式调用的 thenable
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

// Fake Device 模型
class FakeDevice {
  constructor(doc) { Object.assign(this, doc); }
}
FakeDevice.find = async () => [];
FakeDevice.findOne = async () => null;
FakeDevice.findOneAndUpdate = async () => null;

// 注入到 require 缓存
function injectMock(modulePath, exports) {
  const absPath = require.resolve(path.join(__dirname, 'src', modulePath));
  require.cache[absPath] = { exports };
}
injectMock('models/Pond.js', FakePond);
injectMock('models/Alert.js', FakeAlert);
injectMock('models/User.js', FakeUser);
injectMock('models/SensorData.js', FakeSensorData);
injectMock('models/Device.js', FakeDevice);
injectMock('services/redisClient.js', fakeRedis);
injectMock('services/websocket.js', fakeWebSocket);

// 包装 auth 中间件以打印错误详情
const originalAuthMiddleware = require('./src/middleware/auth').authMiddleware;
function debugAuth(req, res, next) {
  return Promise.resolve()
    .then(() => originalAuthMiddleware(req, res, next))
    .catch((e) => {
      console.log('[AUTH REJECT ERR]', e && e.message, e && e.stack);
      return res.status(500).json({ success: false, message: '认证服务异常: ' + (e && e.message) });
    });
}
// 重写中间件模块，让路由用调试版
const authModule = require.cache[require.resolve('./src/middleware/auth')];
if (authModule) {
  authModule.exports.authMiddleware = debugAuth;
}

// 加载真实 mqttClient（用于 handleControlAck），但保留桩的 publishControl
// 步骤：先把 fakeMqtt 注入缓存；再删掉缓存，强制 require 真实 mqttClient；把真实 handleControlAck 装到 fakeMqtt 上
injectMock('services/mqttClient.js', fakeMqtt); // 先让 mqttClient 路径返回 fakeMqtt
const mqttRealPath = require.resolve('./src/services/mqttClient');
delete require.cache[mqttRealPath]; // 删掉，让下次 require 真的去加载
const realMqtt = require('./src/services/mqttClient'); // 加载真实实现
// 把真实实现的关键方法装到 fakeMqtt 上（保持缓存里的 fakeMqtt 不变）
fakeMqtt.handleControlAck = realMqtt.handleControlAck;
// 再次把 fakeMqtt 注入到缓存（因为上面 require 真实实现会覆盖缓存）
injectMock('services/mqttClient.js', fakeMqtt);

// 用真实的 express 路由
const authRoutes = require('./src/routes/auth');
const pondRoutes = require('./src/routes/pond');
const dataRoutes = require('./src/routes/data');
const alertRoutes = require('./src/routes/alert');
const controlRoutes = require('./src/routes/control');
const deviceRoutes = require('./src/routes/device');

const app = express();
app.use(express.json());
app.use((err, req, res, next) => {
  console.log('[EXPRESS ERR]', err && err.message, err && err.stack);
  res.status(500).json({ success: false, message: '服务器异常' });
});
app.use('/api/auth', authRoutes);
app.use('/api/ponds', pondRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/control', controlRoutes);
app.use('/api/devices', deviceRoutes);

// 全局异常捕获
process.on('uncaughtException', (e) => console.log('[UNCAUGHT]', e.message, e.stack));
process.on('unhandledRejection', (e) => console.log('[UNHANDLED]', e && e.message, e && e.stack));

const server = app.listen(0, async () => {
  const port = server.address().port;
  console.log(`[TEST] Express 启动于端口 ${port}`);

  let totalPass = 0, totalFail = 0;
  function pass(msg) { totalPass++; console.log('  ✓', msg); }
  function fail(msg) { totalFail++; console.log('  ✗ FAIL:', msg); }
  function assert(cond, msg) { cond ? pass(msg) : fail(msg); }

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

  try {
    // ===== 登录拿 token =====
    const loginRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    if (loginRes.status !== 200) {
      // 默认账号可能被前端测试破坏；尝试注册
      console.log('  登录失败，尝试注册测试账号');
    }
    const token = loginRes.body && loginRes.body.data && loginRes.body.data.token;
    assert(typeof token === 'string' && token.length > 10, `获取到 token（长度=${token && token.length}）`);

    // ===== 创建测试塘口 =====
    const createPond = await request('POST', '/api/ponds',
      { pondId: 'TEST_P001', name: '测试塘口1', area: 10, species: '虾' }, token);
    if (createPond.status !== 200 && createPond.status !== 201) {
      console.log('  创建塘口响应:', JSON.stringify(createPond.body));
    }
    assert(createPond.status === 200 || createPond.status === 201, `创建塘口成功 status=${createPond.status}`);

    // 创建 TEST_P002 塘口
    const createPond2 = await request('POST', '/api/ponds',
      { pondId: 'TEST_P002', name: '测试塘口2', area: 5, species: '鱼' }, token);
    assert(createPond2.status === 200, `创建 TEST_P002 成功 status=${createPond2.status}`);

    // ===== 测试 1：MQTT 未连接（默认）下，控制接口应返回 503，且 aeratorStatus 不会置 true =====
    console.log('\n[场景 1] MQTT 断开时控制增氧机');
    fakeMqtt.setNextResult({ success: false, reason: 'mqtt_disconnected', message: 'MQTT 未连接' });

    const r1 = await request('POST', '/api/control/TEST_P001/aerator', { action: 'on' }, token);
    assert(r1.status === 503, `返回 503（实际=${r1.status}）`);
    assert(r1.body.success === false, 'success=false');
    assert(r1.body.code === 'MQTT_PUBLISH_FAILED', 'code=MQTT_PUBLISH_FAILED');

    const detail1 = await request('GET', '/api/data/TEST_P001/realtime', null, token);
    console.log('  实时数据:', JSON.stringify(detail1.body.data));
    assert(detail1.body.data && detail1.body.data.aeratorStatus !== true, `aeratorStatus 不为 true（实际=${detail1.body.data && detail1.body.data.aeratorStatus}）— 关键！`);
    assert(detail1.body.data && detail1.body.data.commandPending === true, 'commandPending=true');

    // ===== 测试 2：MQTT 连上（publish 成功）但设备无 ack → 仍应显示 pending，不显示 running =====
    console.log('\n[场景 2] MQTT 连上但设备未回执');
    fakeMqtt.setNextResult({ success: true, commandId: 'test-cid-002', reason: 'published' });
    const r2 = await request('POST', '/api/control/TEST_P001/aerator', { action: 'on' }, token);
    assert(r2.status === 200, `返回 200（实际=${r2.status}）`);
    assert(r2.body.data && r2.body.data.mqttSent === true, 'mqttSent=true');
    assert(r2.body.data && r2.body.data.commandPending === true, 'commandPending=true（关键：等待设备确认）');

    const detail2 = await request('GET', '/api/data/TEST_P001/realtime', null, token);
    console.log('  实时数据:', JSON.stringify(detail2.body.data));
    assert(detail2.body.data && detail2.body.data.commandPending === true, '实时数据 commandPending=true');
    assert(detail2.body.data && detail2.body.data.aeratorStatus !== true, 'aeratorStatus 仍为 false（关键！设备未确认时不假启动）');
    assert(detail2.body.data && detail2.body.data.lastCommandId === 'test-cid-002', 'lastCommandId 已记录');

    // ===== 测试 3：模拟设备回执 ok，状态应转为 running =====
    console.log('\n[场景 3] 设备回执 OK 后状态才置为 running');
    await fakeMqtt.handleControlAck('TEST_P001', { commandId: 'test-cid-002', command: 'aerator_on', result: 'ok' });
    const detail3 = await request('GET', '/api/data/TEST_P001/realtime', null, token);
    console.log('  实时数据:', JSON.stringify(detail3.body.data));
    assert(detail3.body.data && detail3.body.data.commandPending === false, 'commandPending 清掉');
    assert(detail3.body.data && detail3.body.data.aeratorStatus === true, '设备 ack 后 aeratorStatus=true');

    // ===== 测试 4：模拟设备回执 fail，状态不应误显为 running =====
    console.log('\n[场景 4] 设备回执 FAIL 时不应误显 running');
    fakeMqtt.setNextResult({ success: true, commandId: 'test-cid-003', reason: 'published' });
    const r4 = await request('POST', '/api/control/TEST_P002/aerator', { action: 'on' }, token);
    assert(r4.status === 200, '控制接口返回 200');
    await fakeMqtt.handleControlAck('TEST_P002', { commandId: 'test-cid-003', command: 'aerator_on', result: 'fail', error: 'relay_timeout' });
    const detail4 = await request('GET', '/api/data/TEST_P002/realtime', null, token);
    console.log('  实时数据:', JSON.stringify(detail4.body.data));
    assert(detail4.body.data && detail4.body.data.commandPending === false, 'commandPending 清掉');
    assert(detail4.body.data && detail4.body.data.aeratorStatus === false, '硬件回执失败 aeratorStatus 保持 false');
    assert(detail4.body.data && detail4.body.data.aeratorStatusFault === true, 'aeratorStatusFault=true');

    // ===== 汇总 =====
    console.log(`\n========== 端到端 API 验证汇总 ==========`);
    console.log(`通过: ${totalPass}, 失败: ${totalFail}`);
    server.close();
    process.exit(totalFail > 0 ? 1 : 0);
  } catch (e) {
    console.error('测试异常:', e);
    server.close();
    process.exit(1);
  }
});
