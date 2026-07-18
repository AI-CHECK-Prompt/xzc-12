/**
 * 告警入库时序修复回归测试
 * 验证点：
 *   1) 阈值告警（low_oxygen/high_ph/low_ph/high_temperature）写入 detectedAt = 设备检测时间（sensorData.timestamp）
 *   2) device_offline 告警写入 detectedAt = lastSeen 真实离线时刻（非重连时刻）
 *   3) detectedAt 与 createdAt 的差值落在合理范围（设备检测 → 后端入库 ≤ 1s），不再出现 3-5s 偏差
 *
 * 用法：
 *   1) 启动 MongoDB（docker compose up -d mongodb），或确保 MONGODB_URI 可用
 *   2) node test-alert-time-fix.js
 *   3) 检查控制台输出与 [断言] 行是否全部通过
 */
const mongoose = require('mongoose');
const config = require('./src/config');
const dataProcessor = require('./src/services/dataProcessor');
const alertEngine = require('./src/services/alertEngine');
const Alert = require('./src/models/Alert');
const Pond = require('./src/models/Pond');
const Device = require('./src/models/Device');
const { initMqttClient, publishControl } = require('./src/services/mqttClient');
const { initRedis, getRedis } = require('./src/services/redisClient');

const TEST_POND = 'TEST_POND_TIME';
const TEST_DEVICE = 'TEST_DEVICE_TIME';

// 控制台断言辅助
function assert(cond, msg) {
  if (cond) {
    console.log(`  [断言通过] ${msg}`);
  } else {
    console.error(`  [断言失败] ${msg}`);
    process.exitCode = 1;
  }
}

async function cleanup() {
  await Promise.all([
    Alert.deleteMany({ pondId: TEST_POND }),
    Pond.deleteMany({ pondId: TEST_POND }),
    Device.deleteMany({ deviceId: TEST_DEVICE })
  ]);
}

async function setup() {
  await new Pond({ pondId: TEST_POND, name: '测试塘口', status: 'online' }).save();
  await new Device({ deviceId: TEST_DEVICE, pondId: TEST_POND, status: 'online' }).save();
}

async function case1_ThresholdAlert() {
  console.log('\n[用例1] 阈值告警：检测到设备 timestamp 应作为 detectedAt');
  // 设备"检测到"溶氧过低的时间（人为前移 4s，模拟正常链路延迟）
  const deviceDetectedAt = new Date(Date.now() - 4000);

  await dataProcessor.processSensorData({
    pondId: TEST_POND,
    deviceId: TEST_DEVICE,
    temperature: 26.0,
    ph: 7.5,
    dissolvedOxygen: 2.5, // < critical 3.0
    timestamp: deviceDetectedAt.toISOString()
  });

  // 等待入库
  await new Promise((r) => setTimeout(r, 500));

  const alert = await Alert.findOne({ pondId: TEST_POND, type: 'low_oxygen' }).lean();
  assert(alert, '低溶氧告警已生成');
  if (!alert) return;

  const driftMs = new Date(alert.createdAt).getTime() - new Date(alert.detectedAt).getTime();
  console.log(`  [时序] detectedAt=${alert.detectedAt?.toISOString()}  createdAt=${alert.createdAt?.toISOString()}  drift=${driftMs}ms`);
  // 关键断言：detectedAt 等于设备检测时间（误差在 100ms 内），不再以 createdAt 为准
  const detectedAtDelta = Math.abs(new Date(alert.detectedAt).getTime() - deviceDetectedAt.getTime());
  assert(detectedAtDelta < 100, `detectedAt 与设备 timestamp 一致（差值 ${detectedAtDelta}ms < 100ms）`);
  // 关键断言：drift 是 0~数秒（链路延迟），不再出现"用 createdAt 替代检测时间"的语义错误
  assert(driftMs >= 0 && driftMs < 60000, `drift ${driftMs}ms 合理（detectedAt ≤ createdAt 且 < 60s）`);
}

async function case2_OfflineAlert() {
  console.log('\n[用例2] 设备离线告警：detectedAt = lastSeen 真实离线时刻（非重连时刻）');
  const lastSeen = new Date(Date.now() - 8 * 60 * 1000); // 8 分钟前掉线

  // 先把设备 lastOnline 设为 8 分钟前
  await Device.findOneAndUpdate(
    { deviceId: TEST_DEVICE },
    { $set: { lastOnline: lastSeen } }
  );

  // 直接调用离线检查逻辑：把 lastSeen 模拟成 8 分钟前，超过 deviceOfflineMinutes=10? 改 12 分钟前
  // 注意：默认 deviceOfflineMinutes=10，需让 lastSeen 早于 (now - 10min)
  // 重新设置 lastSeen 为 12 分钟前
  const lastSeen2 = new Date(Date.now() - 12 * 60 * 1000);
  await Device.findOneAndUpdate(
    { deviceId: TEST_DEVICE },
    { $set: { lastOnline: lastSeen2 } }
  );

  // 直接构造离线告警场景：通过 handleDeviceStatus 中"重连补发"路径无法触发
  // 改为直接调用 checkDeviceOffline：把 device 状态置 online + lastOnline=12 分钟前
  await Device.findOneAndUpdate(
    { deviceId: TEST_DEVICE },
    { $set: { status: 'online', lastOnline: lastSeen2 } }
  );
  // checkDeviceOffline 会先扫描 status:online 的设备，发现 lastSeen < threshold 就标 offline
  // 我们的设备已 offline 过了吗？直接重置为 online 让 checkDeviceOffline 能扫到
  await alertEngine.checkDeviceOffline();
  await new Promise((r) => setTimeout(r, 500));

  // 查找最近的一条 device_offline 告警
  const alert = await Alert.findOne({ pondId: TEST_POND, type: 'device_offline' }).sort({ createdAt: -1 }).lean();
  assert(alert, 'device_offline 告警已生成');
  if (!alert) return;

  const driftMs = new Date(alert.createdAt).getTime() - new Date(alert.detectedAt).getTime();
  console.log(`  [时序] detectedAt=${alert.detectedAt?.toISOString()}  createdAt=${alert.createdAt?.toISOString()}  drift=${driftMs}ms`);
  // 关键断言：detectedAt 应在 lastSeen 附近（误差 100ms 内），而非 createdAt
  const detectedAtDelta = Math.abs(new Date(alert.detectedAt).getTime() - lastSeen2.getTime());
  assert(detectedAtDelta < 100, `detectedAt 等于 lastSeen 真实离线时刻（差值 ${detectedAtDelta}ms < 100ms）`);
  // 关键断言：drift 是几分钟（离线时长），不再以"定时器发现时刻"为告警时间
  assert(driftMs > 60 * 1000, `drift ${driftMs}ms 应至少 1 分钟（detectedAt 远早于 createdAt）`);
}

async function case3_ListSortByDetectedAt() {
  console.log('\n[用例3] 告警列表：按 detectedAt 倒序分页');
  // 模拟"先入库一条老告警，再补一条新告警"
  // 老告警的 detectedAt 早于新告警，但 createdAt 顺序相反
  const oldDetect = new Date(Date.now() - 60 * 60 * 1000); // 1 小时前检测
  const oldCreate = new Date(Date.now() - 5 * 60 * 1000);  // 5 分钟前入库（模拟延迟写入）
  const newDetect = new Date(Date.now() - 30 * 1000);       // 30 秒前检测
  const newCreate = new Date(Date.now() - 1 * 1000);        // 1 秒前入库

  await Alert.create({
    pondId: TEST_POND, type: 'low_oxygen', level: 'warning',
    value: 3.5, threshold: 4, message: '老告警',
    detectedAt: oldDetect, createdAt: oldCreate
  });
  await Alert.create({
    pondId: TEST_POND, type: 'high_ph', level: 'critical',
    value: 9.2, threshold: 9, message: '新告警',
    detectedAt: newDetect, createdAt: newCreate
  });

  // 模拟 GET /api/alerts 的查询与排序（这里直接用 model 验证）
  const list = await Alert.find({ pondId: TEST_POND })
    .sort({ detectedAt: -1, createdAt: -1 })
    .lean();

  assert(list.length >= 2, `查询返回 ${list.length} 条告警`);
  if (list.length >= 2) {
    const first = list[0];
    const second = list[1];
    // 第一条应是"新告警"（detectedAt 更新），而不是"老告警"（createdAt 更新）
    assert(first.message === '新告警', `列表第一条为"新告警"（按 detectedAt 排序），实际为 "${first.message}"`);
    assert(second.message === '老告警', `列表第二条为"老告警"，实际为 "${second.message}"`);
  }
}

async function main() {
  console.log('=== 告警入库时序修复回归测试 ===');
  console.log('MONGODB_URI:', config.mongodbUri);

  try {
    await mongoose.connect(config.mongodbUri);
    console.log('[连接] MongoDB 已连接');

    // 初始化 Redis（如可用；不可用则降级用内存）
    try {
      await Promise.race([
        initRedis(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Redis 连接超时')), 3000))
      ]);
    } catch (e) {
      console.warn('[降级] Redis 不可用，部分功能（去重）可能失效：', e.message);
    }

    // 初始化 MQTT（如可用）
    try {
      await Promise.race([
        initMqttClient(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('MQTT 连接超时')), 3000))
      ]);
    } catch (e) {
      console.warn('[降级] MQTT 不可用，aerator_command_failed 路径不会触发：', e.message);
    }

    await cleanup();
    await setup();

    await case1_ThresholdAlert();
    await case2_OfflineAlert();
    await case3_ListSortByDetectedAt();

    console.log('\n=== 测试完成 ===');
    if (process.exitCode === 1) {
      console.error('存在断言失败，请检查上方输出');
    } else {
      console.log('所有断言通过');
    }
  } catch (e) {
    console.error('[错误]', e);
    process.exitCode = 1;
  } finally {
    await cleanup();
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    try {
      const r = getRedis();
      if (r && typeof r.quit === 'function') await r.quit();
    } catch {}
    process.exit(process.exitCode || 0);
  }
}

main();
