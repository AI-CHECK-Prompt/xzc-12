/**
 * 告警 Excel 导出"字段映射"回归测试
 *
 * 验证目标：
 *  1) Sheet 3「告警明细」表头包含"塘口ID"列（在"时间"之后）
 *  2) 表头 key 与数据行 addRow 键名严格一一对应，无错位
 *  3) 数据行中"级别"列的值为 warning/critical（数据模型 Alert.level 枚举），
 *     "塘口ID"列的值为 Alert.pondId，绝不出现"级别/塘口ID 互换"
 *  4) 表头列数 = 数据行 addRow 的键数
 *
 * 用法：
 *  1) 启动 MongoDB（docker compose up -d mongodb）并 seed 测试数据（见下方 seed()）
 *  2) 启动后端（node src/index.js）
 *  3) node test-alert-export-mapping.js
 */

const http = require('http');
const ExcelJS = require('exceljs');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const POND = 'TEST_POND_EXPORT';
const POND2 = 'TEST_POND_EXPORT_2';

function request(method, urlPath, { token, query } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    if (query) {
      Object.keys(query).forEach((k) => {
        if (query[k] !== undefined && query[k] !== null) {
          url.searchParams.set(k, String(query[k]));
        }
      });
    }
    const req = http.request(
      { method, hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search,
        headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => {
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
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function assert(cond, msg) {
  if (cond) console.log(`  [断言通过] ${msg}`);
  else { console.error(`  [断言失败] ${msg}`); process.exitCode = 1; }
}

async function seedAlerts(token) {
  // 通过 mongoose 直接写库：测试数据需要包含关键特征
  // - POND  下插入 1 条 warning、1 条 critical
  // - POND2 下插入 1 条 warning（确保不会污染 POND 导出）
  const mongoose = require('mongoose');
  const config = require('./src/config');
  const Alert = require('./src/models/Alert');
  const Pond = require('./src/models/Pond');
  const Device = require('./src/models/Device');

  await mongoose.connect(config.mongodbUri);
  await Promise.all([
    Alert.deleteMany({ pondId: { $in: [POND, POND2] } }),
    Pond.deleteMany({ pondId: { $in: [POND, POND2] } }),
    Device.deleteMany({ deviceId: { $in: [POND + '_dev', POND2 + '_dev'] } })
  ]);
  await new Pond({ pondId: POND, name: '测试塘口A', status: 'online' }).save();
  await new Pond({ pondId: POND2, name: '测试塘口B', status: 'online' }).save();
  await new Device({ deviceId: POND + '_dev', pondId: POND, status: 'online' }).save();
  await new Device({ deviceId: POND2 + '_dev', pondId: POND2, status: 'online' }).save();

  const t0 = new Date();
  await Alert.create({
    pondId: POND, type: 'low_oxygen', level: 'warning',
    value: 3.5, threshold: 4, message: '低溶氧警告',
    detectedAt: new Date(t0.getTime() - 60_000),
    createdAt: new Date(t0.getTime() - 50_000)
  });
  await Alert.create({
    pondId: POND, type: 'low_oxygen', level: 'critical',
    value: 2.5, threshold: 3, message: '低溶氧严重',
    detectedAt: new Date(t0.getTime() - 30_000),
    createdAt: new Date(t0.getTime() - 20_000)
  });
  await Alert.create({
    pondId: POND2, type: 'high_ph', level: 'warning',
    value: 8.6, threshold: 8.5, message: 'pH 偏高（其它塘口）',
    detectedAt: t0,
    createdAt: t0
  });
  await mongoose.disconnect();
}

async function main() {
  console.log('=== 告警 Excel 导出字段映射回归测试 ===');

  // 1) 登录
  const loginRes = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ username: 'admin', password: 'admin123' });
    const req = http.request(
      { method: 'POST', hostname: '127.0.0.1', port: 3000, path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          try { resolve({ status: res.statusCode, json: JSON.parse(buf.toString('utf8')) }); }
          catch (e) { resolve({ status: res.statusCode, raw: buf.toString('utf8') }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  if (loginRes.status !== 200 || !loginRes.json || !loginRes.json.data) {
    console.error('登录失败：', loginRes.json || loginRes.raw);
    process.exit(1);
  }
  const token = loginRes.json.data.token;

  // 2) 灌种子告警
  await seedAlerts(token);

  // 3) 拉取 POND 的 xlsx 导出
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const xlsxRes = await request('GET', '/api/analytics/cycle-review/export', {
    token,
    query: {
      pondId: POND,
      startTime: start.toISOString(),
      endTime: now.toISOString(),
      format: 'xlsx'
    }
  });
  assert(xlsxRes.status === 200, `HTTP 200，实际 ${xlsxRes.status}`);
  assert(xlsxRes.body && xlsxRes.body.length > 0, 'xlsx body 非空');

  if (!xlsxRes.body || xlsxRes.body.length === 0) {
    console.error('无响应体，跳过解析');
    process.exit(1);
  }

  // 4) 解析 xlsx
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxRes.body);
  const ws3 = wb.getWorksheet('告警明细');
  assert(!!ws3, '存在「告警明细」sheet');

  if (!ws3) return;

  // 5) 校验表头：必须包含"塘口ID"列，且在"时间"之后
  const headerRow = ws3.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value || '').trim();
  });
  console.log('  表头 =', headers);
  const idxTime = headers.indexOf('时间');
  const idxPondId = headers.indexOf('塘口ID');
  const idxLevel = headers.indexOf('级别');
  const idxType = headers.indexOf('类型');
  assert(idxTime > 0, '"时间"列存在');
  assert(idxPondId > 0, '"塘口ID"列存在（修复前缺失）');
  assert(idxPondId === idxTime + 1, '"塘口ID"列紧跟"时间"之后');
  assert(idxLevel > 0, '"级别"列存在');
  assert(idxType > 0, '"类型"列存在');

  // 6) 校验数据行：列位置 = 表头位置；级别 = warning/critical；塘口ID = Alert.pondId
  const dataRows = [];
  ws3.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = [];
    for (let c = 1; c <= headers.length; c++) {
      cells.push(row.getCell(c).value);
    }
    dataRows.push(cells);
  });
  console.log(`  数据行数 = ${dataRows.length}`);

  // 至少应该出现 POND 的两条告警（warning + critical）
  const pondRows = dataRows.filter((r) => r[idxPondId - 1] === POND);
  const pond2Rows = dataRows.filter((r) => r[idxPondId - 1] === POND2);
  assert(pondRows.length >= 2, `POND 行数 ≥ 2，实际 ${pondRows.length}`);
  assert(pond2Rows.length === 0, `POND2 行数 = 0（不应混入其它塘口），实际 ${pond2Rows.length}`);

  // 关键断言：级别列取值只能是 warning / critical，塘口ID 列不能是这两个值
  const allowedLevels = new Set(['warning', 'critical']);
  for (const r of pondRows) {
    const levelVal = r[idxLevel - 1];
    const pondIdVal = r[idxPondId - 1];
    assert(allowedLevels.has(String(levelVal)), `POND 行 级别=${levelVal} ∈ {warning,critical}`);
    assert(!allowedLevels.has(String(pondIdVal)), `POND 行 塘口ID=${pondIdVal} ∉ {warning,critical}（修复前可能错位）`);
    assert(String(pondIdVal) === POND, `POND 行 塘口ID 等于 ${POND}`);
  }

  // 7) 校验表头列数 = 数据行单元格数
  const headerCount = headers.filter((h) => h).length;
  for (let i = 0; i < dataRows.length; i++) {
    assert(dataRows[i].length === headerCount, `第 ${i + 2} 行单元格数(${dataRows[i].length}) = 表头列数(${headerCount})`);
  }

  // 8) 同样校验 PDF 报告里告警段也含 pond= 标识
  const pdfRes = await request('GET', '/api/analytics/cycle-review/export', {
    token,
    query: {
      pondId: POND,
      startTime: start.toISOString(),
      endTime: now.toISOString(),
      format: 'pdf'
    }
  });
  assert(pdfRes.status === 200, `PDF HTTP 200，实际 ${pdfRes.status}`);
  if (pdfRes.body) {
    const txt = pdfRes.body.toString('latin1');
    assert(txt.includes('Pond Cycle Review Report'), 'PDF 标题存在');
    // PDF 内文本流含 pond= 即可（修复前无此标识）
    assert(txt.includes('pond='), 'PDF 告警行含 pond= 标识（修复前缺失）');
  }

  // 9) 清理
  const mongoose = require('mongoose');
  const config = require('./src/config');
  const Alert = require('./src/models/Alert');
  const Pond = require('./src/models/Pond');
  const Device = require('./src/models/Device');
  await mongoose.connect(config.mongodbUri);
  await Promise.all([
    Alert.deleteMany({ pondId: { $in: [POND, POND2] } }),
    Pond.deleteMany({ pondId: { $in: [POND, POND2] } }),
    Device.deleteMany({ deviceId: { $in: [POND + '_dev', POND2 + '_dev'] } })
  ]);
  await mongoose.disconnect();

  console.log('\n=== 测试完成 ===');
  if (process.exitCode === 1) {
    console.error('存在断言失败');
  } else {
    console.log('所有断言通过');
  }
}

main().catch((err) => {
  console.error('[错误]', err && err.stack || err);
  process.exit(1);
});
