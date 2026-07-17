/**
 * 不同养殖品种的水质指标健康区间
 * 解决"塘口对比需考虑不同养殖品种的指标差异（不能简单横向比较绝对值）"的需求
 *
 * - healthScore 计算：每项指标按"偏离健康区间"的程度扣分，最终 0~100
 * - 横向对比时，前端可同时看到"原始均值"和"健康度评分"，避免直接比绝对值误导
 */

// 单位说明：
//   temperature: ℃
//   ph: 1
//   dissolvedOxygen: mg/L
const SPECIES_PROFILES = {
  南美白对虾: {
    temperature: { min: 25, max: 32, criticalMin: 20, criticalMax: 35 },
    ph: { min: 7.5, max: 8.5, criticalMin: 6.5, criticalMax: 9.5 },
    dissolvedOxygen: { min: 5.0, max: 999, criticalMin: 3.0 }
  },
  淡水鱼: {
    temperature: { min: 20, max: 30, criticalMin: 15, criticalMax: 35 },
    ph: { min: 6.5, max: 8.5, criticalMin: 5.5, criticalMax: 9.5 },
    dissolvedOxygen: { min: 4.0, max: 999, criticalMin: 2.5 }
  },
  加州鲈: {
    temperature: { min: 20, max: 28, criticalMin: 15, criticalMax: 32 },
    ph: { min: 7.0, max: 8.5, criticalMin: 6.0, criticalMax: 9.0 },
    dissolvedOxygen: { min: 5.0, max: 999, criticalMin: 3.0 }
  }
};

// 兜底：未知品种使用通用宽松区间
const DEFAULT_PROFILE = {
  temperature: { min: 20, max: 32, criticalMin: 15, criticalMax: 35 },
  ph: { min: 6.5, max: 8.5, criticalMin: 5.5, criticalMax: 9.5 },
  dissolvedOxygen: { min: 4.0, max: 999, criticalMin: 2.5 }
};

function getProfile(species) {
  if (!species) return DEFAULT_PROFILE;
  return SPECIES_PROFILES[species] || DEFAULT_PROFILE;
}

/**
 * 单个指标打分 0~100
 *  - 落在健康区间内 = 100
 *  - 落在"健康-临界"之间线性扣分
 *  - 达到或超过临界值 = 0
 */
function scoreMetric(value, profile) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;

  const { min, max, criticalMin, criticalMax } = profile;
  // 健康区间
  if (value >= min && value <= max) return 100;

  // 偏低方向
  if (value < min) {
    if (value <= criticalMin) return 0;
    // min 处 100, criticalMin 处 0
    const ratio = (value - criticalMin) / (min - criticalMin);
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  }
  // 偏高方向
  if (value > max) {
    if (value >= criticalMax) return 0;
    const ratio = (criticalMax - value) / (criticalMax - max);
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  }
  return 0;
}

/**
 * 综合水质健康度评分 0~100
 * 权重：溶氧 0.4 / pH 0.3 / 温度 0.3
 * 返回 { score, do, ph, temperature }
 */
function computeHealthScore({ dissolvedOxygen, ph, temperature }, species) {
  const profile = getProfile(species);
  const sDo = scoreMetric(dissolvedOxygen, profile.dissolvedOxygen);
  const sPh = scoreMetric(ph, profile.ph);
  const sT = scoreMetric(temperature, profile.temperature);

  const parts = [];
  const weights = [];
  if (sDo !== null) { parts.push(sDo); weights.push(0.4); }
  if (sPh !== null) { parts.push(sPh); weights.push(0.3); }
  if (sT !== null) { parts.push(sT); weights.push(0.3); }

  if (parts.length === 0) {
    return { score: null, dissolvedOxygen: null, ph: null, temperature: null };
  }

  const totalW = weights.reduce((a, b) => a + b, 0);
  const score = Math.round(parts.reduce((acc, v, i) => acc + v * weights[i], 0) / totalW);

  return {
    score,
    dissolvedOxygen: sDo,
    ph: sPh,
    temperature: sT
  };
}

/**
 * 把 0~100 分数映射为文字 + 颜色（前端统一使用）
 */
function gradeHealth(score) {
  if (score === null || score === undefined) return { level: 'unknown', label: '无数据', color: '#999' };
  if (score >= 85) return { level: 'excellent', label: '优', color: '#52c41a' };
  if (score >= 70) return { level: 'good', label: '良', color: '#73d13d' };
  if (score >= 55) return { level: 'fair', label: '一般', color: '#faad14' };
  if (score >= 40) return { level: 'poor', label: '偏差', color: '#fa8c16' };
  return { level: 'critical', label: '差', color: '#ff4d4f' };
}

module.exports = {
  SPECIES_PROFILES,
  DEFAULT_PROFILE,
  getProfile,
  scoreMetric,
  computeHealthScore,
  gradeHealth
};
