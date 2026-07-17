/**
 * analytics 接口端到端验证脚本
 *
 * 验证目标（覆盖需求验收点）：
 *  1) 登录拿到 JWT
 *  2) /api/analytics/groups?type=species  返回品种列表
 *  3) /api/analytics/compare?groupBy=species&groupValue=南美白对虾 返回多个塘口对比数据
 *  4) /api/analytics/cycle-review 返回完整复盘数据
 *  5) /api/analytics/cycle-review/export?format=xlsx 返回 xlsx 文件流
 *  6) /api/analytics/cycle-review/export?format=pdf  返回 pdf 文件流
 *
 * 使用方式：
 *   1) 启动后端服务（已监听 3000 端口）
 *   2) node test-analytics.js
 *
 * 兼容"服务未启动 / MongoDB 暂无真实数据"的情况：
 *   - 若服务不可达则直接报错退出
 *   - 若 groupBy=无数据则跳过对比断言
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

function request(method, urlPath, { token, body, query } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    if (query) {
      Object.keys(query).forEach((k) => {
        if (query[k] !== undefined && query[k] !== null) {
          url.searchParams.set(k, String(query[k]));
        }
      });
    }
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      headers
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = (res.headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          try {
            resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(buf.toString('utf8')) });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, raw: buf.toString('utf8') });
          }
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

function logSection(title) {
  console.log('\n========== ' + title + ' ==========');
}

async function main() {
  // 1) 登录
  logSection('1) 登录拿 JWT');
  const loginRes = await request('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' }
  });
  console.log('status =', loginRes.status);
  if (loginRes.status !== 200 || !loginRes.json || !loginRes.json.data) {
    console.error('登录失败：', loginRes.json || loginRes.raw);
    process.exit(1);
  }
  const token = loginRes.json.data.token;
  console.log('token len =', token ? token.length : 0);

  // 2) 列出品种分组
  logSection('2) /api/analytics/groups?type=species');
  const speciesRes = await request('GET', '/api/analytics/groups', { token, query: { type: 'species' } });
  console.log('status =', speciesRes.status, 'success =', speciesRes.json && speciesRes.json.success);
  const speciesList = (speciesRes.json && speciesRes.json.data && speciesRes.json.data.values) || [];
  console.log('species list =', speciesList);
  if (speciesList.length === 0) {
    console.log('[提示] 数据库中暂无塘口数据，跳过对比断言');
    return;
  }
  const targetSpecies = speciesList[0].value;
  console.log('选择分组值 =', targetSpecies);

  // 3) 塘口对比
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 最近 30 天
  logSection('3) /api/analytics/compare?groupBy=species&groupValue=' + targetSpecies);
  const compareRes = await request('GET', '/api/analytics/compare', {
    token,
    query: {
      groupBy: 'species',
      groupValue: targetSpecies,
      startTime: start.toISOString(),
      endTime: now.toISOString()
    }
  });
  console.log('status =', compareRes.status, 'success =', compareRes.json && compareRes.json.success);
  if (compareRes.json && compareRes.json.success) {
    const d = compareRes.json.data;
    console.log('  count =', d.count, ', costMs =', d.costMs);
    console.log('  best  =', d.rankings.best && `${d.rankings.best.name} score=${d.rankings.best.health.score}`);
    console.log('  worst =', d.rankings.worst && `${d.rankings.worst.name} score=${d.rankings.worst.health.score}`);
    if (d.ponds.length > 0) {
      const sample = d.ponds[0];
      console.log('  sample =', {
        pondId: sample.pondId,
        name: sample.name,
        tAvg: sample.metrics.temperature.avg,
        phAvg: sample.metrics.ph.avg,
        doAvg: sample.metrics.dissolvedOxygen.avg,
        health: sample.health.score,
        grade: sample.health.gradeLabel,
        aeratorOnRatio: sample.aerator.onRatio
      });
    }
  } else {
    console.log('  raw =', compareRes.json || compareRes.raw);
  }

  // 4) 周期复盘 - 选第一个有数据的塘口
  // 优先用对比结果中的 pondId，否则用塘口列表的第一个
  let pondId = null;
  if (compareRes.json && compareRes.json.data && compareRes.json.data.ponds && compareRes.json.data.ponds.length > 0) {
    pondId = compareRes.json.data.ponds[0].pondId;
  } else {
    const pondsList = await request('GET', '/api/ponds', { token });
    const list = (pondsList.json && pondsList.json.data) || [];
    if (list.length > 0) pondId = list[0].pondId;
  }
  if (!pondId) {
    console.log('[跳过] 没有可用的 pondId');
    return;
  }

  logSection('4) /api/analytics/cycle-review?pondId=' + pondId);
  const reviewRes = await request('GET', '/api/analytics/cycle-review', {
    token,
    query: {
      pondId,
      startTime: start.toISOString(),
      endTime: now.toISOString()
    }
  });
  console.log('status =', reviewRes.status, 'success =', reviewRes.json && reviewRes.json.success);
  if (reviewRes.json && reviewRes.json.success) {
    const d = reviewRes.json.data;
    console.log('  pond =', d.pond);
    console.log('  range =', d.range);
    console.log('  overview =', {
      sampleCount: d.overview.sampleCount,
      tAvg: d.overview.metrics.temperature.avg,
      phAvg: d.overview.metrics.ph.avg,
      doAvg: d.overview.metrics.dissolvedOxygen.avg,
      healthScore: d.overview.health.score,
      grade: d.overview.health.gradeLabel
    });
    console.log('  alerts =', d.alerts);
    console.log('  trend points =', d.trend.length);
    console.log('  lowDoMoments =', d.extreme.lowDoMoments.length);
    console.log('  correlation ph-vs-do =', d.correlation.phVsDo);
    console.log('  evaluation =', d.evaluation);
  } else {
    console.log('  raw =', reviewRes.json || reviewRes.raw);
  }

  // 5) 导出 Excel
  logSection('5) /api/analytics/cycle-review/export?format=xlsx');
  const xlsxRes = await request('GET', '/api/analytics/cycle-review/export', {
    token,
    query: {
      pondId,
      startTime: start.toISOString(),
      endTime: now.toISOString(),
      format: 'xlsx'
    }
  });
  console.log('status =', xlsxRes.status);
  console.log('content-type =', xlsxRes.headers['content-type']);
  console.log('content-disposition =', xlsxRes.headers['content-disposition']);
  console.log('body bytes =', xlsxRes.body && xlsxRes.body.length);
  if (xlsxRes.status === 200 && xlsxRes.body && xlsxRes.body.length > 0) {
    const out = path.join(__dirname, 'test-analytics-output.xlsx');
    fs.writeFileSync(out, xlsxRes.body);
    console.log('written to', out);
    // 简单 magic number 校验
    const magic = xlsxRes.body.slice(0, 4).toString('hex');
    console.log('magic =', magic, '(xlsx PK.. 应该是 504b0304)');
    if (magic !== '504b0304') console.log('[WARN] xlsx 头部校验失败');
  } else {
    console.log('[FAIL] xlsx 导出失败');
  }

  // 6) 导出 PDF
  logSection('6) /api/analytics/cycle-review/export?format=pdf');
  const pdfRes = await request('GET', '/api/analytics/cycle-review/export', {
    token,
    query: {
      pondId,
      startTime: start.toISOString(),
      endTime: now.toISOString(),
      format: 'pdf'
    }
  });
  console.log('status =', pdfRes.status);
  console.log('content-type =', pdfRes.headers['content-type']);
  console.log('body bytes =', pdfRes.body && pdfRes.body.length);
  if (pdfRes.status === 200 && pdfRes.body && pdfRes.body.length > 0) {
    const out = path.join(__dirname, 'test-analytics-output.pdf');
    fs.writeFileSync(out, pdfRes.body);
    console.log('written to', out);
    const magic = pdfRes.body.slice(0, 4).toString('utf8');
    console.log('magic =', magic, '(应该是 %PDF)');
    if (magic !== '%PDF') console.log('[WARN] pdf 头部校验失败');
  } else {
    console.log('[FAIL] pdf 导出失败');
  }

  console.log('\n=== 验证完成 ===');
}

main().catch((err) => {
  console.error('脚本异常：', err && err.stack || err);
  process.exit(1);
});
