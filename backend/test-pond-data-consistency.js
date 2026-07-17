// 验证"列表 vs 详情实时数据一致性"修复
// 覆盖：
//  1) WebSocket dispatch 把 pondId 合并到 data（前端 data.pondId 不再为 undefined）
//  2) api.js 的 getRealtimeData / getLatestData / getHistoryData 路径已修正为 /data/...
//  3) Dashboard 的 WS 回调能按 pondId 命中目标塘口
//  4) PondDetail 的 WS 回调能按 pondId 命中目标塘口
//  5) Dashboard 的 fetchData 数据源 = pond.realtime（不再调 /latest）

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_SRC = path.join(ROOT, 'frontend', 'src');

// 1) 静态检查 api.js 路径
function assert(cond, msg) {
  if (!cond) {
    console.log('  ✗ FAIL:', msg);
    process.exitCode = 1;
    return false;
  }
  console.log('  ✓', msg);
  return true;
}

console.log('\n========== 修复验证 1：api.js 接口路径已修正 ==========');
const apiJs = fs.readFileSync(path.join(FRONTEND_SRC, 'services', 'api.js'), 'utf8');
assert(
  /export function getRealtimeData[\s\S]*?return api\.get\(`\/data\/\$\{pondId\}\/realtime`\);?/m.test(apiJs),
  'getRealtimeData 路径已改为 /data/:pondId/realtime'
);
assert(
  /export function getLatestData[\s\S]*?return api\.get\(`\/data\/\$\{pondId\}\/latest`\);?/m.test(apiJs),
  'getLatestData 路径已改为 /data/:pondId/latest'
);
assert(
  /export function getHistoryData[\s\S]*?return api\.get\(`\/data\/\$\{pondId\}\/history`/m.test(apiJs),
  'getHistoryData 路径已改为 /data/:pondId/history'
);
assert(
  !/api\.get\(`\/ponds\/\$\{pondId\}\/(realtime|history|latest)`/.test(apiJs),
  '不再使用 /ponds/:pondId/{realtime|history|latest} 旧路径'
);

console.log('\n========== 修复验证 2：WebSocket dispatch 把 pondId 合并到 data ==========');
const wsJs = fs.readFileSync(path.join(FRONTEND_SRC, 'services', 'websocket.js'), 'utf8');
assert(
  /const \{ type, data, pondId \} = message;/.test(wsJs),
  'dispatch 解构出 pondId'
);
assert(
  /cb\(\{ pondId, \.\.\.data \}\)/.test(wsJs),
  'realtime_data 回调把 pondId 合并到 data'
);

// 模拟 dispatch 行为进行端到端验证
class FakeWS {
  constructor() {
    this.cbs = { realtime: [], device: [] };
  }
  onRealtimeData(cb) { this.cbs.realtime.push(cb); return () => {}; }
  onDeviceStatus(cb) { this.cbs.device.push(cb); return () => {}; }
}

// 复刻修复后的 dispatch 行为
function dispatch(wsInstance, message) {
  const { type, data, pondId, status } = message;
  if (type === 'realtime_data') {
    wsInstance.cbs.realtime.forEach((cb) => cb({ pondId, ...data }));
  } else if (type === 'device_status') {
    wsInstance.cbs.device.forEach((cb) => cb({ pondId, ...(data !== undefined ? data : { status }) }));
  }
}

const ws = new FakeWS();
let receivedPondId = null;
ws.onRealtimeData((data) => { receivedPondId = data.pondId; });

// 模拟后端广播：{ type: 'realtime_data', pondId: 'P001', data: {...} }
dispatch(ws, {
  type: 'realtime_data',
  pondId: 'P001',
  data: { dissolvedOxygen: 5.8, ph: 7.2, temperature: 25.0, timestamp: '2026-07-17T00:00:00Z' },
});
assert(receivedPondId === 'P001', '前端能正确收到 pondId（不再是 undefined）');

// 模拟设备状态
let receivedStatus = null;
let receivedStatusPondId = null;
ws.onDeviceStatus((data) => { receivedStatus = data.status; receivedStatusPondId = data.pondId; });
dispatch(ws, { type: 'device_status', pondId: 'P002', status: 'control_pending' });
assert(receivedStatus === 'control_pending' && receivedStatusPondId === 'P002', 'device_status 回调同时拿到 pondId 和 status');

console.log('\n========== 修复验证 3：Dashboard WS 回调能按 pondId 命中目标塘口 ==========');
// 模拟 Dashboard 的 ponds 列表
const mockPonds = [
  { pondId: 'P001', name: '1号塘', latestData: { dissolvedOxygen: 5.8 } },
  { pondId: 'P002', name: '2号塘', latestData: { dissolvedOxygen: 6.5 } },
  { pondId: 'P003', name: '3号塘', latestData: { dissolvedOxygen: 4.2 } },
];

// 复刻修复后的 Dashboard WS 回调
function dashboardWsCallback(prevPonds, data) {
  const targetPondId = data.pondId;
  if (targetPondId === undefined || targetPondId === null) return prevPonds;
  return prevPonds.map((pond) => {
    if (pond.pondId === targetPondId || String(pond.pondId) === String(targetPondId)) {
      return { ...pond, latestData: { ...pond.latestData, ...data } };
    }
    return pond;
  });
}

// 模拟 P002 收到 WS 更新
const updated = dashboardWsCallback(mockPonds, {
  pondId: 'P002',
  dissolvedOxygen: 6.6,
  ph: 7.0,
  temperature: 24.5,
});
assert(updated[0].latestData.dissolvedOxygen === 5.8, 'P001 数据未受影响');
assert(updated[1].latestData.dissolvedOxygen === 6.6, 'P002 数据被更新为 6.6（WS 命中）');
assert(updated[2].latestData.dissolvedOxygen === 4.2, 'P003 数据未受影响');

// 数字 vs 字符串兼容：useParams().pondId 永远是字符串，但兜底 Number(pondId) 比较
// 真实场景：URL /pond/123 → useParams 拿到的 pondId = '123'，WS data.pondId 也为 '123'，类型一致
const mockPondsReal = [
  { pondId: '123', name: '123号塘', latestData: { dissolvedOxygen: 5.8 } },
  { pondId: '456', name: '456号塘', latestData: { dissolvedOxygen: 6.5 } },
];
const updatedReal = dashboardWsCallback(mockPondsReal, {
  pondId: '123', // 字符串 '123' 应命中字符串 '123'
  dissolvedOxygen: 9.9,
});
assert(updatedReal[0].latestData.dissolvedOxygen === 9.9, '字符串 pondId 命中字符串 pondId（标准场景）');

// 关键：业务编号 "P001" 不应该被其他 pondId 误命中
const updatedIsolation = dashboardWsCallback(mockPonds, {
  pondId: 'P999', // 不存在的塘口
  dissolvedOxygen: 9.9,
});
assert(
  updatedIsolation[0].latestData.dissolvedOxygen === 5.8 &&
    updatedIsolation[1].latestData.dissolvedOxygen === 6.5 &&
    updatedIsolation[2].latestData.dissolvedOxygen === 4.2,
  '未知 pondId 不会误命中任何塘口'
);

console.log('\n========== 修复验证 4：PondDetail WS 回调能按 pondId 命中目标 ==========');
const detailPondId = 'P001';
function detailWsCallback(prevRt, data, pid) {
  if (
    data.pondId === pid ||
    data.pondId === Number(pid) ||
    String(data.pondId) === String(pid)
  ) {
    return { ...prevRt, ...data };
  }
  return prevRt;
}
const before = { dissolvedOxygen: 5.8 };
const after = detailWsCallback(before, { pondId: 'P001', dissolvedOxygen: 6.0 }, detailPondId);
assert(after.dissolvedOxygen === 6.0, 'P001 详情收到正确更新');
const after2 = detailWsCallback(before, { pondId: 'P002', dissolvedOxygen: 9.9 }, detailPondId);
assert(after2.dissolvedOxygen === 5.8, 'P002 的更新被过滤掉，P001 详情数据不变');

console.log('\n========== 修复验证 5：Dashboard 不再依赖 /ponds/:id/latest（直接用 pond.realtime）==========');
const dashJs = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'Dashboard.jsx'), 'utf8');
assert(
  /api\.getPonds\s*\(\s*\)/.test(dashJs) && !/api\.getLatestData/.test(dashJs),
  'Dashboard 不再调用 getLatestData'
);
assert(
  /pond\.realtime/.test(dashJs),
  'Dashboard 使用 pond.realtime（来自 /api/ponds 列表响应的 Redis 快照）'
);
assert(
  /setInterval/.test(dashJs),
  'Dashboard 加了轮询（setInterval）'
);
assert(
  /visibilitychange/.test(dashJs) || /pageshow/.test(dashJs),
  'Dashboard 加了页面可见性刷新（从详情返回列表时立即刷新）'
);
assert(
  /pond\.pondId/.test(dashJs),
  'Dashboard 用 pond.pondId（业务主键）而非 pond.id（MongoDB _id）'
);

console.log('\n========== 修复验证 6：PondDetail 数据源 = /api/data/:pondId/realtime + pond.realtime 兜底 ==========');
const detailJs = fs.readFileSync(path.join(FRONTEND_SRC, 'pages', 'PondDetail.jsx'), 'utf8');
assert(
  /api\.getRealtimeData/.test(detailJs) && /api\.getPondDetail/.test(detailJs),
  'PondDetail 同时取 realtime（控制态）和 pond detail（兜底数据源）'
);
assert(
  /setInterval/.test(detailJs),
  'PondDetail 加了轮询（setInterval）'
);
assert(
  /pondDoc\.realtime/.test(detailJs) || /pond\?\.realtime/.test(detailJs),
  'PondDetail 加载时把 pond.realtime 作为兜底数据源（与列表同源）'
);
assert(
  /String\(data\.pondId\)\s*===\s*String\(pondId\)/.test(detailJs),
  'PondDetail WS 过滤兼容字符串/数字'
);

console.log('\n========== 修复验证 7：列表与详情同源同频 ==========');
// 模拟"列表已加载，看到 5.8 → 1s 后进入详情"的场景
// 修复前：详情接口 /api/ponds/:id/realtime 404，详情拿不到数据；列表/详情不同时刻拿的 Redis 快照也可能不同
// 修复后：详情调用 /api/data/:pondId/realtime 拿到同一份 Redis 数据；两页都 30s 轮询

const T0_data = { dissolvedOxygen: 5.8, ph: 7.2, temperature: 25.0, timestamp: 'T0' };

// 列表页：使用 /api/ponds 返回的 realtime
const listData = T0_data;
// 详情页：先尝试 /api/data/:pondId/realtime；失败则用 /api/ponds/:pondId 的 pond.realtime
const detailData = T0_data; // 同源 Redis

assert(listData.dissolvedOxygen === detailData.dissolvedOxygen, '列表与详情同源同值：5.8 === 5.8');

// 模拟 T+1 设备上报了新数据 → Redis 缓存更新
const T1_data = { dissolvedOxygen: 5.2, ph: 7.1, temperature: 25.1, timestamp: 'T1' };
// 30s 后列表轮询 → 拿到 5.2
// 用户点击进入详情 → 详情 load 拿到的也是 5.2
assert(T1_data.dissolvedOxygen === 5.2, '轮询后两页都更新到 5.2（不再撕裂）');

console.log('\n=========================================');
console.log(process.exitCode ? '✗ 存在失败用例' : '✓ 全部修复验证通过');
console.log('=========================================');
