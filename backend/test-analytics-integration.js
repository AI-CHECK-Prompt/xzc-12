/**
 * analytics 接口集成测试（无需 docker / 无需真实 MongoDB/Redis）
 *
 * 启动流程：
 *  1) mongodb-memory-server 启一个临时 MongoDB
 *  2) 把 backend/services/redisClient.js 整体替换为"内存版 stub"
 *  3) 连接 MongoDB → 灌入 22 个塘口（覆盖南美白对虾 / 淡水鱼 / 加州鲈） +
 *     30 天的水质数据 + 告警 + 增氧机状态
 *  4) 启动 Express（与生产同样的 index.js）监听随机端口
 *  5) 通过真实 HTTP 请求验证 compare / cycle-review / export 接口
 *
 * 运行：node test-analytics-integration.js
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.JWT_SECRET = 'integration_test_secret';

// ---- 0. 在 require 之前先把 redisClient 替换为内存版 ----
const Module = require('module');
const path = require('path');
const origResolve = Module._resolveFilename;
const fakeRedisPath = path.join(__dirname, 'test-redis-stub.js');
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.endsWith('redisClient') || request.endsWith('redisClient.js')) {
    return fakeRedisPath;
  }
  return origResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ExcelJS = require('exceljs');
const fs = require('fs');

const Pond = require('./src/models/Pond');
const SensorData = require('./src/models/SensorData');
const Alert = require('./src/models/Alert');
const User = require('./src/models/User');
const analyticsRoutes = require('./src/routes/analytics');
const { authMiddleware } = require('./src/middleware/auth');
const jwt = require('jsonwebtoken');
const config = require('./src/config');

const bcrypt = require('bcryptjs');

function logSection(t) {
  console.log('\n========== ' + t + ' ==========');
}

function fail(msg) {
  console.error('[FAIL] ' + msg);
  process.exit(1);
}

function ok(msg) {
  console.log('[ OK ] ' + msg);
}

function request(server, method, urlPath, { token, body, query } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const qs = query
      ? '?' +
        Object.keys(query)
          .filter((k) => query[k] !== undefined && query[k] !== null)
          .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
          .join('&')
      : '';
    const opts = {
      method,
      hostname: '127.0.0.1',
      port,
      path: urlPath + qs,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = (res.headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(buf.toString('utf8')) }); }
          catch (e) { resolve({ status: res.statusCode, headers: res.headers, raw: buf.toString('utf8') }); }
        } else {
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  logSection('0) 启动 mongodb-memory-server');
  const downloadDir = path.join(require('os').tmpdir(), 'mongo-bin-' + Date.now());
  const mongod = await MongoMemoryServer.create({
    instance: { port: 27020 + Math.floor(Math.random() * 100) },
    binary: { downloadDir }
  });
  const uri = mongod.getUri();
  console.log('mongo uri =', uri);
  await mongoose.connect(uri, { dbName: 'water_quality_test' });
  ok('MongoDB connected');

  logSection('1) 灌入测试数据（22 个塘口 + 30 天水质 + 告警）');
  // 1.1 admin 用户（model 自带 pre-save 钩子会自动 hash 密码）
  await User.create({
    username: 'admin',
    password: 'admin123',
    role: 'admin'
  });
  ok('admin 用户已建');

  // 1.2 22 个塘口，覆盖三种品种 + 两个片区
  const species = ['南美白对虾', '南美白对虾', '南美白对虾', '南美白对虾', '南美白对虾', '南美白对虾', '南美白对虾', '南美白对虾', // 8 个
                   '淡水鱼', '淡水鱼', '淡水鱼', '淡水鱼', '淡水鱼', '淡水鱼', '淡水鱼',  // 7 个
                   '加州鲈', '加州鲈', '加州鲈', '加州鲈', '加州鲈', '加州鲈', '加州鲈']; // 7 个
  const regions = ['A区', 'B区'];
  const ponds = [];
  for (let i = 0; i < 22; i++) {
    ponds.push({
      pondId: `P${String(i + 1).padStart(3, '0')}`,
      name: `${species[i]}${regions[i % 2]}塘${i + 1}号`,
      area: 3 + (i % 5) * 2,           // 3~11 亩
      species: species[i],
      region: regions[i % 2],
      deviceId: `D${String(i + 1).padStart(3, '0')}`,
      aeratorMode: 'auto',
      aeratorStatus: false,
      status: 'online'
    });
  }
  await Pond.insertMany(ponds);
  ok(`已创建 ${ponds.length} 个塘口`);

  // 1.3 水质数据：每个塘口每 1 小时一条，跨度 30 天 = 720 条/塘
  const now = new Date();
  const startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sensorDocs = [];
  const hourMs = 60 * 60 * 1000;

  for (const p of ponds) {
    // 不同塘口设置不同的"水位"以让对比数据有差异
    const doBase = p.species === '南美白对虾' ? 6.5 : p.species === '加州鲈' ? 5.5 : 4.8;
    const phBase = p.species === '南美白对虾' ? 8.0 : 7.4;
    const tBase = p.species === '南美白对虾' ? 28 : p.species === '加州鲈' ? 25 : 26;

    // 给"差"的塘口加偏差
    const penalty = p.pondId === 'P005' ? -2.0 : p.pondId === 'P012' ? -1.5 : 0;

    for (let t = 0; t < 720; t++) {
      const ts = new Date(startTime.getTime() + t * hourMs);
      // 简单的日内波动
      const dayWave = Math.sin((ts.getHours() / 24) * Math.PI * 2);
      const rand = (seed) => (Math.sin(seed * 9301 + 49297) * 0.5);

      const doVal = doBase + dayWave * 0.8 + rand(t) * 0.3 + penalty;
      const phVal = phBase + dayWave * 0.2 + rand(t + 100) * 0.1;
      const tVal = tBase + dayWave * 2 + rand(t + 200) * 0.5;
      // 增氧机：晚上 22:00 ~ 次日 06:00 开启
      const h = ts.getHours();
      const aeratorOn = (h >= 22 || h < 6);

      sensorDocs.push({
        pondId: p.pondId,
        deviceId: p.deviceId,
        temperature: Math.round(tVal * 100) / 100,
        ph: Math.round(phVal * 100) / 100,
        dissolvedOxygen: Math.round(doVal * 100) / 100,
        aeratorStatus: aeratorOn,
        timestamp: ts
      });
    }
  }
  // 批量插入，分批避免单次过大
  const chunkSize = 1000;
  for (let i = 0; i < sensorDocs.length; i += chunkSize) {
    await SensorData.insertMany(sensorDocs.slice(i, i + chunkSize));
  }
  ok(`已灌入 ${sensorDocs.length} 条水质数据`);

  // 1.4 告警 - 给 P005 多来几条
  const alertDocs = [];
  for (let i = 0; i < 5; i++) {
    alertDocs.push({
      pondId: 'P005',
      type: 'low_oxygen',
      level: i < 2 ? 'critical' : 'warning',
      value: 2.5 + i * 0.2,
      threshold: 3.0,
      message: '南美白对虾A区塘5号 溶氧过低',
      createdAt: new Date(startTime.getTime() + i * 6 * 60 * 60 * 1000)
    });
  }
  for (let i = 0; i < 3; i++) {
    alertDocs.push({
      pondId: 'P012',
      type: 'high_ph',
      level: 'warning',
      value: 9.1 + i * 0.05,
      threshold: 9.0,
      message: '淡水鱼B区塘12号 pH 偏高',
      createdAt: new Date(startTime.getTime() + i * 8 * 60 * 60 * 1000)
    });
  }
  for (let i = 0; i < 8; i++) {
    alertDocs.push({
      pondId: 'P001',
      type: 'high_temperature',
      level: 'warning',
      value: 35.5 + i * 0.1,
      threshold: 35.0,
      message: '南美白对虾A区塘1号 水温偏高',
      createdAt: new Date(startTime.getTime() + i * 12 * 60 * 60 * 1000)
    });
  }
  await Alert.insertMany(alertDocs);
  ok(`已灌入 ${alertDocs.length} 条告警`);

  logSection('2) 启动 Express');
  const app = express();
  app.use(express.json());

  // 登录接口（生产中由 routes/auth 提供，这里简化）
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ success: false, message: '用户不存在' });
    const match = await user.comparePassword(password);
    if (!match) return res.status(401).json({ success: false, message: '密码错误' });
    const token = jwt.sign({ userId: user._id }, config.jwtSecret, { expiresIn: '7d' });
    res.json({ success: true, data: { token, user: { username: user.username, role: user.role } } });
  });

  app.use('/api/analytics', analyticsRoutes);
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  ok(`Express 监听端口 ${port}`);

  logSection('3) 登录拿 token');
  const loginRes = await request(server, 'POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' }
  });
  if (loginRes.status !== 200) fail('登录失败：' + JSON.stringify(loginRes.json));
  const token = loginRes.json.data.token;
  ok('登录成功，token len = ' + token.length);

  logSection('4) GET /api/analytics/groups?type=species');
  const speciesRes = await request(server, 'GET', '/api/analytics/groups', { token, query: { type: 'species' } });
  console.log(JSON.stringify(speciesRes.json, null, 2));
  if (!speciesRes.json.success) fail('groups 接口失败');
  if (speciesRes.json.data.values.length !== 3) fail('期望 3 个品种，实际 ' + speciesRes.json.data.values.length);
  ok('groups 接口返回 3 个品种');

  logSection('5) GET /api/analytics/compare?groupBy=species&groupValue=南美白对虾');
  const compareRes = await request(server, 'GET', '/api/analytics/compare', {
    token,
    query: {
      groupBy: 'species',
      groupValue: '南美白对虾',
      startTime: startTime.toISOString(),
      endTime: now.toISOString()
    }
  });
  console.log('status =', compareRes.status);
  if (!compareRes.json.success) fail('compare 接口失败: ' + JSON.stringify(compareRes.json));
  const d = compareRes.json.data;
  console.log('  count =', d.count, '  costMs =', d.costMs);
  if (d.count !== 8) fail('南美白对虾应有 8 个塘口，实际 ' + d.count);
  if (d.costMs > 5000) fail('compare 耗时 > 5s，不满足响应时间要求: ' + d.costMs);
  if (!d.rankings.best || !d.rankings.worst) fail('rankings 缺失');
  console.log('  best  =', d.rankings.best.pondId, 'score =', d.rankings.best.health.score);
  console.log('  worst =', d.rankings.worst.pondId, 'score =', d.rankings.worst.health.score);
  // 验证 P005 是最差（设了 penalty）
  if (d.rankings.worst.pondId !== 'P005') fail('期望最差的是 P005，实际 ' + d.rankings.worst.pondId);
  ok('compare 通过：8 个塘口、best/worst 正确、costMs = ' + d.costMs);

  logSection('6) GET /api/analytics/cycle-review?pondId=P005');
  const reviewRes = await request(server, 'GET', '/api/analytics/cycle-review', {
    token,
    query: {
      pondId: 'P005',
      startTime: startTime.toISOString(),
      endTime: now.toISOString()
    }
  });
  console.log('status =', reviewRes.status);
  if (!reviewRes.json.success) fail('cycle-review 接口失败: ' + JSON.stringify(reviewRes.json));
  const r = reviewRes.json.data;
  console.log('  pond =', r.pond);
  console.log('  range =', r.range);
  console.log('  sampleCount =', r.overview.sampleCount);
  console.log('  tAvg =', r.overview.metrics.temperature.avg, ' phAvg =', r.overview.metrics.ph.avg, ' doAvg =', r.overview.metrics.dissolvedOxygen.avg);
  console.log('  health score =', r.overview.health.score, ' grade =', r.overview.health.gradeLabel);
  console.log('  alerts =', r.alerts);
  console.log('  trend points =', r.trend.length);
  console.log('  lowDoMoments count =', r.extreme.lowDoMoments.length);
  console.log('  correlation ph-vs-do =', r.correlation.phVsDo);
  console.log('  evaluation =', r.evaluation);
  console.log('  costMs =', r.costMs);
  if (r.overview.sampleCount !== 720) fail('sampleCount 应为 720，实际 ' + r.overview.sampleCount);
  if (r.alerts.total !== 5) fail('P005 告警应为 5 条，实际 ' + r.alerts.total);
  if (r.trend.length === 0) fail('trend 数据为空');
  if (r.trend.length > 120) fail('趋势采样未降采样，实际 ' + r.trend.length);
  if (r.evaluation.score >= 80) fail('P005 因为有 penalty 应该是中差评级');
  if (r.costMs > 10000) fail('cycle-review 耗时 > 10s: ' + r.costMs);
  ok('cycle-review 通过：样本 720 / 告警 5 / 趋势降采样到 ' + r.trend.length + ' 点 / 耗时 ' + r.costMs + 'ms');

  logSection('7) GET /api/analytics/cycle-review/export?format=xlsx');
  const xlsxRes = await request(server, 'GET', '/api/analytics/cycle-review/export', {
    token,
    query: {
      pondId: 'P005',
      startTime: startTime.toISOString(),
      endTime: now.toISOString(),
      format: 'xlsx'
    }
  });
  console.log('status =', xlsxRes.status);
  console.log('content-type =', xlsxRes.headers['content-type']);
  console.log('content-disposition =', xlsxRes.headers['content-disposition']);
  console.log('body bytes =', xlsxRes.body && xlsxRes.body.length);
  if (xlsxRes.status !== 200) fail('xlsx 导出失败 status=' + xlsxRes.status);
  if (!xlsxRes.body || xlsxRes.body.length === 0) fail('xlsx body 为空');
  const xlsxMagic = xlsxRes.body.slice(0, 4).toString('hex');
  if (xlsxMagic !== '504b0304') fail('xlsx 头部校验失败: ' + xlsxMagic);
  fs.writeFileSync(path.join(__dirname, 'test-output-cycle-review.xlsx'), xlsxRes.body);

  // 用 exceljs 验证内容
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxRes.body);
  const sheets = wb.worksheets.map((s) => s.name);
  console.log('sheets =', sheets);
  if (!sheets.includes('概览') || !sheets.includes('水质趋势') || !sheets.includes('告警明细')) {
    fail('xlsx 缺少必备 sheet: ' + JSON.stringify(sheets));
  }
  ok('xlsx 导出通过：含 sheet ' + JSON.stringify(sheets));

  logSection('8) GET /api/analytics/cycle-review/export?format=pdf');
  const pdfRes = await request(server, 'GET', '/api/analytics/cycle-review/export', {
    token,
    query: {
      pondId: 'P005',
      startTime: startTime.toISOString(),
      endTime: now.toISOString(),
      format: 'pdf'
    }
  });
  console.log('status =', pdfRes.status);
  console.log('content-type =', pdfRes.headers['content-type']);
  console.log('body bytes =', pdfRes.body && pdfRes.body.length);
  if (pdfRes.status !== 200) fail('pdf 导出失败 status=' + pdfRes.status);
  if (!pdfRes.body || pdfRes.body.length === 0) fail('pdf body 为空');
  const pdfMagic = pdfRes.body.slice(0, 4).toString('utf8');
  if (pdfMagic !== '%PDF') fail('pdf 头部校验失败: ' + JSON.stringify(pdfMagic));
  fs.writeFileSync(path.join(__dirname, 'test-output-cycle-review.pdf'), pdfRes.body);
  ok('pdf 导出通过：bytes = ' + pdfRes.body.length);

  logSection('9) 12 个月时间范围校验');
  const longRes = await request(server, 'GET', '/api/analytics/cycle-review', {
    token,
    query: {
      pondId: 'P005',
      startTime: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      endTime: now.toISOString()
    }
  });
  console.log('12个月 status =', longRes.status, 'days =', longRes.json && longRes.json.data && longRes.json.data.range.days);
  if (longRes.status !== 200) fail('12个月范围应被接受: ' + JSON.stringify(longRes.json));
  ok('12 个月时间范围通过');

  logSection('10) 13 个月应被拒绝');
  const tooLongRes = await request(server, 'GET', '/api/analytics/cycle-review', {
    token,
    query: {
      pondId: 'P005',
      startTime: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      endTime: now.toISOString()
    }
  });
  console.log('13个月 status =', tooLongRes.status, 'msg =', tooLongRes.json && tooLongRes.json.message);
  if (tooLongRes.status !== 400) fail('13个月应被拒绝');
  ok('13 个月正确被拒绝');

  logSection('11) 关闭服务并清理');
  server.close();
  await mongoose.connection.close();
  await mongod.stop();
  ok('全部验证通过');
  console.log('\n生成的样本文件：');
  console.log('  - test-output-cycle-review.xlsx');
  console.log('  - test-output-cycle-review.pdf');
}

main().catch((err) => {
  console.error('测试脚本异常：', err && err.stack || err);
  process.exit(1);
});
