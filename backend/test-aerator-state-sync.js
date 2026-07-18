/**
 * 增氧机被动状态同步修复 - 回归测试
 *
 * 背景：现场运维人员手动操作增氧机物理开关（绕开平台远程控制）时，
 * 增氧机实际状态发生变化，但平台前端仍显示原状态。
 *
 * 修复链路：
 *  1) 固件 publishData/publishStatus payload 增加 aeratorStatus 字段（digitalRead GPIO）
 *  2) 固件 loop 巡检发现 GPIO 与内部状态不一致时 publishAeratorStateEvent
 *  3) 后端 dataProcessor.processSensorData 解析 aeratorStatus 同步到 Pond
 *  4) 后端 mqttClient.handleDeviceStatus 解析 status 报告的 aeratorStatus 同步
 *  5) 后端 mqttClient.handleAeratorStateEvent 处理被动事件，同步 + 清 pending
 *  6) 前端 PondDetail 监听 onRealtimeData / onDeviceStatus 即时刷新
 *
 * 验证不变量（纯逻辑层，桩掉 mongoose/redis/websocket）：
 *  A) dataProcessor：data payload 携带 aeratorStatus 时，DB 同步
 *  B) dataProcessor：状态一致时跳过写库（避免无谓 IO）
 *  C) handleAeratorStateEvent：被动事件同步 DB
 *  D) handleAeratorStateEvent：被动事件清掉 commandPending 与 aeratorStatusFault
 *  E) handleAeratorStateEvent：状态已一致时跳过
 *  F) handleAeratorStateEvent：覆盖 pending 时产生 warning 告警
 *  G) handleDeviceStatus：status payload 携带 aeratorStatus 时 DB 同步
 *  H) handleDeviceStatus：status payload 不携带 aeratorStatus 时不影响 Pond.aeratorStatus
 *  I) handleDeviceStatus：commandPending=true 时不同步 status 报告的 aeratorStatus（保留命令路径）
 *     —— 但 handleAeratorStateEvent 可以（这是事实覆盖）
 */

const path = require('path');

// ===== 桩：内存模拟器替代 mongoose =====
// 设计：findOne 返回 thenable Query 对象（不是 Promise），
//       这样 await Model.findOne(filter).lean() 与 mongoose 真实行为一致
//       mongoose 的 Model.findOne() 返回 Query（thenable 但不是 Promise），
//       query.lean() 返回 query 本身，await query 拿文档
function makeThenableQuery(getDoc) {
  const obj = {
    _doc: getDoc(),
    _selectedFields: null,
    select(fields) {
      const fieldList = typeof fields === 'string'
        ? fields.split(/\s+/).filter(Boolean)
        : Object.keys(fields || {});
      this._selectedFields = fieldList;
      return this;
    },
    lean() {
      const self = this;
      return makeThenableQuery(() => {
        if (!self._doc) return null;
        if (self._selectedFields && self._selectedFields.length > 0) {
          const picked = {};
          self._selectedFields.forEach((f) => { picked[f] = self._doc[f]; });
          if (self._doc.pondId) picked.pondId = self._doc.pondId;
          if (self._doc.deviceId) picked.deviceId = self._doc.deviceId;
          return picked;
        }
        return { ...self._doc };
      });
    },
    then(resolve, reject) {
      // thenable：让 `await query` 拿到 _doc
      Promise.resolve(this._doc).then(resolve, reject);
    }
  };
  return obj;
}

const fakePondStore = {};
class FakePond {
  constructor(doc) { Object.assign(this, doc); }
  static _save(doc) {
    const prev = fakePondStore[doc.pondId] || { pondId: doc.pondId };
    fakePondStore[doc.pondId] = { ...prev, ...doc };
    return new FakePond(fakePondStore[doc.pondId]);
  }
  async save() { return FakePond._save(this); }
  toObject() { return { ...this }; }
}
FakePond.findOneAndUpdate = async (q, update, opts) => {
  const prev = fakePondStore[q.pondId] || { pondId: q.pondId };
  const setOps = (update && update.$set) || {};
  const next = { ...prev, ...setOps };
  fakePondStore[q.pondId] = next;
  return new FakePond(next);
};
FakePond.find = async () => [];
// findOne 返回 thenable Query，模拟 mongoose（不返回 Promise，否则 .lean() 无法链式）
FakePond.findOne = (q) => makeThenableQuery(() => fakePondStore[q.pondId] || null);

const fakeDeviceStore = {};
class FakeDevice {
  constructor(doc) { Object.assign(this, doc); }
  static _save(doc) {
    const prev = fakeDeviceStore[doc.deviceId] || { deviceId: doc.deviceId };
    fakeDeviceStore[doc.deviceId] = { ...prev, ...doc };
    return new FakeDevice(fakeDeviceStore[doc.deviceId]);
  }
  async save() { return FakeDevice._save(this); }
}
FakeDevice.findOneAndUpdate = async (q, update, opts) => {
  const prev = fakeDeviceStore[q.deviceId] || { deviceId: q.deviceId };
  const setOps = (update && update.$set) || {};
  const setOnInsert = (update && update.$setOnInsert) || {};
  const next = { ...prev, ...setOps, ...setOnInsert };
  fakeDeviceStore[q.deviceId] = next;
  return new FakeDevice(next);
};
FakeDevice.countDocuments = async () => 0;
FakeDevice.findOne = (q) => makeThenableQuery(() => fakeDeviceStore[q.deviceId] || null);

// 桩：SensorData（避免 dataProcessor 真实写 MongoDB）
const fakeSensorDataStore = [];
class FakeSensorData {
  constructor(doc) { Object.assign(this, doc); }
  async save() { fakeSensorDataStore.push(this); return this; }
}
FakeSensorData._reset = () => { fakeSensorDataStore.length = 0; };

const fakeAlertStore = [];
class FakeAlert {
  constructor(doc) { Object.assign(this, doc); fakeAlertStore.push(this); }
  async save() { return this; }
  toObject() { return { ...this }; }
}

const fakeRedis = {
  isAlertDuplicate: async () => false,
  markAlertSent: async () => 'OK',
  setPondRealtime: async () => 'OK',
  setDeviceLastSeen: async () => 'OK',
  getPondRealtime: async () => null
};

const fakeBroadcasts = { alert: 0, deviceStatus: 0, realtime: 0 };
const fakeWebSocket = {
  broadcastAlert: () => fakeBroadcasts.alert++,
  broadcastDeviceStatus: () => fakeBroadcasts.deviceStatus++,
  broadcastRealtimeData: () => fakeBroadcasts.realtime++
};

// 把桩注入 require 缓存
function injectMocks() {
  const root = path.join(__dirname, 'src');
  require.cache[path.join(root, 'models/Pond.js')] = { exports: FakePond };
  require.cache[path.join(root, 'models/Device.js')] = { exports: FakeDevice };
  require.cache[path.join(root, 'models/SensorData.js')] = { exports: FakeSensorData };
  require.cache[path.join(root, 'models/Alert.js')] = { exports: FakeAlert };
  require.cache[path.join(root, 'services/redisClient.js')] = { exports: fakeRedis };
  require.cache[path.join(root, 'services/websocket.js')] = { exports: fakeWebSocket };
  require.cache[path.join(root, 'services/alertEngine.js')] = {
    exports: { checkThresholds: async () => null }
  };
}

let totalPass = 0, totalFail = 0;
function assert(cond, msg) {
  if (cond) { totalPass++; console.log('  ✓', msg); }
  else { totalFail++; console.log('  ✗ FAIL:', msg); }
}

// 重置所有桩状态
function reset() {
  Object.keys(fakePondStore).forEach((k) => delete fakePondStore[k]);
  Object.keys(fakeDeviceStore).forEach((k) => delete fakeDeviceStore[k]);
  fakeAlertStore.length = 0;
  fakeBroadcasts.alert = 0;
  fakeBroadcasts.deviceStatus = 0;
  fakeBroadcasts.realtime = 0;
}

(async function main() {
  injectMocks();
  const { processSensorData } = require('./src/services/dataProcessor');
  const { handleDeviceStatus, handleAeratorStateEvent } = require('./src/services/mqttClient');

  // ========================================================
  // A) dataProcessor：data payload 携带 aeratorStatus=true，DB 同步
  // ========================================================
  console.log('\n[A] dataProcessor data payload 同步 aeratorStatus');
  reset();
  fakePondStore['P1'] = { pondId: 'P1', aeratorStatus: false, status: 'online' };
  fakeDeviceStore['D1'] = { deviceId: 'D1', pondId: 'P1', status: 'online' };
  await processSensorData({
    pondId: 'P1',
    deviceId: 'D1',
    temperature: 25.0,
    ph: 7.0,
    dissolvedOxygen: 5.0,
    aeratorStatus: true,
    timestamp: new Date().toISOString()
  });
  assert(fakePondStore['P1'].aeratorStatus === true,
    'aeratorStatus=false → true 同步成功');

  // ========================================================
  // B) dataProcessor：状态一致时跳过（不应产生额外 broadcast）
  // ========================================================
  console.log('\n[B] dataProcessor 状态一致时跳过');
  reset();
  fakePondStore['P1'] = { pondId: 'P1', aeratorStatus: true, status: 'online' };
  fakeDeviceStore['D1'] = { deviceId: 'D1', pondId: 'P1', status: 'online' };
  const beforeRealtime = fakeBroadcasts.realtime;
  await processSensorData({
    pondId: 'P1',
    deviceId: 'D1',
    temperature: 25.0,
    ph: 7.0,
    dissolvedOxygen: 5.0,
    aeratorStatus: true,
    timestamp: new Date().toISOString()
  });
  assert(fakePondStore['P1'].aeratorStatus === true,
    '状态一致时 aeratorStatus 仍为 true');
  assert(fakeBroadcasts.realtime > beforeRealtime,
    'realtime_data 仍然广播（数据字段更新）');

  // ========================================================
  // C) handleAeratorStateEvent：被动事件 → DB 同步
  // ========================================================
  console.log('\n[C] 被动事件 aerator_state_changed 同步');
  reset();
  fakePondStore['P1'] = { pondId: 'P1', aeratorStatus: true, status: 'online' };
  await handleAeratorStateEvent('P1', {
    deviceId: 'D1',
    aeratorStatus: false,
    reason: 'gpio_mismatch'
  });
  assert(fakePondStore['P1'].aeratorStatus === false,
    '被动事件 true → false 同步成功');
  assert(fakeBroadcasts.deviceStatus >= 1,
    'device_status 广播已发出');

  // ========================================================
  // D) handleAeratorStateEvent：被动事件清掉 commandPending 与 fault
  // ========================================================
  console.log('\n[D] 被动事件清掉 pending 与 fault');
  reset();
  fakePondStore['P1'] = {
    pondId: 'P1', aeratorStatus: true, status: 'online',
    commandPending: true, commandPendingExpiresAt: new Date(Date.now() + 30000),
    aeratorStatusFault: true
  };
  await handleAeratorStateEvent('P1', {
    deviceId: 'D1',
    aeratorStatus: false,
    reason: 'manual_switch'
  });
  assert(fakePondStore['P1'].commandPending === false,
    'commandPending 被清掉（避免"待确认"长期停留）');
  assert(fakePondStore['P1'].commandPendingExpiresAt === null,
    'commandPendingExpiresAt 被清掉');
  assert(fakePondStore['P1'].aeratorStatusFault === false,
    'aeratorStatusFault 被清掉');

  // ========================================================
  // E) handleAeratorStateEvent：状态已一致时跳过
  // ========================================================
  console.log('\n[E] 状态已一致时跳过');
  reset();
  fakePondStore['P1'] = { pondId: 'P1', aeratorStatus: true, status: 'online' };
  const beforeStatus = fakeBroadcasts.deviceStatus;
  await handleAeratorStateEvent('P1', {
    deviceId: 'D1',
    aeratorStatus: true,
    reason: 'heartbeat'
  });
  assert(fakePondStore['P1'].aeratorStatus === true, 'aeratorStatus 保持 true');
  assert(fakeBroadcasts.deviceStatus === beforeStatus,
    '状态一致时不广播 device_status（避免噪声）');

  // ========================================================
  // F) handleAeratorStateEvent：覆盖 pending 时产生 warning 告警
  // ========================================================
  console.log('\n[F] 覆盖 pending 时产生 warning 告警');
  reset();
  fakePondStore['P1'] = {
    pondId: 'P1', aeratorStatus: true, status: 'online',
    commandPending: true
  };
  const beforeAlert = fakeAlertStore.length;
  await handleAeratorStateEvent('P1', {
    deviceId: 'D1',
    aeratorStatus: false,
    reason: 'gpio_mismatch'
  });
  const newAlerts = fakeAlertStore.slice(beforeAlert);
  assert(newAlerts.length === 1, '产生 1 条告警');
  assert(newAlerts[0] && newAlerts[0].type === 'aerator_state_mismatch',
    '告警类型为 aerator_state_mismatch');
  assert(newAlerts[0] && newAlerts[0].level === 'warning',
    '告警等级为 warning（非 critical，避免噪声）');
  assert(newAlerts[0] && newAlerts[0].message.includes('现场操作'),
    '告警消息提示"现场操作"原因');

  // ========================================================
  // G) handleDeviceStatus：status payload 携带 aeratorStatus → DB 同步
  // ========================================================
  console.log('\n[G] status 报告携带 aeratorStatus 同步');
  reset();
  fakePondStore['P1'] = { pondId: 'P1', aeratorStatus: false, status: 'online' };
  fakeDeviceStore['D1'] = { deviceId: 'D1', pondId: 'P1', status: 'online', firmwareVersion: '1.1.0' };
  await handleDeviceStatus('P1', {
    deviceId: 'D1',
    status: 'online',
    firmwareVersion: '1.1.0',
    aeratorStatus: true
  });
  assert(fakePondStore['P1'].aeratorStatus === true,
    'status 报告 false → true 同步成功');

  // ========================================================
  // H) handleDeviceStatus：payload 不携带 aeratorStatus 不影响 DB
  // ========================================================
  console.log('\n[H] 旧 payload（无 aeratorStatus）不影响 DB');
  reset();
  fakePondStore['P1'] = { pondId: 'P1', aeratorStatus: true, status: 'online' };
  fakeDeviceStore['D1'] = { deviceId: 'D1', pondId: 'P1', status: 'online' };
  await handleDeviceStatus('P1', {
    deviceId: 'D1',
    status: 'online'
    // 注意：没有 aeratorStatus 字段
  });
  assert(fakePondStore['P1'].aeratorStatus === true,
    'aeratorStatus 保持原值（兼容老固件）');

  // ========================================================
  // I) handleDeviceStatus：commandPending=true 时不同步 status 报告的 aeratorStatus
  // ========================================================
  console.log('\n[I] commandPending=true 时不同步 status 报告（保留命令路径）');
  reset();
  fakePondStore['P1'] = {
    pondId: 'P1', aeratorStatus: false, status: 'online',
    commandPending: true
  };
  fakeDeviceStore['D1'] = { deviceId: 'D1', pondId: 'P1', status: 'online' };
  await handleDeviceStatus('P1', {
    deviceId: 'D1',
    status: 'online',
    aeratorStatus: true
  });
  assert(fakePondStore['P1'].aeratorStatus === false,
    'pending 期间 status 报告的 aeratorStatus 不覆盖 DB（让命令回执/超时兜底处理）');

  // ========================================================
  console.log(`\n========== ${totalPass} passed, ${totalFail} failed ==========`);
  if (totalFail > 0) process.exit(1);
})().catch((err) => {
  console.error('测试运行失败:', err);
  process.exit(2);
});
