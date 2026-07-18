// 塘口列表按"养殖品种 + 塘口状态"组合筛选的回归测试
//
// 背景：运维反馈"南美白对虾 + 离线"组合条件下查询为空。
// 根因：原 /api/ponds 不解析 query，组合条件无法下推到 MongoDB。
// 修复：pond.js 解析 ?species=&status= 拼装 { species, status } 独立条件（AND 关系）。
//
// 验证要点：
//  1) 单条件：仅 species / 仅 status 都能正常返回
//  2) 组合条件：species=南美白对虾 + status=offline 必须返回同时匹配的两条
//  3) 组合条件不会"互相覆盖"（AND 语义，非 OR/覆盖）
//  4) 不传任何条件时返回全量（向后兼容）
//  5) 空字符串 / 非法 status 不应导致 500，应正常处理
//  6) URL 编码的中文品种名（南美白对虾）能被正确解码与匹配
//
// 用法：node test-pond-filter.js
// 依赖：纯 JS + node 内置 http，无需真实 MongoDB / Redis（FakePond 已实现 find 过滤）

const http = require('http');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');

// ============= FakePond：实现真正的 find(query) 过滤 =============
const fakePondStore = {};
class FakePond {
  constructor(doc) { Object.assign(this, doc); }
  toObject() { return { ...this }; }
  async save() { fakePondStore[this.pondId] = { ...this }; return this; }

  // 关键：模拟 mongoose Model.find(query) 接受过滤条件
  // 只支持本测试需要的 { species, status } 两个字段的精确匹配
  static find(query = {}) {
    const items = Object.values(fakePondStore).filter((p) => {
      if (query.species !== undefined && p.species !== query.species) return false;
      if (query.status !== undefined && p.status !== query.status) return false;
      return true;
    });
    const thenable = Promise.resolve(items.map((p) => new FakePond(p)));
    thenable.sort = function () { return this; };
    return thenable;
  }

  static findOne = (q) => {
    const item = fakePondStore[q.pondId];
    const thenable = Promise.resolve(item ? new FakePond({ ...item }) : null);
    thenable.select = function () { return this; };
    thenable.lean = function () { return this; };
    return thenable;
  };

  static findOneAndUpdate = async (q, update) => {
    const prev = fakePondStore[q.pondId] || { pondId: q.pondId };
    const setOps = (update && update.$set) || {};
    const next = { ...prev, ...setOps };
    fakePondStore[q.pondId] = next;
    return new FakePond(next);
  };
}

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

const fakeRedis = {
  initRedis: () => {},
  isAlertDuplicate: async () => false,
  markAlertSent: async () => 'OK',
  setPondRealtime: async (pondId, data) => { fakeRedisKv[`pond:${pondId}:realtime`] = JSON.stringify(data); return 'OK'; },
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
const fakeRedisKv = {};

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
injectMock('models/User.js', FakeUser);
injectMock('services/redisClient.js', fakeRedis);
injectMock('services/websocket.js', fakeWebSocket);
injectMock('services/mqttClient.js', fakeMqtt);
injectMock('models/SensorData.js', class { static findOne = async () => null; static find = async () => []; static countDocuments = async () => 0 });
injectMock('models/Device.js', class { static find = async () => [] });
injectMock('models/Alert.js', class {});

const pondRoutes = require('./src/routes/pond');
const authRoutes = require('./src/routes/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/ponds', pondRoutes);

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
  const ids = (arr) => arr.map((p) => p.pondId).sort().join(',');

  try {
    const login = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    const token = login.body && login.body.data && login.body.data.token;
    assert(typeof token === 'string' && token.length > 10, '登录成功');

    // 准备数据：4 个南美白对虾 + 4 个淡水鱼 + 2 个加州鲈
    // 南美白对虾 4 个：2 个 online + 2 个 offline
    // 淡水鱼 4 个：全部 online
    // 加州鲈 2 个：1 个 online + 1 个 offline
    // 注意：直接 seed fakePondStore（不通过 POST 端点）
    // 原因：pond.js 的 POST 处理器把 status 硬编码为 'offline'，不接收 body 里的 status。
    // 该限制是 API 既有行为（创建后由 mqttClient/dataProcessor 维护），不是本次修复点；
    // 测试要验证的是 GET 列表的查询组装，所以直接 seed 即可。
    const seed = [
      { pondId: 'P_S1', name: '虾1', area: 5, species: '南美白对虾', status: 'online' },
      { pondId: 'P_S2', name: '虾2', area: 5, species: '南美白对虾', status: 'online' },
      { pondId: 'P_S3', name: '虾3', area: 5, species: '南美白对虾', status: 'offline' },
      { pondId: 'P_S4', name: '虾4', area: 5, species: '南美白对虾', status: 'offline' },
      { pondId: 'P_F1', name: '鱼1', area: 8, species: '淡水鱼', status: 'online' },
      { pondId: 'P_F2', name: '鱼2', area: 8, species: '淡水鱼', status: 'online' },
      { pondId: 'P_F3', name: '鱼3', area: 8, species: '淡水鱼', status: 'online' },
      { pondId: 'P_F4', name: '鱼4', area: 8, species: '淡水鱼', status: 'online' },
      { pondId: 'P_J1', name: '鲈1', area: 3, species: '加州鲈', status: 'online' },
      { pondId: 'P_J2', name: '鲈2', area: 3, species: '加州鲈', status: 'offline' }
    ];
    for (const p of seed) {
      fakePondStore[p.pondId] = { ...p, aeratorStatus: false, aeratorMode: 'auto' };
    }
    console.log(`\n[准备数据] 共写入 ${seed.length} 个塘口：南美白对虾 4（2 online + 2 offline）/ 淡水鱼 4（全部 online）/ 加州鲈 2（1 online + 1 offline）`);

    console.log('\n========== 验证 1：不传任何条件，返回全量 ==========');
    const all = await request('GET', '/api/ponds', null, token);
    assert(all.status === 200, 'GET /api/ponds 返回 200');
    assert(all.body.data.length === 10, `全量应返回 10 条（实际=${all.body.data.length}）`);

    console.log('\n========== 验证 2：单条件 species=南美白对虾 ==========');
    const r2 = await request('GET', '/api/ponds?species=' + encodeURIComponent('南美白对虾'), null, token);
    assert(r2.status === 200, 'GET /api/ponds?species=南美白对虾 返回 200');
    const r2Ids = ids(r2.body.data);
    assert(r2Ids === 'P_S1,P_S2,P_S3,P_S4', `应返回 P_S1..P_S4 共 4 条（实际=${r2Ids}）`);

    console.log('\n========== 验证 3：单条件 status=offline ==========');
    const r3 = await request('GET', '/api/ponds?status=offline', null, token);
    assert(r3.status === 200, 'GET /api/ponds?status=offline 返回 200');
    const r3Ids = ids(r3.body.data);
    assert(r3Ids === 'P_J2,P_S3,P_S4', `应返回 P_S3/P_S4/P_J2 共 3 条（实际=${r3Ids}）`);

    console.log('\n========== 验证 4（核心 bug 修复点）：组合条件 species=南美白对虾 + status=offline ==========');
    const r4 = await request('GET', '/api/ponds?species=' + encodeURIComponent('南美白对虾') + '&status=offline', null, token);
    assert(r4.status === 200, 'GET /api/ponds?species=南美白对虾&status=offline 返回 200');
    const r4Ids = ids(r4.body.data);
    assert(r4Ids === 'P_S3,P_S4',
      `【关键】南美白对虾 + 离线 必须返回 P_S3 + P_S4 共 2 条（实际=${r4Ids}，空数组 = bug 未修复）`);

    console.log('\n========== 验证 5：组合条件 species=淡水鱼 + status=offline ==========');
    const r5 = await request('GET', '/api/ponds?species=' + encodeURIComponent('淡水鱼') + '&status=offline', null, token);
    assert(r5.status === 200, 'GET 返回 200');
    assert(r5.body.data.length === 0, `淡水鱼全部 online + 离线 组合应返回 0 条（实际=${r5.body.data.length}）`);

    console.log('\n========== 验证 6：组合条件 species=加州鲈 + status=offline ==========');
    const r6 = await request('GET', '/api/ponds?species=' + encodeURIComponent('加州鲈') + '&status=offline', null, token);
    assert(r6.status === 200, 'GET 返回 200');
    const r6Ids = ids(r6.body.data);
    assert(r6Ids === 'P_J2', `加州鲈 + 离线 应返回 P_J2 共 1 条（实际=${r6Ids}）`);

    console.log('\n========== 验证 7：组合条件顺序无关（status 在前） ==========');
    const r7 = await request('GET', '/api/ponds?status=offline&species=' + encodeURIComponent('南美白对虾'), null, token);
    assert(ids(r7.body.data) === 'P_S3,P_S4', `顺序无关：也应返回 P_S3,P_S4（实际=${ids(r7.body.data)}）`);

    console.log('\n========== 验证 8：非法 status 返回 400 ==========');
    const r8 = await request('GET', '/api/ponds?status=invalid', null, token);
    assert(r8.status === 400, `非法 status 应 400（实际=${r8.status}）`);
    assert(r8.body && r8.body.message && r8.body.message.includes('online'),
      `错误信息提示可接受的值（实际=${r8.body && r8.body.message}）`);

    console.log('\n========== 验证 9：空字符串参数不参与过滤（向后兼容） ==========');
    const r9 = await request('GET', '/api/ponds?species=&status=', null, token);
    assert(r9.status === 200, '空字符串参数应正常 200');
    assert(r9.body.data.length === 10, `空字符串应被忽略，返回全量 10 条（实际=${r9.body.data.length}）`);

    console.log('\n========== 验证 10：URL 编码中文品种名正确解码 ==========');
    // axios 在浏览器会自动 encodeURIComponent，这里手动模拟以排除编码问题
    const r10 = await request('GET', '/api/ponds?species=%E5%8D%97%E7%BE%8E%E7%99%BD%E5%AF%B9%E8%99%BE&status=offline', null, token);
    assert(r10.status === 200, 'URL 编码的南美白对虾应正常 200');
    assert(ids(r10.body.data) === 'P_S3,P_S4',
      `URL 编码形式也应正确返回 P_S3,P_S4（实际=${ids(r10.body.data)}）`);

    console.log('\n=========================================');
    console.log(`通过: ${pass}, 失败: ${fail}`);
    console.log('=========================================');
    if (fail > 0) {
      console.log('\n❌ 组合筛选仍存在 bug，请检查后端 query 拼装逻辑');
    } else {
      console.log('\n✅ 全部通过：单条件/组合条件/边界场景均正确');
    }
    server.close();
    process.exit(fail > 0 ? 1 : 0);
  } catch (e) {
    console.error('测试异常:', e);
    server.close();
    process.exit(1);
  }
});
