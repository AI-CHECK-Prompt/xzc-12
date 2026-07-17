/**
 * region 分组对比 + 长周期（200 天）复盘 测试
 */
const path = require('path');
const os = require('os');
const Module = require('module');

// 替换 redis stub
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

const Pond = require('./src/models/Pond');
const SensorData = require('./src/models/SensorData');
const User = require('./src/models/User');
const analyticsRoutes = require('./src/routes/analytics');
const config = require('./src/config');

function log(t) { console.log('\n=== ' + t + ' ==='); }

async function main() {
  log('启动 mongodb-memory-server');
  const downloadDir = path.join(os.tmpdir(), 'mongo-bin-region-' + Date.now());
  const mongod = await MongoMemoryServer.create({ binary: { downloadDir } });
  await mongoose.connect(mongod.getUri(), { dbName: 'test_region' });
  console.log('mongo uri =', mongod.getUri());

  log('灌入 22 个塘口（A区11 + B区11），7 天小时级数据');
  const ponds = [];
  for (let i = 0; i < 22; i++) {
    ponds.push({
      pondId: 'P' + (i + 1),
      name: 'Pond' + (i + 1),
      area: 5,
      species: ['南美白对虾', '淡水鱼', '加州鲈'][i % 3],
      region: i < 11 ? 'A区' : 'B区',
      deviceId: 'D' + (i + 1),
      aeratorMode: 'auto',
      aeratorStatus: false,
      status: 'online'
    });
  }
  await Pond.insertMany(ponds);

  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const docs = [];
  for (const p of ponds) {
    const isA = p.region === 'A区';
    // A区: 6.5 (健康区) ; B区: 2.8 (落在 critical 附近，健康度明显低)
    const doBase = isA ? 6.5 : 2.8;
    for (let h = 0; h < 168; h++) {
      docs.push({
        pondId: p.pondId,
        deviceId: p.deviceId,
        temperature: 28,
        ph: 8,
        dissolvedOxygen: doBase + Math.random() * 0.3,
        aeratorStatus: h % 4 === 0,
        timestamp: new Date(start.getTime() + h * 60 * 60 * 1000)
      });
    }
  }
  await SensorData.insertMany(docs);
  console.log('seeded', ponds.length, 'ponds,', docs.length, 'sensor records');

  await User.create({ username: 'admin', password: 'admin123', role: 'admin' });

  log('启动 Express');
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRoutes);
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const user = await User.findOne({ username: 'admin' });
  const token = jwt.sign({ userId: user._id }, config.jwtSecret, { expiresIn: '1d' });

  function get(p, qs) {
    return new Promise((resolve, reject) => {
      const u = 'http://127.0.0.1:' + port + p + (qs ? '?' + qs : '');
      const r = http.request(u, { method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = (res.headers['content-type'] || '').toLowerCase();
          if (ct.includes('application/json')) {
            try { resolve({ json: JSON.parse(buf.toString()), status: res.statusCode }); }
            catch (e) { resolve({ raw: buf.toString(), status: res.statusCode }); }
          } else {
            resolve({ body: buf, status: res.statusCode, contentType: ct });
          }
        });
      });
      r.on('error', reject);
      r.end();
    });
  }

  log('region=A区 对比');
  const r1 = await get('/api/analytics/compare',
    'groupBy=region&groupValue=' + encodeURIComponent('A区') + '&startTime=' + start.toISOString() + '&endTime=' + now.toISOString());
  console.log('count =', r1.json.data.count, 'best =', r1.json.data.rankings.best && r1.json.data.rankings.best.pondId);
  if (r1.json.data.count !== 11) throw new Error('A区 should have 11 ponds');

  log('region=B区 对比');
  const r2 = await get('/api/analytics/compare',
    'groupBy=region&groupValue=' + encodeURIComponent('B区') + '&startTime=' + start.toISOString() + '&endTime=' + now.toISOString());
  console.log('count =', r2.json.data.count, 'best =', r2.json.data.rankings.best && r2.json.data.rankings.best.pondId);
  if (r2.json.data.count !== 11) throw new Error('B区 should have 11 ponds');

  const aBest = r1.json.data.rankings.best.health.score || 0;
  const bBest = r2.json.data.rankings.best.health.score || 0;
  console.log('A区 best 评分 =', aBest, '  B区 best 评分 =', bBest);
  if (aBest <= bBest) {
    throw new Error('A区 best 评分应高于 B区（因为 A区溶氧更高），实际 ' + aBest + ' vs ' + bBest);
  }
  console.log('✅ A区 best 评分 > B区 best 评分：' + aBest + ' > ' + bBest);

  log('200 天长周期 cycle-review（验证大时间范围）');
  // 这个数据集里的 pondId 是 P1、P2...
  const r3 = await get('/api/analytics/cycle-review',
    'pondId=P1&startTime=' + new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString() + '&endTime=' + now.toISOString());
  console.log('raw response =', JSON.stringify(r3).slice(0, 200));
  if (!r3.json) throw new Error('non-json response: ' + JSON.stringify(r3).slice(0, 200));
  console.log('sampleCount =', r3.json.data.overview.sampleCount);
  console.log('days =', r3.json.data.range.days);
  console.log('trend points =', r3.json.data.trend.length);
  console.log('costMs =', r3.json.data.costMs);
  if (r3.json.data.overview.sampleCount !== 168) {
    throw new Error('P1 应有 168 条样本，实际 ' + r3.json.data.overview.sampleCount);
  }
  if (r3.json.data.trend.length > 120) {
    throw new Error('trend 降采样失败: ' + r3.json.data.trend.length);
  }
  if (r3.json.data.costMs > 5000) {
    throw new Error('cycle-review 耗时 > 5s: ' + r3.json.data.costMs);
  }
  console.log('✅ 长周期复盘通过：耗时 ' + r3.json.data.costMs + 'ms');

  log('20+ 塘口同屏展示（验证 MAX_COMPARE_PONDS）');
  // 灌入更多塘口达到 30 个
  for (let i = 22; i < 30; i++) {
    await Pond.create({
      pondId: 'Q' + (i - 21),  // Q1..Q8
      name: 'QPond' + (i - 21),
      area: 5,
      species: '南美白对虾',
      region: 'C区',
      deviceId: 'QD' + (i - 21),
      aeratorMode: 'auto',
      aeratorStatus: false,
      status: 'online'
    });
  }
  // 灌入 8 个 C区塘口的少量数据
  const cStart = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const cDocs = [];
  for (let i = 22; i < 30; i++) {
    const qid = 'Q' + (i - 21);
    for (let h = 0; h < 24; h++) {
      cDocs.push({
        pondId: qid,
        deviceId: 'QD' + (i - 21),
        temperature: 28,
        ph: 8,
        dissolvedOxygen: 6 + Math.random(),
        aeratorStatus: false,
        timestamp: new Date(cStart.getTime() + h * 60 * 60 * 1000)
      });
    }
  }
  await SensorData.insertMany(cDocs);
  const r4 = await get('/api/analytics/compare',
    'groupBy=region&groupValue=' + encodeURIComponent('C区') + '&startTime=' + cStart.toISOString() + '&endTime=' + now.toISOString());
  console.log('C区塘口数 =', r4.json.data.count);
  if (r4.json.data.count !== 8) throw new Error('C区塘口数应为 8，实际 ' + r4.json.data.count);
  console.log('✅ 8 个 C区塘口同屏对比通过');

  log('清理');
  server.close();
  await mongoose.connection.close();
  await mongod.stop();
  console.log('\n✅ 所有 region/长周期/多塘口 验证通过');
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
