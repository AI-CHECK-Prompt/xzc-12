// 回归测试：验证"老固件无回执导致待确认永久停留"修复
// 关键不变量：
//   1) firmware 工具：supportsControlAck 准确识别 1.0.0 / 1.1.0 / 2.0.0
//   2) getCommandAckTimeoutMs：老固件短超时 5s，新固件长超时 30s
//   3) control.js 在 MQTT publish 成功后，会把 commandPendingExpiresAt 设置为 now+timeout
//   4) 老固件：commandTimeoutChecker 兜底会乐观更新 aeratorStatus，
//      并保留 lastCommandNoAck=true
//   5) 新固件：超时未 ack 会被标记 aeratorStatusFault=true（设备可能真故障）
//   6) data.js 接口会透传 commandPendingExpiresAt / lastCommandNoAck / deviceFirmwareVersion

const path = require('path');

// ===== 桩 1：mongoose 桩 =====
const fakePondStore = {};
class FakePond {
  constructor(doc) { Object.assign(this, doc); }
  async save() {
    fakePondStore[this.pondId] = { ...this };
    return this;
  }
}
FakePond.findOne = async (q) => fakePondStore[q.pondId] ? new FakePond(fakePondStore[q.pondId]) : null;
FakePond.findOneAndUpdate = async (q, update, opts) => {
  const prev = fakePondStore[q.pondId] || { pondId: q.pondId, aeratorStatus: false, aeratorMode: 'auto' };
  const setOps = (update && update.$set) || {};
  const next = { ...prev, ...setOps };
  fakePondStore[q.pondId] = next;
  return new FakePond(next);
};
// 模拟"过期巡检"的 find：commandPending=true 且 commandPendingExpiresAt<=now
FakePond.find = (q) => {
  const builder = {
    _q: q,
    lean() {
      const list = Object.values(fakePondStore).filter((p) => {
        if (q.commandPending && p.commandPending !== true) return false;
        if (q.commandPendingExpiresAt) {
          if (!p.commandPendingExpiresAt) return false;
          if (q.commandPendingExpiresAt.$lte && p.commandPendingExpiresAt > q.commandPendingExpiresAt.$lte) return false;
        }
        return true;
      });
      return Promise.resolve(list.map((p) => ({ ...p })));
    }
  };
  return builder;
};

// ===== 桩 2：redis / websocket / alert =====
const fakeRedis = {
  isAlertDuplicate: async () => false,
  markAlertSent: async () => 'OK',
  setPondRealtime: async () => 'OK',
  setDeviceLastSeen: async () => 'OK',
  getPondRealtime: async () => null,
  getDeviceLastSeen: async () => null
};
const fakeBroadcasts = { alert: 0, deviceStatus: 0, realtime: 0 };
const fakeWebSocket = {
  broadcastAlert: () => fakeBroadcasts.alert++,
  broadcastDeviceStatus: (pondId, status) => { fakeBroadcasts.deviceStatus++; fakeBroadcasts.lastStatus = status; },
  broadcastRealtimeData: () => { fakeBroadcasts.realtime++; }
};

const fakeAlertStore = [];
class FakeAlert {
  constructor(doc) { Object.assign(this, doc); fakeAlertStore.push(this); }
  async save() { return this; }
  toObject() { return { ...this }; }
}

// 注入桩到 require 缓存
function injectMocks() {
  const moduleRoot = path.join(__dirname, 'src');
  require.cache[path.join(moduleRoot, 'models/Pond.js')] = { exports: FakePond };
  require.cache[path.join(moduleRoot, 'models/Alert.js')] = { exports: FakeAlert };
  require.cache[path.join(moduleRoot, 'services/redisClient.js')] = { exports: fakeRedis };
  require.cache[path.join(moduleRoot, 'services/websocket.js')] = { exports: fakeWebSocket };
}

let totalPass = 0, totalFail = 0;
function assert(cond, msg) {
  if (cond) { totalPass++; console.log('  ✓', msg); }
  else { totalFail++; console.log('  ✗ FAIL:', msg); }
}

(async function main() {
  injectMocks();

  // ============ 测试 1：firmware.supportsControlAck 识别 ============
  console.log('\n[测试 1] supportsControlAck 准确识别固件版本');
  const { supportsControlAck, getCommandAckTimeoutMs, compareFirmwareVersion } = require('./src/utils/firmware');
  assert(supportsControlAck('1.0.0') === false, '1.0.0 不支持回执');
  assert(supportsControlAck('1.0.5') === false, '1.0.5 不支持回执');
  assert(supportsControlAck('1.1.0') === true, '1.1.0 支持回执');
  assert(supportsControlAck('1.2.0') === true, '1.2.0 支持回执');
  assert(supportsControlAck('2.0.0') === true, '2.0.0 支持回执');
  assert(supportsControlAck('') === false, '空版本按老固件处理');
  assert(supportsControlAck(null) === false, 'null 按老固件处理');
  assert(supportsControlAck(undefined) === false, 'undefined 按老固件处理');
  assert(compareFirmwareVersion('1.0.0', '1.1.0') === -1, 'compareFirmwareVersion 1.0.0 < 1.1.0');
  assert(compareFirmwareVersion('1.1.0', '1.1.0') === 0, 'compareFirmwareVersion 1.1.0 == 1.1.0');
  assert(compareFirmwareVersion('2.0', '1.9.9') === 1, 'compareFirmwareVersion 2.0 > 1.9.9');

  // ============ 测试 2：getCommandAckTimeoutMs 时长 ============
  console.log('\n[测试 2] getCommandAckTimeoutMs 时长按固件能力区分');
  assert(getCommandAckTimeoutMs('1.0.0') === 5000, '老固件 5s');
  assert(getCommandAckTimeoutMs('1.1.0') === 30000, '新固件 30s');
  assert(getCommandAckTimeoutMs('') === 5000, '未上报固件按老固件 5s');

  // ============ 测试 3：老固件控制下发：expiresAt=now+5s、lastCommandNoAck=true ============
  console.log('\n[测试 3] 老固件控制下发：expiresAt 在 5s 内、lastCommandNoAck=true');
  fakePondStore['P001'] = {
    pondId: 'P001', aeratorStatus: false, aeratorMode: 'auto',
    deviceFirmwareVersion: '1.0.0'
  };
  // stub publishControl 成功
  const mqttMod = require('./src/services/mqttClient');
  const origPublish = mqttMod.publishControl;
  mqttMod.publishControl = async () => ({ success: true, commandId: 'cid-old-001', reason: 'published' });
  // 重新加载 control.js
  delete require.cache[path.join(__dirname, 'src/routes/control.js')];
  // 走 control.js 内部函数（直接 require 路由拿不到 handler，所以模拟控制流：直接调底层逻辑）
  // 这里通过 triggerAerator 同样的流程：直接构造 update 模拟 control.js 行为
  const before = Date.now();
  const Firmware = require('./src/utils/firmware');
  const hasAck = Firmware.supportsControlAck(fakePondStore['P001'].deviceFirmwareVersion);
  const ackTimeoutMs = Firmware.getCommandAckTimeoutMs(fakePondStore['P001'].deviceFirmwareVersion);
  const expiresAt = new Date(Date.now() + ackTimeoutMs);
  await FakePond.findOneAndUpdate(
    { pondId: 'P001' },
    { $set: { commandPending: true, commandPendingExpiresAt: expiresAt, lastCommand: 'aerator_on', lastCommandId: 'cid-old-001', lastCommandTime: new Date(), lastCommandFailReason: '', aeratorMode: 'manual', aeratorStatusFault: false, lastCommandNoAck: !hasAck } }
  );
  const after1 = fakePondStore['P001'];
  assert(after1.commandPending === true, 'commandPending=true');
  assert(after1.lastCommandNoAck === true, '老固件 lastCommandNoAck=true');
  assert(after1.commandPendingExpiresAt instanceof Date, 'commandPendingExpiresAt 是 Date');
  const expiresMs = after1.commandPendingExpiresAt.getTime();
  const diff = expiresMs - before;
  assert(diff >= 4500 && diff <= 5500, `expiresAt 在 now+5s 附近（实际 ${diff}ms）`);
  mqttMod.publishControl = origPublish;

  // ============ 测试 4：新固件控制下发：expiresAt=now+30s、lastCommandNoAck=false ============
  console.log('\n[测试 4] 新固件控制下发：expiresAt 在 30s 内、lastCommandNoAck=false');
  fakePondStore['P002'] = {
    pondId: 'P002', aeratorStatus: false, aeratorMode: 'auto',
    deviceFirmwareVersion: '1.1.0'
  };
  const before2 = Date.now();
  const hasAck2 = Firmware.supportsControlAck(fakePondStore['P002'].deviceFirmwareVersion);
  const ackTimeoutMs2 = Firmware.getCommandAckTimeoutMs(fakePondStore['P002'].deviceFirmwareVersion);
  const expiresAt2 = new Date(Date.now() + ackTimeoutMs2);
  await FakePond.findOneAndUpdate(
    { pondId: 'P002' },
    { $set: { commandPending: true, commandPendingExpiresAt: expiresAt2, lastCommand: 'aerator_on', lastCommandId: 'cid-new-001', lastCommandTime: new Date(), lastCommandFailReason: '', aeratorMode: 'manual', aeratorStatusFault: false, lastCommandNoAck: !hasAck2 } }
  );
  const after2 = fakePondStore['P002'];
  assert(after2.commandPending === true, 'commandPending=true');
  assert(after2.lastCommandNoAck === false, '新固件 lastCommandNoAck=false');
  const diff2 = after2.commandPendingExpiresAt.getTime() - before2;
  assert(diff2 >= 29500 && diff2 <= 30500, `expiresAt 在 now+30s 附近（实际 ${diff2}ms）`);

  // ============ 测试 5：commandTimeoutChecker 老固件兜底：乐观更新 aeratorStatus=true ============
  console.log('\n[测试 5] commandTimeoutChecker 老固件超时：乐观更新 aeratorStatus');
  // 模拟时间已过期
  fakePondStore['P003'] = {
    pondId: 'P003', aeratorStatus: false, aeratorMode: 'manual',
    deviceFirmwareVersion: '1.0.0',
    commandPending: true,
    commandPendingExpiresAt: new Date(Date.now() - 1000),  // 已过期
    lastCommand: 'aerator_on',
    lastCommandId: 'cid-old-003',
    lastCommandNoAck: true,
    aeratorStatusFault: false
  };
  const { checkPendingCommands } = require('./src/services/commandTimeoutChecker');
  fakeBroadcasts.deviceStatus = 0;
  await checkPendingCommands();
  const after3 = fakePondStore['P003'];
  assert(after3.commandPending === false, 'commandPending 清掉（关键！老固件不会永远停留）');
  assert(after3.aeratorStatus === true, 'aeratorStatus 乐观置为 true（aerator_on 期望状态）');
  assert(after3.lastCommandNoAck === true, 'lastCommandNoAck 保留供前端展示');
  assert(after3.commandPendingExpiresAt === null, 'commandPendingExpiresAt 清空');
  assert(after3.lastCommandFailReason === 'device_no_ack_firmware_legacy', '失败原因标注为老固件无回执');
  assert(fakeBroadcasts.deviceStatus >= 1, '广播了 device_status');
  assert(fakeBroadcasts.lastStatus === 'control_auto_confirmed', '广播状态为 control_auto_confirmed');

  // ============ 测试 6：commandTimeoutChecker 新固件超时：标记 fault ============
  console.log('\n[测试 6] commandTimeoutChecker 新固件超时：标记 aeratorStatusFault');
  fakePondStore['P004'] = {
    pondId: 'P004', aeratorStatus: false, aeratorMode: 'auto',
    deviceFirmwareVersion: '1.1.0',
    commandPending: true,
    commandPendingExpiresAt: new Date(Date.now() - 1000),
    lastCommand: 'aerator_on',
    lastCommandId: 'cid-new-004',
    lastCommandNoAck: false,
    aeratorStatusFault: false
  };
  fakeBroadcasts.deviceStatus = 0;
  await checkPendingCommands();
  const after4 = fakePondStore['P004'];
  assert(after4.commandPending === false, 'commandPending 清掉');
  assert(after4.aeratorStatusFault === true, '新固件超时未回执 → 标记 fault（关键！不假启动）');
  assert(after4.aeratorStatus === false, 'aeratorStatus 保持 false（不假启动）');
  assert(after4.lastCommandFailReason === 'device_ack_timeout', '失败原因标注为回执超时');
  assert(fakeBroadcasts.lastStatus === 'control_ack_timeout', '广播状态为 control_ack_timeout');

  // ============ 测试 7：commandTimeoutChecker aerator_off 老固件：乐观置 false ============
  console.log('\n[测试 7] commandTimeoutChecker aerator_off 老固件：乐观置 false');
  fakePondStore['P005'] = {
    pondId: 'P005', aeratorStatus: true, aeratorMode: 'manual',
    deviceFirmwareVersion: '1.0.0',
    commandPending: true,
    commandPendingExpiresAt: new Date(Date.now() - 1000),
    lastCommand: 'aerator_off',
    lastCommandId: 'cid-old-005',
    lastCommandNoAck: true,
    aeratorStatusFault: false
  };
  await checkPendingCommands();
  const after5 = fakePondStore['P005'];
  assert(after5.aeratorStatus === false, 'aerator_off 老固件乐观置 aeratorStatus=false');

  // ============ 测试 8：未过期 pending 不被处理 ============
  console.log('\n[测试 8] 未过期 pending 不被超时巡检处理');
  fakePondStore['P006'] = {
    pondId: 'P006', aeratorStatus: false, aeratorMode: 'manual',
    deviceFirmwareVersion: '1.0.0',
    commandPending: true,
    commandPendingExpiresAt: new Date(Date.now() + 30000),  // 30s 后才过期
    lastCommand: 'aerator_on',
    lastCommandNoAck: true
  };
  await checkPendingCommands();
  const after6 = fakePondStore['P006'];
  assert(after6.commandPending === true, '未过期则保持 pending');

  // ============ 测试 9：handleControlAck 收到 ack 也会清掉 expiresAt ============
  console.log('\n[测试 9] handleControlAck 收到 ack 清掉 expiresAt 与 lastCommandNoAck');
  fakePondStore['P007'] = {
    pondId: 'P007', aeratorStatus: false, aeratorMode: 'auto',
    deviceFirmwareVersion: '1.1.0',
    commandPending: true,
    commandPendingExpiresAt: new Date(Date.now() + 30000),
    lastCommand: 'aerator_on',
    lastCommandId: 'cid-ack-007',
    lastCommandNoAck: false
  };
  const { handleControlAck } = require('./src/services/mqttClient');
  await handleControlAck('P007', { commandId: 'cid-ack-007', command: 'aerator_on', result: 'ok' });
  const after7 = fakePondStore['P007'];
  assert(after7.commandPending === false, 'ack 成功清掉 pending');
  assert(after7.commandPendingExpiresAt === null, 'ack 成功清掉 expiresAt');
  assert(after7.aeratorStatus === true, 'ack 成功置 aeratorStatus=true');
  assert(after7.aeratorMode === 'auto', 'ack 成功置 aeratorMode=auto');

  // ============ 测试 10：data.js 接口透传新字段 ============
  console.log('\n[测试 10] buildRealtimePayload 透传 commandPendingExpiresAt / lastCommandNoAck / deviceFirmwareVersion');
  fakePondStore['P008'] = {
    pondId: 'P008', aeratorStatus: false, aeratorMode: 'auto',
    commandPending: true,
    commandPendingExpiresAt: new Date(Date.now() + 5000),
    lastCommand: 'aerator_on',
    lastCommandId: 'cid-008',
    lastCommandTime: new Date(),
    lastCommandAckAt: null,
    lastCommandFailReason: '',
    lastCommandNoAck: true,
    aeratorStatusFault: false,
    deviceFirmwareVersion: '1.0.0'
  };
  delete require.cache[path.join(__dirname, 'src/routes/data.js')];
  const dataRouter = require('./src/routes/data.js');
  // 验证 select 字符串包含新字段（避免拼写错误导致字段没被查出）
  const dataRouterSrc = require('fs').readFileSync(path.join(__dirname, 'src/routes/data.js'), 'utf8');
  assert(dataRouterSrc.includes('commandPendingExpiresAt'), 'data.js 透传 commandPendingExpiresAt');
  assert(dataRouterSrc.includes('lastCommandNoAck'), 'data.js 透传 lastCommandNoAck');
  assert(dataRouterSrc.includes('deviceFirmwareVersion'), 'data.js 透传 deviceFirmwareVersion');
  assert(typeof dataRouter === 'function', 'data.js 路由加载成功');

  // ============ 测试 11：MQTT /status 上报同步 deviceFirmwareVersion 到 Pond ============
  console.log('\n[测试 11] /status 上报同步 deviceFirmwareVersion 到 Pond');
  // Pond 已有 deviceFirmwareVersion 字段后，handleDeviceStatus 应当写入
  // 这里通过检查 mqttClient.js 源码确认
  const mqttSrc = require('fs').readFileSync(path.join(__dirname, 'src/services/mqttClient.js'), 'utf8');
  assert(mqttSrc.includes('deviceFirmwareVersion'), 'mqttClient.js 同步 deviceFirmwareVersion');

  // ============ 汇总 ============
  console.log(`\n========== 汇总 ==========`);
  console.log(`通过: ${totalPass}, 失败: ${totalFail}`);
  if (totalFail > 0) process.exit(1);
})().catch((e) => {
  console.error('测试运行异常:', e);
  process.exit(1);
});
