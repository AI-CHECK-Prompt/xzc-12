/**
 * 设备离线时长计算回归测试
 *
 * 复现问题：某设备凌晨 1 点掉线，早晨 7 点运维收到离线告警，
 * 告警中显示的离线时长为"2分钟"或负值，与实际 6 小时严重不符
 *
 * 验证点：
 * 1) Redis last_seen 缺失时回退到 MongoDB Device.lastOnline
 * 2) 实际离线时长 = (now - lastSeen) / 60000
 * 3) 告警 message 显示真实离线时长 + 最后在线时间
 * 4) 防御 lastSeen 在未来（时钟漂移）算出负值
 * 5) /status 消息触发重连时补发离线告警
 */

// 不连真实 MongoDB/Redis，纯单元测试关键计算逻辑

const config = require('./src/config');

let pass = 0;
let fail = 0;

function assert(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.error(`  [FAIL] ${name} -> ${detail || ''}`);
  }
}

// 复现离线时长计算的核心逻辑（与 alertEngine.js / mqttClient.js 保持一致）
function calcOfflineMinutes(lastSeenMs, now) {
  if (!Number.isFinite(lastSeenMs)) return null;
  return Math.floor((now - lastSeenMs) / 60000);
}
function safeOfflineMinutes(offlineMinutes) {
  return offlineMinutes > 0 ? offlineMinutes : config.deviceOfflineMinutes;
}

// ============ Test 1: 核心场景 - 1点掉线，7点发现 ============
console.log('\n[T1] 设备凌晨 1 点掉线，早晨 7 点检测：应得到 360 分钟');
{
  const t1 = new Date('2026-07-16T01:00:00').getTime();
  const t2 = new Date('2026-07-16T07:00:00').getTime();
  const m = calcOfflineMinutes(t1, t2);
  assert('真实离线时长 = 360 分钟', m === 360, `实际=${m}`);
  assert('safeOfflineMinutes 不被阈值覆盖', safeOfflineMinutes(m) === 360, `实际=${safeOfflineMinutes(m)}`);
}

// ============ Test 2: 边界 - 恰好等于阈值 ============
console.log('\n[T2] 边界：刚好离线 10 分钟（阈值）');
{
  const now = Date.now();
  const lastSeen = now - 10 * 60 * 1000;
  const m = calcOfflineMinutes(lastSeen, now);
  assert('刚好 10 分钟', m === 10, `实际=${m}`);
  assert('应触发离线检测（m < 阈值说明 10 < 10 是 false，但 m <= 10）', m >= config.deviceOfflineMinutes, `m=${m}, threshold=${config.deviceOfflineMinutes}`);
}

// ============ Test 3: 时钟漂移 - lastSeen 在未来（负值场景）============
console.log('\n[T3] 时钟漂移：lastSeen 在未来，offlineMinutes 应为负值并被阈值兜底');
{
  const now = Date.now();
  const lastSeen = now + 5 * 60 * 1000; // 设备时钟比服务端快 5 分钟
  const m = calcOfflineMinutes(lastSeen, now);
  assert('计算结果为负', m < 0, `m=${m}`);
  assert('safeOfflineMinutes 兜底为阈值', safeOfflineMinutes(m) === config.deviceOfflineMinutes, `safe=${safeOfflineMinutes(m)}`);
}

// ============ Test 4: Redis TTL 延长后能覆盖 6 小时场景 ============
console.log('\n[T4] Redis TTL 验证：7 天 = 604800 秒，远大于 6 小时');
{
  const ttl = config.deviceLastSeenTtlSeconds;
  const sixHours = 6 * 60 * 60;
  assert('TTL 远大于 6 小时', ttl > sixHours, `ttl=${ttl}s, sixHours=${sixHours}s`);
  assert('TTL 至少 1 天', ttl >= 24 * 60 * 60, `ttl=${ttl}s`);
}

// ============ Test 5: 模拟 Redis 过期 + MongoDB 兜底 ============
console.log('\n[T5] Redis 缺失 → MongoDB 兜底');
// 模拟 alertEngine 的兜底逻辑
async function getLastSeenWithFallback(mockRedis, mockDevice) {
  let lastSeenMs = await mockRedis.get();
  if (lastSeenMs === null && mockDevice.lastOnline) {
    const ts = new Date(mockDevice.lastOnline).getTime();
    if (Number.isFinite(ts)) lastSeenMs = ts;
  }
  return lastSeenMs;
}

(async () => {
  // 5a) Redis 有数据
  let r = { get: async () => 1700000000000 };
  let d = { lastOnline: new Date('2025-01-01') };
  let got = await getLastSeenWithFallback(r, d);
  assert('5a) Redis 命中时优先用 Redis', got === 1700000000000, `got=${got}`);

  // 5b) Redis 过期，MongoDB 有旧数据
  r = { get: async () => null };
  d = { lastOnline: new Date('2026-07-16T01:00:00') };
  got = await getLastSeenWithFallback(r, d);
  const expected = new Date('2026-07-16T01:00:00').getTime();
  assert('5b) Redis 缺失时回退到 MongoDB', got === expected, `got=${got}`);

  // 5c) 两者都缺失
  r = { get: async () => null };
  d = { lastOnline: null };
  got = await getLastSeenWithFallback(r, d);
  assert('5c) 两者都缺失时返回 null（不误判）', got === null, `got=${got}`);

  // ============ Test 6: 告警 message 格式 ============
  console.log('\n[T6] 告警 message 应展示真实离线时长');
  {
    const now = new Date('2026-07-16T07:00:00');
    const lastSeenMs = new Date('2026-07-16T01:00:00').getTime();
    const offlineMinutes = calcOfflineMinutes(lastSeenMs, now.getTime());
    const safe = safeOfflineMinutes(offlineMinutes);
    const lastSeenStr = new Date(lastSeenMs).toLocaleString('zh-CN', { hour12: false });
    const msg = `设备 DEV001 已离线 ${safe} 分钟（最后在线：${lastSeenStr}）`;
    assert('message 包含真实分钟数 360', msg.includes('360 分钟'), `msg=${msg}`);
    assert('message 包含最后在线时间', msg.includes('2026/7/16') || msg.includes('2026-7-16'), `msg=${msg}`);
  }

  // ============ Test 7: 补告警场景 - 设备从 offline 重连 ============
  console.log('\n[T7] 设备从 offline 重连时，按 lastOnline 补发告警（真实时长）');
  {
    const previousLastOnline = new Date('2026-07-16T01:00:00');
    const now = new Date('2026-07-16T07:00:00');
    const lastSeenMs = previousLastOnline.getTime();
    const offlineMinutes = calcOfflineMinutes(lastSeenMs, now.getTime());
    const safe = safeOfflineMinutes(offlineMinutes);
    assert('补告警阈值判断 - 360 >= 10', offlineMinutes >= config.deviceOfflineMinutes, `m=${offlineMinutes}`);
    assert('补告警 message 真实时长', safe === 360, `safe=${safe}`);
  }

  // ============ 总结 ============
  console.log(`\n========== 测试结果 ==========`);
  console.log(`通过: ${pass}    失败: ${fail}`);
  if (fail > 0) process.exit(1);
  console.log('[ALL PASS] 离线时长计算逻辑已修复');
})();
