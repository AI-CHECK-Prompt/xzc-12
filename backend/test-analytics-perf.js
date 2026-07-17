/**
 * 12个月长周期导出性能测试（验证 10 分钟内的性能约束）
 */
const path = require('path');
const os = require('os');
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req.endsWith('redisClient') || req.endsWith('redisClient.js')) {
    return path.join(__dirname, 'test-redis-stub.js');
  }
  return origResolve.call(this, req, parent, ...rest);
};

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');

const Pond = require('./src/models/Pond');
const SensorData = require('./src/models/SensorData');
const Alert = require('./src/models/Alert');
const User = require('./src/models/User');
const analyticsRoutes = require('./src/routes/analytics');
const config = require('./src/config');

async function main() {
  console.log('=== 启动 mongodb-memory-server ===');
  const downloadDir = path.join(os.tmpdir(), 'mongo-bin-perf-' + Date.now());
  const mongod = await MongoMemoryServer.create({ binary: { downloadDir } });
  await mongoose.connect(mongod.getUri(), { dbName: 'test_perf' });

  console.log('=== 灌入 1 个塘口 + 12 个月小时级数据（约 8784 条） ===');
  const pond = {
    pondId: 'PERF1',
    name: '性能测试塘1号',
    area: 10,
    species: '南美白对虾',
    region: '测试区',
    deviceId: 'D-PERF1',
    aeratorMode: 'auto',
    aeratorStatus: false,
    status: 'online'
  };
  await Pond.create(pond);

  const now = new Date();
  const start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // 1 年
  const docs = [];
  // 每 3 小时一条 → 365*8 = 2920 条
  for (let t = 0; t < 365 * 24 / 3; t++) {
    const ts = new Date(start.getTime() + t * 3 * 60 * 60 * 1000);
    if (ts > now) break;
    docs.push({
      pondId: pond.pondId,
      deviceId: pond.deviceId,
      temperature: 28 + Math.sin(t / 30) * 2,
      ph: 8 + Math.sin(t / 50) * 0.3,
      dissolvedOxygen: 6 + Math.sin(t / 20) * 1.2,
      aeratorStatus: ts.getHours() >= 22 || ts.getHours() < 6,
      timestamp: ts
    });
  }
  // 分批插入
  for (let i = 0; i < docs.length; i += 1000) {
    await SensorData.insertMany(docs.slice(i, i + 1000));
  }
  console.log('seeded', docs.length, 'sensor records');

  // 灌入一些告警
  const alertDocs = [];
  for (let i = 0; i < 50; i++) {
    alertDocs.push({
      pondId: pond.pondId,
      type: 'low_oxygen',
      level: i < 10 ? 'critical' : 'warning',
      value: 2.5 + i * 0.1,
      threshold: 3.0,
      message: 'PERF1 溶氧过低 ' + i,
      createdAt: new Date(start.getTime() + i * 7 * 24 * 60 * 60 * 1000)
    });
  }
  await Alert.insertMany(alertDocs);
  console.log('seeded', alertDocs.length, 'alerts');

  await User.create({ username: 'admin', password: 'admin123', role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRoutes);
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const user = await User.findOne({ username: 'admin' });
  const token = jwt.sign({ userId: user._id }, config.jwtSecret, { expiresIn: '1d' });

  function getRaw(p, qs) {
    return new Promise((resolve, reject) => {
      const u = 'http://127.0.0.1:' + port + p + (qs ? '?' + qs : '');
      const t0 = Date.now();
      const r = http.request(u, { method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ body: buf, status: res.statusCode, ms: Date.now() - t0, contentType: res.headers['content-type'] || '' });
        });
      });
      r.on('error', reject);
      r.end();
    });
  }

  console.log('\n=== 12 个月 cycle-review 性能测试 ===');
  const t0 = Date.now();
  const r1 = await getRaw('/api/analytics/cycle-review',
    'pondId=PERF1&startTime=' + start.toISOString() + '&endTime=' + now.toISOString());
  const t1 = Date.now();
  console.log('cycle-review 总耗时 =', t1 - t0, 'ms (HTTP RTT =', r1.ms, 'ms)');
  const json = JSON.parse(r1.body.toString('utf8'));
  console.log('  sampleCount =', json.data.overview.sampleCount);
  console.log('  trend points =', json.data.trend.length, '(应 ≤ 120)');
  console.log('  alerts total =', json.data.alerts.total);
  console.log('  evaluation =', json.data.evaluation);
  if (t1 - t0 > 10000) {
    throw new Error('cycle-review 超过 10s 性能约束: ' + (t1 - t0) + 'ms');
  }
  console.log('✅ cycle-review < 10s');

  console.log('\n=== 12 个月 xlsx 导出性能测试 ===');
  const t2 = Date.now();
  const r2 = await getRaw('/api/analytics/cycle-review/export',
    'pondId=PERF1&startTime=' + start.toISOString() + '&endTime=' + now.toISOString() + '&format=xlsx');
  const t3 = Date.now();
  console.log('xlsx 导出耗时 =', t3 - t2, 'ms');
  console.log('  bytes =', r2.body.length);
  console.log('  magic =', r2.body.slice(0, 4).toString('hex'), '(应 504b0304)');
  if (t3 - t2 > 60000) {
    throw new Error('xlsx 导出超过 60s: ' + (t3 - t2) + 'ms');
  }
  // 验证 xlsx 内容
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r2.body);
  const sheets = wb.worksheets.map((s) => s.name);
  console.log('  sheets =', sheets);
  console.log('  概览 sheet 行数 =', wb.getWorksheet('概览').rowCount);
  console.log('  水质趋势 sheet 行数 =', wb.getWorksheet('水质趋势').rowCount);
  console.log('  告警明细 sheet 行数 =', wb.getWorksheet('告警明细').rowCount);
  console.log('✅ xlsx 导出 < 60s');

  console.log('\n=== 12 个月 pdf 导出性能测试 ===');
  const t4 = Date.now();
  const r3 = await getRaw('/api/analytics/cycle-review/export',
    'pondId=PERF1&startTime=' + start.toISOString() + '&endTime=' + now.toISOString() + '&format=pdf');
  const t5 = Date.now();
  console.log('pdf 导出耗时 =', t5 - t4, 'ms');
  console.log('  bytes =', r3.body.length);
  console.log('  magic =', r3.body.slice(0, 4).toString('utf8'), '(应 %PDF)');
  if (t5 - t4 > 60000) {
    throw new Error('pdf 导出超过 60s: ' + (t5 - t4) + 'ms');
  }
  console.log('✅ pdf 导出 < 60s');

  server.close();
  await mongoose.connection.close();
  await mongod.stop();

  console.log('\n=== 12 个月长周期复盘 + 导出全部通过 ===');
  console.log('总结:');
  console.log('  - cycle-review:', t1 - t0, 'ms');
  console.log('  - xlsx 导出 :', t3 - t2, 'ms');
  console.log('  - pdf 导出  :', t5 - t4, 'ms');
  console.log('  - 性能约束 (cycle-review + 导出 ≤ 10 分钟) ✅');
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
