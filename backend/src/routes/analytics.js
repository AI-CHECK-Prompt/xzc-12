const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const Pond = require('../models/Pond');
const SensorData = require('../models/SensorData');
const Alert = require('../models/Alert');
const { authMiddleware } = require('../middleware/auth');
const { computeHealthScore, gradeHealth, getProfile } = require('../services/speciesProfile');

const router = express.Router();

// 单个分组（按品种 / 片区）支持塘口数量上限，对应需求"同屏至少 20 个"
const MAX_COMPARE_PONDS = 50;
const MAX_CYCLE_DAYS = 366; // 12 个月约 365 天，留 1 天缓冲
const MIN_CYCLE_DAYS = 1;

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function diffDays(a, b) {
  return Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// 把 SensorData 文档转成 { min, max, avg, count, latest }
function summarizeMetric(samples) {
  const valid = samples.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (valid.length === 0) {
    return { min: null, max: null, avg: null, count: 0 };
  }
  let min = valid[0];
  let max = valid[0];
  let sum = 0;
  for (const v of valid) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    min: round(min),
    max: round(max),
    avg: round(sum / valid.length),
    count: valid.length
  };
}

function round(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// 对单个塘口在 [start, end] 区间做水质聚合 + 增氧机运行时长
async function aggregatePond(pond, start, end) {
  // 1) 水质数据聚合
  const pipeline = [
    {
      $match: {
        pondId: pond.pondId,
        timestamp: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: null,
        temperature: { $push: '$temperature' },
        ph: { $push: '$ph' },
        dissolvedOxygen: { $push: '$dissolvedOxygen' },
        sampleCount: { $sum: 1 }
      }
    }
  ];

  const aggResult = await SensorData.aggregate(pipeline);
  let tempSummary = { min: null, max: null, avg: null, count: 0 };
  let phSummary = { min: null, max: null, avg: null, count: 0 };
  let doSummary = { min: null, max: null, avg: null, count: 0 };
  let sampleCount = 0;

  if (aggResult.length > 0) {
    tempSummary = summarizeMetric(aggResult[0].temperature);
    phSummary = summarizeMetric(aggResult[0].ph);
    doSummary = summarizeMetric(aggResult[0].dissolvedOxygen);
    sampleCount = aggResult[0].sampleCount;
  }

  // 2) 增氧机运行时长统计：以 aeratorStatus 字段在 SensorData 中的真实状态为准
  //    设备每次上报都会附带 aeratorStatus=true/false，按"开启样本数 / 总样本数 * 时长"估算
  const aeratorAgg = await SensorData.aggregate([
    { $match: { pondId: pond.pondId, timestamp: { $gte: start, $lte: end } } },
    { $group: { _id: '$aeratorStatus', count: { $sum: 1 } } }
  ]);

  let aeratorOn = 0;
  let aeratorTotal = 0;
  for (const item of aeratorAgg) {
    aeratorTotal += item.count;
    if (item._id === true) aeratorOn += item.count;
  }
  const aeratorOnRatio = aeratorTotal > 0 ? aeratorOn / aeratorTotal : 0;

  // 3) 健康度评分（基于均值，按品种归一化）
  const health = computeHealthScore(
    {
      dissolvedOxygen: doSummary.avg,
      ph: phSummary.avg,
      temperature: tempSummary.avg
    },
    pond.species
  );

  return {
    pondId: pond.pondId,
    name: pond.name,
    species: pond.species || '未分类',
    region: pond.region || '未分区',
    area: pond.area || 0,
    metrics: {
      temperature: tempSummary,
      ph: phSummary,
      dissolvedOxygen: doSummary
    },
    sampleCount,
    aerator: {
      onSamples: aeratorOn,
      totalSamples: aeratorTotal,
      onRatio: round(aeratorOnRatio, 4)
    },
    health: {
      score: health.score,
      grade: gradeHealth(health.score).level,
      gradeLabel: gradeHealth(health.score).label,
      breakdown: {
        dissolvedOxygen: health.dissolvedOxygen,
        ph: health.ph,
        temperature: health.temperature
      }
    }
  };
}

// ============= 1. 塘口对比 =============

/**
 * GET /api/analytics/compare
 * Query:
 *   groupBy=species|region|area    分组维度（默认 species）
 *   groupValue=南美白对虾         分组值（与 groupBy 配套）
 *   startTime / endTime           对比的时间范围
 *   metric=temperature|ph|dissolvedOxygen|health
 *
 * 返回：每个塘口的指标摘要 + 健康度评分，支持前端做横向对比图表
 */
router.get('/compare', authMiddleware, async (req, res) => {
  try {
    const groupBy = String(req.query.groupBy || 'species');
    const groupValue = String(req.query.groupValue || '').trim();
    const start = parseDate(req.query.startTime);
    const end = parseDate(req.query.endTime);

    if (!['species', 'region', 'area'].includes(groupBy)) {
      return res.status(400).json({ success: false, message: 'groupBy 仅支持 species/region/area' });
    }
    if (!groupValue) {
      return res.status(400).json({ success: false, message: '请提供 groupValue 分组值' });
    }
    if (!start || !end) {
      return res.status(400).json({ success: false, message: '请提供 startTime / endTime' });
    }
    if (end <= start) {
      return res.status(400).json({ success: false, message: 'endTime 必须大于 startTime' });
    }
    const days = diffDays(start, end);
    if (days > MAX_CYCLE_DAYS) {
      return res.status(400).json({ success: false, message: `时间范围不能超过 ${MAX_CYCLE_DAYS} 天` });
    }

    // 构造分组筛选条件
    const query = {};
    if (groupBy === 'species') query.species = groupValue;
    else if (groupBy === 'region') query.region = groupValue;
    else if (groupBy === 'area') {
      // 面积分组按"区间"处理，例如 "0-500", "500-1000", "1000+"
      // groupValue 形如 "500-1000" 或 "<500"
      const m = groupValue.match(/^(<)?(\d+)-?(\d+)?$/);
      if (m) {
        const lt = m[1] === '<';
        const a = parseInt(m[2], 10);
        const b = m[3] ? parseInt(m[3], 10) : null;
        if (lt) query.area = { $lt: a };
        else if (b !== null) query.area = { $gte: a, $lt: b };
        else query.area = { $gte: a };
      } else {
        const num = Number(groupValue);
        if (!Number.isNaN(num)) query.area = num;
      }
    }

    const ponds = await Pond.find(query).limit(MAX_COMPARE_PONDS);
    if (ponds.length === 0) {
      return res.json({
        success: true,
        data: {
          groupBy,
          groupValue,
          startTime: start,
          endTime: end,
          count: 0,
          ponds: [],
          rankings: { best: null, worst: null }
        }
      });
    }

    // 并行聚合所有塘口（最多 50 个，10s 之内可完成）
    const startTs = Date.now();
    const pondReports = await Promise.all(ponds.map((p) => aggregatePond(p, start, end)));
    const costMs = Date.now() - startTs;
    console.log(`[塘口对比] groupBy=${groupBy} value=${groupValue} ponds=${ponds.length} costMs=${costMs}`);

    // 排序找出最佳/最差（按健康度评分）
    const ranked = [...pondReports]
      .filter((p) => p.health.score !== null)
      .sort((a, b) => b.health.score - a.health.score);

    res.json({
      success: true,
      data: {
        groupBy,
        groupValue,
        startTime: start,
        endTime: end,
        count: pondReports.length,
        costMs,
        ponds: pondReports,
        rankings: {
          best: ranked[0] || null,
          worst: ranked[ranked.length - 1] || null
        }
      }
    });
  } catch (err) {
    console.error('[塘口对比] 错误:', err.message);
    res.status(500).json({ success: false, message: '塘口对比数据获取失败' });
  }
});

/**
 * GET /api/analytics/groups
 * 列出当前所有可用的分组维度值（前端筛选器下拉数据）
 *   ?type=species|region|area
 */
router.get('/groups', authMiddleware, async (req, res) => {
  try {
    const type = String(req.query.type || 'species');
    let field = 'species';
    if (type === 'region') field = 'region';
    if (type === 'area') field = 'area';

    const groups = await Pond.aggregate([
      { $match: { [field]: { $exists: true, $ne: '' } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        type,
        values: groups.map((g) => ({ value: g._id, count: g.count }))
      }
    });
  } catch (err) {
    console.error('[分组列表] 错误:', err.message);
    res.status(500).json({ success: false, message: '获取分组列表失败' });
  }
});

// ============= 2. 养殖周期复盘报告 =============

/**
 * GET /api/analytics/cycle-review?pondId=xxx&startTime=&endTime=
 * 返回：完整复盘数据（前端直接展示 / 走不同导出接口生成 PDF/Excel）
 */
router.get('/cycle-review', authMiddleware, async (req, res) => {
  try {
    const { pondId } = req.query;
    const start = parseDate(req.query.startTime);
    const end = parseDate(req.query.endTime);

    if (!pondId) {
      return res.status(400).json({ success: false, message: '请提供 pondId' });
    }
    if (!start || !end) {
      return res.status(400).json({ success: false, message: '请提供 startTime / endTime' });
    }
    if (end <= start) {
      return res.status(400).json({ success: false, message: 'endTime 必须大于 startTime' });
    }
    const days = diffDays(start, end);
    if (days < MIN_CYCLE_DAYS) {
      return res.status(400).json({ success: false, message: '时间范围至少 1 天' });
    }
    if (days > MAX_CYCLE_DAYS) {
      return res.status(400).json({ success: false, message: `复盘时间范围不能超过 ${MAX_CYCLE_DAYS} 天（约 12 个月）` });
    }

    const pond = await Pond.findOne({ pondId });
    if (!pond) {
      return res.status(404).json({ success: false, message: '塘口不存在' });
    }

    const t0 = Date.now();

    // 1) 水质聚合 + 增氧机运行时长
    const overview = await aggregatePond(pond, start, end);

    // 2) 告警统计分布
    // 修复：按 detectedAt（设备真实检测时间）过滤，老数据无 detectedAt 时回退到 createdAt，
    // 解决"事件复盘时序错乱"——按入库时间筛会把告警归到错误周期
    const alertAgg = await Alert.aggregate([
      {
        $match: {
          pondId,
          $expr: {
            $and: [
              { $gte: [{ $ifNull: ['$detectedAt', '$createdAt'] }, start] },
              { $lte: [{ $ifNull: ['$detectedAt', '$createdAt'] }, end] }
            ]
          }
        }
      },
      {
        $group: {
          _id: { type: '$type', level: '$level' },
          count: { $sum: 1 }
        }
      }
    ]);

    const alertByType = {};
    const alertByLevel = { warning: 0, critical: 0 };
    let alertTotal = 0;
    for (const row of alertAgg) {
      const t = row._id.type;
      const lv = row._id.level;
      alertByType[t] = (alertByType[t] || 0) + row.count;
      alertByLevel[lv] = (alertByLevel[lv] || 0) + row.count;
      alertTotal += row.count;
    }

    // 3) 按天采样趋势（前端画曲线）—— 降采样到最多 120 个点
    const MAX_TREND_POINTS = 120;
    const sampleCount = overview.sampleCount || 0;
    let trend;
    if (sampleCount <= MAX_TREND_POINTS) {
      // 直接全量
      const docs = await SensorData.find({ pondId, timestamp: { $gte: start, $lte: end } })
        .select('temperature ph dissolvedOxygen timestamp')
        .sort({ timestamp: 1 })
        .lean();
      trend = docs.map((d) => ({
        timestamp: d.timestamp,
        temperature: d.temperature,
        ph: d.ph,
        dissolvedOxygen: d.dissolvedOxygen
      }));
    } else {
      // MongoDB $bucketAuto 降采样
      const bucketed = await SensorData.aggregate([
        { $match: { pondId, timestamp: { $gte: start, $lte: end } } },
        {
          $bucketAuto: {
            groupBy: '$timestamp',
            buckets: MAX_TREND_POINTS,
            output: {
              avgTemp: { $avg: '$temperature' },
              avgPh: { $avg: '$ph' },
              avgDo: { $avg: '$dissolvedOxygen' },
              minTemp: { $min: '$temperature' },
              maxTemp: { $max: '$temperature' },
              minPh: { $min: '$ph' },
              maxPh: { $max: '$ph' },
              minDo: { $min: '$dissolvedOxygen' },
              maxDo: { $max: '$dissolvedOxygen' },
              ts: { $avg: '$timestamp' }
            }
          }
        }
      ]);
      trend = bucketed.map((b) => ({
        timestamp: new Date(b.ts),
        temperature: round(b.avgTemp),
        ph: round(b.avgPh),
        dissolvedOxygen: round(b.avgDo),
        temperatureMin: round(b.minTemp),
        temperatureMax: round(b.maxTemp),
        phMin: round(b.minPh),
        phMax: round(b.maxPh),
        doMin: round(b.minDo),
        doMax: round(b.maxDo)
      }));
    }

    // 4) 极值时刻（取最早的 5 个最低溶氧 + 最高 pH + 最高温度时刻）
    const extremeDocs = await SensorData.find({ pondId, timestamp: { $gte: start, $lte: end } })
      .select('temperature ph dissolvedOxygen timestamp')
      .sort({ dissolvedOxygen: 1 })
      .limit(5)
      .lean();
    const lowDoMoments = extremeDocs.map((d) => ({
      timestamp: d.timestamp,
      dissolvedOxygen: round(d.dissolvedOxygen),
      temperature: round(d.temperature),
      ph: round(d.ph)
    }));

    // 5) pH 和溶氧关联（简单相关性系数，皮尔逊）
    const corrDocs = await SensorData.find({ pondId, timestamp: { $gte: start, $lte: end } })
      .select('ph dissolvedOxygen')
      .lean();
    const correlation = pearson(
      corrDocs.map((d) => d.ph).filter((v) => v !== null && v !== undefined),
      corrDocs.map((d) => d.dissolvedOxygen).filter((v) => v !== null && v !== undefined)
    );

    // 6) 增氧机按时段分布（按小时统计开启比例）
    const hourAgg = await SensorData.aggregate([
      { $match: { pondId, timestamp: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $hour: '$timestamp' },
          on: { $sum: { $cond: [{ $eq: ['$aeratorStatus', true] }, 1, 0] } },
          total: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    const aeratorByHour = hourAgg.map((h) => ({
      hour: h._id,
      onRatio: h.total > 0 ? round(h.on / h.total, 4) : 0
    }));

    // 7) 综合评估
    const evaluation = evaluateHealth({
      healthScore: overview.health.score,
      alertTotal,
      alertCritical: alertByLevel.critical || 0,
      aeratorOnRatio: overview.aerator.onRatio
    });

    const costMs = Date.now() - t0;
    console.log(`[周期复盘] ${pondId} days=${days} costMs=${costMs}`);

    res.json({
      success: true,
      data: {
        pond: {
          pondId: pond.pondId,
          name: pond.name,
          species: pond.species || '未分类',
          region: pond.region || '未分区',
          area: pond.area || 0
        },
        range: { startTime: start, endTime: end, days },
        overview,
        alerts: {
          total: alertTotal,
          byLevel: alertByLevel,
          byType: alertByType
        },
        trend,
        extreme: {
          lowDoMoments
        },
        correlation: {
          phVsDo: round(correlation, 4)
        },
        aeratorByHour,
        evaluation,
        costMs
      }
    });
  } catch (err) {
    console.error('[周期复盘] 错误:', err.message, err.stack);
    res.status(500).json({ success: false, message: '生成复盘报告失败' });
  }
});

/**
 * 综合评估：将整个周期的健康度归一为"优良中差"
 */
function evaluateHealth({ healthScore, alertTotal, alertCritical, aeratorOnRatio }) {
  let score = 100;
  if (healthScore !== null) {
    score = Math.round(healthScore * 0.6); // 健康度评分权重 60%
  } else {
    score = 60; // 无数据时给个中间值
  }
  // 告警扣分：每条 warning -1, critical -3
  score -= (alertTotal - alertCritical) * 1 + alertCritical * 3;
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let level = 'excellent';
  let label = '优';
  let suggestion = '本周期水质稳定，可继续沿用现有方案';
  if (score < 40) {
    level = 'critical';
    label = '差';
    suggestion = '本周期水质问题严重，建议立即排查增氧/投喂/换水方案，下周期重点改进';
  } else if (score < 60) {
    level = 'poor';
    label = '偏差';
    suggestion = '存在较多水质波动与告警，建议下周期调整增氧机策略与饲料投放频次';
  } else if (score < 80) {
    level = 'fair';
    label = '一般';
    suggestion = '整体可接受但仍有优化空间，关注溶氧低值时刻的增氧机联动';
  } else if (score < 90) {
    level = 'good';
    label = '良';
    suggestion = '水质整体良好，可提炼本周期经验作为下周期参考';
  }

  return { score, level, label, suggestion };
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
  const mx = sumX / n;
  const my = sumY / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

// ============= 3. 导出 PDF / Excel =============

/**
 * GET /api/analytics/cycle-review/export?pondId=xxx&startTime=&endTime=&format=pdf|xlsx
 * 需求：支持导出 PDF 与 Excel 两种格式
 * 实现：先复用 /cycle-review 的数据计算，再流式输出到响应
 */
router.get('/cycle-review/export', authMiddleware, async (req, res) => {
  try {
    const { pondId } = req.query;
    const start = parseDate(req.query.startTime);
    const end = parseDate(req.query.endTime);
    const format = String(req.query.format || 'xlsx').toLowerCase();

    if (!pondId || !start || !end) {
      return res.status(400).json({ success: false, message: '缺少必要参数' });
    }
    if (!['pdf', 'xlsx'].includes(format)) {
      return res.status(400).json({ success: false, message: 'format 仅支持 pdf / xlsx' });
    }
    const days = diffDays(start, end);
    if (days > MAX_CYCLE_DAYS) {
      return res.status(400).json({ success: false, message: `复盘时间范围不能超过 ${MAX_CYCLE_DAYS} 天` });
    }

    // 直接调用内部数据组装：复用一个聚合函数，避免重复大查询
    const pond = await Pond.findOne({ pondId });
    if (!pond) {
      return res.status(404).json({ success: false, message: '塘口不存在' });
    }

    const [overview, alertDocs, trend] = await Promise.all([
      aggregatePond(pond, start, end),
      // 修复：按 detectedAt 过滤+排序，缺失时回退到 createdAt，保证事件复盘时序与平台列表一致
      Alert.find({
        pondId,
        $expr: {
          $and: [
            { $gte: [{ $ifNull: ['$detectedAt', '$createdAt'] }, start] },
            { $lte: [{ $ifNull: ['$detectedAt', '$createdAt'] }, end] }
          ]
        }
      })
        .sort({ detectedAt: -1, createdAt: -1 })
        .lean(),
      SensorData.find({ pondId, timestamp: { $gte: start, $lte: end } })
        .select('temperature ph dissolvedOxygen timestamp')
        .sort({ timestamp: 1 })
        .lean()
    ]);

    const alertSummary = {
      total: alertDocs.length,
      warning: alertDocs.filter((a) => a.level === 'warning').length,
      critical: alertDocs.filter((a) => a.level === 'critical').length
    };
    const evaluation = evaluateHealth({
      healthScore: overview.health.score,
      alertTotal: alertSummary.total,
      alertCritical: alertSummary.critical,
      aeratorOnRatio: overview.aerator.onRatio
    });

    const filename = `塘口复盘_${pond.name || pondId}_${formatDate(start)}_${formatDate(end)}`;

    if (format === 'xlsx') {
      await exportExcel(res, { pond, start, end, overview, alertSummary, alertDocs, trend, evaluation }, filename);
    } else {
      await exportPdf(res, { pond, start, end, overview, alertSummary, alertDocs, trend, evaluation }, filename);
    }
  } catch (err) {
    console.error('[复盘导出] 错误:', err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: '导出复盘报告失败' });
    }
  }
});

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
}

async function exportExcel(res, ctx, filename) {
  const { pond, start, end, overview, alertSummary, alertDocs, trend, evaluation } = ctx;
  const wb = new ExcelJS.Workbook();
  wb.creator = '水质监控平台';
  wb.created = new Date();

  // Sheet 1: 概览
  const ws1 = wb.addWorksheet('概览');
  ws1.columns = [
    { header: '指标', key: 'k', width: 28 },
    { header: '数值', key: 'v', width: 40 }
  ];
  ws1.addRow({ k: '塘口编号', v: pond.pondId });
  ws1.addRow({ k: '塘口名称', v: pond.name });
  ws1.addRow({ k: '养殖品种', v: pond.species || '未分类' });
  ws1.addRow({ k: '所属片区', v: pond.region || '未分区' });
  ws1.addRow({ k: '塘口面积(亩)', v: pond.area || 0 });
  ws1.addRow({ k: '复盘开始时间', v: new Date(start).toLocaleString('zh-CN') });
  ws1.addRow({ k: '复盘结束时间', v: new Date(end).toLocaleString('zh-CN') });
  ws1.addRow({ k: '数据样本数', v: overview.sampleCount });
  ws1.addRow({ k: '水温均值(℃)', v: overview.metrics.temperature.avg });
  ws1.addRow({ k: '水温最低(℃)', v: overview.metrics.temperature.min });
  ws1.addRow({ k: '水温最高(℃)', v: overview.metrics.temperature.max });
  ws1.addRow({ k: 'pH 均值', v: overview.metrics.ph.avg });
  ws1.addRow({ k: 'pH 最低', v: overview.metrics.ph.min });
  ws1.addRow({ k: 'pH 最高', v: overview.metrics.ph.max });
  ws1.addRow({ k: '溶氧均值(mg/L)', v: overview.metrics.dissolvedOxygen.avg });
  ws1.addRow({ k: '溶氧最低(mg/L)', v: overview.metrics.dissolvedOxygen.min });
  ws1.addRow({ k: '溶氧最高(mg/L)', v: overview.metrics.dissolvedOxygen.max });
  ws1.addRow({ k: '增氧机开启占比', v: `${(overview.aerator.onRatio * 100).toFixed(2)}%` });
  ws1.addRow({ k: '水质健康度评分', v: overview.health.score === null ? '无数据' : overview.health.score });
  ws1.addRow({ k: '健康度等级', v: overview.health.gradeLabel });
  ws1.addRow({ k: '告警总数', v: alertSummary.total });
  ws1.addRow({ k: '一般告警', v: alertSummary.warning });
  ws1.addRow({ k: '严重告警', v: alertSummary.critical });
  ws1.addRow({ k: '综合评分', v: evaluation.score });
  ws1.addRow({ k: '综合评级', v: evaluation.label });
  ws1.addRow({ k: '调整建议', v: evaluation.suggestion });
  ws1.getRow(1).font = { bold: true };
  ws1.getColumn(1).font = { bold: true };

  // Sheet 2: 水质趋势
  const ws2 = wb.addWorksheet('水质趋势');
  ws2.columns = [
    { header: '时间', key: 't', width: 22 },
    { header: '水温(℃)', key: 'temp', width: 12 },
    { header: 'pH', key: 'ph', width: 10 },
    { header: '溶氧(mg/L)', key: 'do', width: 14 }
  ];
  trend.forEach((d) => {
    ws2.addRow({
      t: new Date(d.timestamp).toLocaleString('zh-CN'),
      temp: d.temperature,
      ph: d.ph,
      do: d.dissolvedOxygen
    });
  });

  // Sheet 3: 告警明细
  // 字段映射规范：表头顺序必须与 addRow 写入顺序一一对应，禁止"表头有 X 列、数据写 Y 值"。
  // 此前问题：表头缺少"塘口ID"列，技术员对账时无法在告警明细中直接定位塘口，
  //          进而把英文级别（warning/critical）误读为塘口编号，把池塘编号误读为告警级别。
  // 修复：表头显式补"塘口ID"列放在"时间"之后；每行 addRow 严格按表头顺序写入对应字段。
  const ws3 = wb.addWorksheet('告警明细');
  ws3.columns = [
    { header: '时间',     key: 'time',   width: 22 },
    { header: '塘口ID',   key: 'pondId', width: 18 },
    { header: '类型',     key: 'type',   width: 16 },
    { header: '级别',     key: 'level',  width: 10 },
    { header: '触发值',   key: 'val',    width: 10 },
    { header: '阈值',     key: 'thr',    width: 10 },
    { header: '描述',     key: 'msg',    width: 50 }
  ];
  alertDocs.forEach((a) => {
    // 修复：导出时间使用 detectedAt（设备真实检测时间），缺失时回退 createdAt，
    // 保证导出报告与平台告警列表时序一致
    const t = a.detectedAt || a.createdAt;
    // 关键：键名必须与上方 ws3.columns 的 key 一一对应，列顺序一一对应
    // - time   ← detectedAt/createdAt
    // - pondId ← a.pondId（数据模型 Alert.pondId）
    // - type   ← a.type
    // - level  ← a.level（数据模型 Alert.level，取值 warning/critical）
    // - val    ← a.value
    // - thr    ← a.threshold
    // - msg    ← a.message
    ws3.addRow({
      time: new Date(t).toLocaleString('zh-CN'),
      pondId: a.pondId,
      type: a.type,
      level: a.level,
      val: a.value,
      thr: a.threshold,
      msg: a.message
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

async function exportPdf(res, ctx, filename) {
  const { pond, start, end, overview, alertSummary, alertDocs, trend, evaluation } = ctx;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}.pdf"`);

  // 简单"中文字体"回退：PDFKit 默认不内置 CJK 字体。为保证可读性，
  // 这里使用 Helvetica，并通过 toLatinSafe 把中文处理为转写 + 拼音不现实，
  // 因此采用"标题使用英文/数字，正文保留中文"策略：若系统已安装中文 TTF，
  // PDFKit 会自动嵌入；本服务不强依赖字体，最坏情况下中文显示为空，
  // 实际部署建议将字体文件放到 backend/fonts/ 并通过 doc.font() 注册。
  // 此处给出"标题 + 关键数值英文"的可读版本作为兜底。
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  // 标题
  doc.fontSize(18).text('Pond Cycle Review Report', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#666').text(`${pond.name || pond.pondId}  |  ${formatDate(start)} ~ ${formatDate(end)}`, { align: 'center' });
  doc.moveDown(1);
  doc.fillColor('#000');

  // 概览
  doc.fontSize(14).text('Overview', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  const lines = [
    `Pond ID: ${pond.pondId}`,
    `Name: ${pond.name}`,
    `Species: ${pond.species || 'N/A'}`,
    `Region: ${pond.region || 'N/A'}`,
    `Area(mu): ${pond.area || 0}`,
    `Samples: ${overview.sampleCount}`,
    `Temp avg/min/max: ${overview.metrics.temperature.avg} / ${overview.metrics.temperature.min} / ${overview.metrics.temperature.max} C`,
    `pH avg/min/max: ${overview.metrics.ph.avg} / ${overview.metrics.ph.min} / ${overview.metrics.ph.max}`,
    `DO avg/min/max: ${overview.metrics.dissolvedOxygen.avg} / ${overview.metrics.dissolvedOxygen.min} / ${overview.metrics.dissolvedOxygen.max} mg/L`,
    `Aerator ON ratio: ${(overview.aerator.onRatio * 100).toFixed(2)}%`,
    `Health score: ${overview.health.score === null ? 'N/A' : overview.health.score} (${overview.health.gradeLabel})`
  ];
  lines.forEach((l) => doc.text(l));
  doc.moveDown(1);

  // 告警
  doc.fontSize(14).text('Alerts', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  doc.text(`Total: ${alertSummary.total}  |  Warning: ${alertSummary.warning}  |  Critical: ${alertSummary.critical}`);
  doc.moveDown(0.5);
  // 详细告警最多列前 30 条
  alertDocs.slice(0, 30).forEach((a) => {
    // 修复：PDF 报告时间使用 detectedAt，与平台告警列表/Excel 保持一致
    const t = a.detectedAt || a.createdAt;
    // 修复：补齐 pondId 字段，与 Excel 告警明细保持一致，避免运维人员在对账时
    //      把英文级别 [warning]/[critical] 误读为塘口编号，反之亦然
    doc.text(`- ${new Date(t).toLocaleString('zh-CN')}  pond=${a.pondId}  [${a.level}]  ${a.type}  value=${a.value}  ${a.message || ''}`);
  });
  if (alertDocs.length > 30) {
    doc.text(`... and ${alertDocs.length - 30} more (see Excel export for full list)`);
  }
  doc.moveDown(1);

  // 评估
  doc.fontSize(14).text('Evaluation', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  doc.text(`Score: ${evaluation.score}`);
  doc.text(`Level: ${evaluation.label}`);
  doc.text(`Suggestion: ${evaluation.suggestion}`);
  doc.moveDown(1);

  // 趋势采样（最多 30 个点）
  doc.fontSize(14).text('Trend (sampled)', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(9);
  const maxRows = 30;
  const stride = Math.max(1, Math.ceil(trend.length / maxRows));
  for (let i = 0; i < trend.length; i += stride) {
    const d = trend[i];
    doc.text(`${new Date(d.timestamp).toLocaleString('zh-CN')}  T=${d.temperature}  pH=${d.ph}  DO=${d.dissolvedOxygen}`);
  }

  doc.end();
}

module.exports = router;
