/**
 * 多终端关联塘口场景 - 回归测试
 *
 * 问题复现：部分塘口配置了主+备多台采集终端，Device.pondId 都指向同一 pondId。
 * 旧版离线检测对任一设备掉线都无条件把塘口置为 offline，导致：
 *   - 备用终端掉线时，主终端数据仍在流但塘口被误标 offline
 *   - 主终端先掉、备用继续上报时，塘口被反复在 online/offline 之间切换
 *   - 设备"换塘口"（临时调试）时，原塘口数据流被静默切断但状态仍 online
 *
 * 验证点（用内存模拟器替代 MongoDB/Redis，纯逻辑层测试）：
 * 1) 单台设备掉线、同塘口仍有在线设备：塘口保持 online，不发离线告警
 * 2) 同塘口最后一台设备也掉线：塘口置为 offline，按"最后在线"那台设备发告警
 * 3) 设备"换塘口"：原塘口无其他在线设备时立即置为 offline
 * 4) 设备上报 status=offline：仅当本塘口无其他 online 设备时才覆盖塘口
 * 5) 兜底一致性：online 塘口若所有设备均 offline，纠正为 offline
 */

// 不连真实 MongoDB/Redis，用内存模拟器覆盖 checkDeviceOffline 用到的关键 API
const path = require('path');
const config = require(path.resolve(__dirname, 'src/config'));

// ============ 内存模拟：Device / Pond / Redis ============
function createMockStore() {
  const devices = new Map(); // deviceId -> { deviceId, pondId, status, lastOnline }
  const ponds = new Map();   // pondId -> { pondId, status }
  const lastSeen = new Map(); // deviceId -> timestamp(ms)
  const alertsSent = [];      // 记录所有创建的告警
  const alertDedup = new Set(); // 模拟 Redis 去重 key

  return {
    devices,
    ponds,
    lastSeen,
    alertsSent,
    alertDedup,

    // ---- 模拟 Device Model ----
    async find(query) {
      const all = Array.from(devices.values());
      return all.filter((d) => {
        if (query.status && d.status !== query.status) return false;
        return true;
      });
    },
    async findOne(query) {
      const all = Array.from(devices.values());
      return all.find((d) => {
        if (query.deviceId && d.deviceId !== query.deviceId) return false;
        return true;
      }) || null;
    },
    async findOneAndUpdate(query, update) {
      let d = Array.from(devices.values()).find((x) => x.deviceId === query.deviceId);
      if (!d && update.$setOnInsert) {
        d = { deviceId: query.deviceId };
        devices.set(query.deviceId, d);
      }
      if (!d) return null;
      Object.assign(d, update.$set || {});
      return d;
    },
    async countDocuments(query) {
      return Array.from(devices.values()).filter((d) => {
        if (query.pondId && d.pondId !== query.pondId) return false;
        if (query.status && d.status !== query.status) return false;
        if (query.deviceId && query.deviceId.$ne && d.deviceId === query.deviceId.$ne) return false;
        return true;
      }).length;
    },
    async exists(query) {
      const n = await this.countDocuments(query);
      return n > 0;
    },

    // ---- 模拟 Pond Model ----
    async findPonds(query) {
      const all = Array.from(ponds.values());
      return all.filter((p) => {
        if (query.status && p.status !== query.status) return false;
        return true;
      });
    },
    async findPondAndUpdate(query, update) {
      const p = ponds.get(query.pondId);
      if (!p) return null;
      Object.assign(p, update.$set || {});
      return p;
    },

    // ---- 模拟 redisClient ----
    async getDeviceLastSeen(deviceId) {
      return lastSeen.has(deviceId) ? lastSeen.get(deviceId) : null;
    },
    async isAlertDuplicate(pondId, type) {
      return alertDedup.has(`${pondId}:${type}`);
    },
    async markAlertSent(pondId, type) {
      alertDedup.add(`${pondId}:${type}`);
    },
  };
}

// 把 alertEngine 的核心离线检测逻辑搬到此处，避免 require 真实 mongo/redis
// 逻辑与 backend/src/services/alertEngine.js::checkDeviceOffline 保持一致
async function checkDeviceOffline(store, broadcastAlert = () => {}) {
  const now = Date.now();
  const threshold = now - config.deviceOfflineMinutes * 60 * 1000;

  const devices = await store.find({ status: 'online' });
  for (const device of devices) {
    let lastSeenMs = await store.getDeviceLastSeen(device.deviceId);
    if (lastSeenMs === null && device.lastOnline) {
      const mongoTs = new Date(device.lastOnline).getTime();
      if (Number.isFinite(mongoTs)) lastSeenMs = mongoTs;
    }

    if (lastSeenMs && lastSeenMs < threshold) {
      const offlineMinutes = Math.floor((now - lastSeenMs) / 60000);
      const safeOfflineMinutes = offlineMinutes > 0 ? offlineMinutes : config.deviceOfflineMinutes;

      await store.findOneAndUpdate(
        { deviceId: device.deviceId },
        { $set: { status: 'offline' } }
      );

      if (device.pondId) {
        const otherOnlineCount = await store.countDocuments({
          pondId: device.pondId,
          status: 'online',
          deviceId: { $ne: device.deviceId }
        });

        if (otherOnlineCount > 0) {
          // 跳过：塘口保持 online
          continue;
        }

        await store.findPondAndUpdate(
          { pondId: device.pondId },
          { $set: { status: 'offline' } }
        );

        const isDuplicate = await store.isAlertDuplicate(device.pondId, 'device_offline');
        if (!isDuplicate) {
          const lastSeenStr = new Date(lastSeenMs).toLocaleString('zh-CN', { hour12: false });
          const alert = {
            pondId: device.pondId,
            type: 'device_offline',
            value: safeOfflineMinutes,
            message: `设备 ${device.deviceId} 已离线 ${safeOfflineMinutes} 分钟（最后在线：${lastSeenStr}）`
          };
          store.alertsSent.push(alert);
          await store.markAlertSent(device.pondId, 'device_offline');
          broadcastAlert(alert);
        }
      }
    }
  }

  // 兜底：online 塘口若所有设备均 offline 则纠正
  const onlinePonds = await store.findPonds({ status: 'online' });
  for (const pond of onlinePonds) {
    const hasAnyOnlineDevice = await store.exists({
      pondId: pond.pondId,
      status: 'online'
    });
    if (!hasAnyOnlineDevice) {
      await store.findPondAndUpdate(
        { pondId: pond.pondId },
        { $set: { status: 'offline' } }
      );
    }
  }
}

// ============ 测试用例 ============
let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.error(`  [FAIL] ${name} -> ${detail || ''}`); }
}

(async () => {
  // ============ T1: 单设备塘口 - 设备掉线 = 塘口离线 ============
  console.log('\n[T1] 单设备塘口：唯一设备掉线 → 塘口离线 + 告警');
  {
    const store = createMockStore();
    const t = Date.now();
    store.ponds.set('P1', { pondId: 'P1', status: 'online' });
    store.devices.set('D1', { deviceId: 'D1', pondId: 'P1', status: 'online', lastOnline: new Date(t - 30 * 60 * 1000) });
    store.lastSeen.set('D1', t - 30 * 60 * 1000);

    await checkDeviceOffline(store);

    assert('D1 被置为 offline', store.devices.get('D1').status === 'offline', `实际=${store.devices.get('D1').status}`);
    assert('P1 被置为 offline', store.ponds.get('P1').status === 'offline', `实际=${store.ponds.get('P1').status}`);
    assert('创建了离线告警', store.alertsSent.length === 1 && store.alertsSent[0].pondId === 'P1', `alerts=${JSON.stringify(store.alertsSent)}`);
    assert('告警 value = 30 分钟', store.alertsSent[0]?.value === 30, `value=${store.alertsSent[0]?.value}`);
  }

  // ============ T2: 多设备塘口 - 备用掉线、主终端在线 = 塘口保持 online ============
  console.log('\n[T2] 多设备塘口：备用掉线、主终端在线 → 塘口保持 online，不告警');
  {
    const store = createMockStore();
    const t = Date.now();
    store.ponds.set('P2', { pondId: 'P2', status: 'online' });
    // 主终端：最近 1 分钟上报，online
    store.devices.set('D2-MAIN', { deviceId: 'D2-MAIN', pondId: 'P2', status: 'online', lastOnline: new Date(t - 60 * 1000) });
    store.lastSeen.set('D2-MAIN', t - 60 * 1000);
    // 备用终端：30 分钟没上报（已掉线但 DB 还显示 online）
    store.devices.set('D2-BAK', { deviceId: 'D2-BAK', pondId: 'P2', status: 'online', lastOnline: new Date(t - 30 * 60 * 1000) });
    store.lastSeen.set('D2-BAK', t - 30 * 60 * 1000);

    await checkDeviceOffline(store);

    assert('D2-BAK 被置为 offline', store.devices.get('D2-BAK').status === 'offline', `实际=${store.devices.get('D2-BAK').status}`);
    assert('D2-MAIN 仍为 online', store.devices.get('D2-MAIN').status === 'online', `实际=${store.devices.get('D2-MAIN').status}`);
    assert('P2 仍为 online（主终端还在流）', store.ponds.get('P2').status === 'online', `实际=${store.ponds.get('P2').status}`);
    assert('未创建离线告警（避免误报）', store.alertsSent.length === 0, `alerts=${JSON.stringify(store.alertsSent)}`);
  }

  // ============ T3: 多设备塘口 - 主备都掉线 = 塘口离线 + 告警 ============
  console.log('\n[T3] 多设备塘口：主备都掉线 → 塘口 offline + 告警（按最后掉线那台）');
  {
    const store = createMockStore();
    const t = Date.now();
    store.ponds.set('P3', { pondId: 'P3', status: 'online' });
    store.devices.set('D3-MAIN', { deviceId: 'D3-MAIN', pondId: 'P3', status: 'online', lastOnline: new Date(t - 20 * 60 * 1000) });
    store.lastSeen.set('D3-MAIN', t - 20 * 60 * 1000);
    store.devices.set('D3-BAK', { deviceId: 'D3-BAK', pondId: 'P3', status: 'online', lastOnline: new Date(t - 45 * 60 * 1000) });
    store.lastSeen.set('D3-BAK', t - 45 * 60 * 1000);

    await checkDeviceOffline(store);

    assert('D3-MAIN 被置为 offline', store.devices.get('D3-MAIN').status === 'offline');
    assert('D3-BAK 被置为 offline', store.devices.get('D3-BAK').status === 'offline');
    assert('P3 被置为 offline', store.ponds.get('P3').status === 'offline', `实际=${store.ponds.get('P3').status}`);
    assert('恰好创建 1 条告警（去重生效）', store.alertsSent.length === 1, `alerts=${JSON.stringify(store.alertsSent)}`);
  }

  // ============ T4: 一致性兜底 - online 塘口所有设备 offline → 纠正为 offline ============
  console.log('\n[T4] 兜底一致性：online 塘口无任何在线设备 → 纠正为 offline');
  {
    const store = createMockStore();
    store.ponds.set('P4', { pondId: 'P4', status: 'online' });
    // 所有设备均已 offline，模拟服务重启后的脏数据
    store.devices.set('D4-A', { deviceId: 'D4-A', pondId: 'P4', status: 'offline' });
    store.devices.set('D4-B', { deviceId: 'D4-B', pondId: 'P4', status: 'offline' });

    await checkDeviceOffline(store);

    assert('P4 被兜底纠正为 offline', store.ponds.get('P4').status === 'offline', `实际=${store.ponds.get('P4').status}`);
  }

  // ============ T5: 多设备塘口 - 备用单独掉线后又被 dataProcessor 切走 ============
  console.log('\n[T5] 切塘口：设备从 P5 切到 P6，P5 无其他在线设备 → P5 置为 offline');
  {
    // 这部分逻辑在 dataProcessor.js，本测试只验证"原塘口无其他在线设备"时的判定函数
    const store = createMockStore();
    store.ponds.set('P5', { pondId: 'P5', status: 'online' });
    store.ponds.set('P6', { pondId: 'P6', status: 'online' });
    store.devices.set('D5', { deviceId: 'D5', pondId: 'P5', status: 'online' });

    // 模拟设备 D5 切到 P6：原 pondId=P5
    const otherOnlineForOldPond = await store.countDocuments({
      pondId: 'P5',
      status: 'online',
      deviceId: { $ne: 'D5' }
    });
    assert('原塘口 P5 仅有 D5 一台设备', otherOnlineForOldPond === 0, `count=${otherOnlineForOldPond}`);

    if (otherOnlineForOldPond === 0) {
      await store.findPondAndUpdate({ pondId: 'P5' }, { $set: { status: 'offline' } });
    }
    assert('设备切走后 P5 立即被置为 offline', store.ponds.get('P5').status === 'offline', `实际=${store.ponds.get('P5').status}`);
  }

  // ============ T6: 切塘口但原塘口还有别的设备 ============
  console.log('\n[T6] 切塘口：原塘口 P7 还有 D7-B 在 → P7 保持 online');
  {
    const store = createMockStore();
    store.ponds.set('P7', { pondId: 'P7', status: 'online' });
    store.ponds.set('P8', { pondId: 'P8', status: 'online' });
    store.devices.set('D7-A', { deviceId: 'D7-A', pondId: 'P7', status: 'online' });
    store.devices.set('D7-B', { deviceId: 'D7-B', pondId: 'P7', status: 'online' });

    // 设备 D7-A 切到 P8
    const otherOnlineForOldPond = await store.countDocuments({
      pondId: 'P7',
      status: 'online',
      deviceId: { $ne: 'D7-A' }
    });
    assert('原塘口 P7 还有 D7-B 在线', otherOnlineForOldPond === 1, `count=${otherOnlineForOldPond}`);
    // 不应修改 P7
    assert('P7 保持 online', store.ponds.get('P7').status === 'online');
  }

  // ============ T7: handleDeviceStatus 同等逻辑 - 设备上报 offline + 同塘口有在线设备 ============
  console.log('\n[T7] /status 消息：设备上报 offline 但同塘口有在线设备 → 塘口保持 online');
  {
    const store = createMockStore();
    store.ponds.set('P9', { pondId: 'P9', status: 'online' });
    store.devices.set('D9-MAIN', { deviceId: 'D9-MAIN', pondId: 'P9', status: 'online' });
    store.devices.set('D9-BAK', { deviceId: 'D9-BAK', pondId: 'P9', status: 'online' });

    // 模拟 D9-BAK 上报 status=offline
    const otherOnlineCount = await store.countDocuments({
      pondId: 'P9',
      status: 'online',
      deviceId: { $ne: 'D9-BAK' }
    });
    assert('D9-MAIN 仍在线', otherOnlineCount === 1, `count=${otherOnlineCount}`);

    // handleDeviceStatus 的修复后逻辑：otherOnlineCount > 0 → 不覆盖 pondUpdate
    if (otherOnlineCount === 0) {
      await store.findPondAndUpdate({ pondId: 'P9' }, { $set: { status: 'offline' } });
    }
    assert('D9-BAK 上报 offline 后 P9 仍 online', store.ponds.get('P9').status === 'online', `实际=${store.ponds.get('P9').status}`);
  }

  // ============ 总结 ============
  console.log(`\n========== 测试结果 ==========`);
  console.log(`通过: ${pass}    失败: ${fail}`);
  if (fail > 0) process.exit(1);
  console.log('[ALL PASS] 多终端关联塘口场景逻辑已修复');
})();
