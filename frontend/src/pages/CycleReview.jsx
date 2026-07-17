import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card, Selector, DatePicker, Button, DotLoading, ErrorBlock, Tag, Empty, Toast, Space
} from 'antd-mobile';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  BarChart, Bar, Cell
} from 'recharts';
import dayjs from 'dayjs';
import * as api from '../services/api';

/**
 * 养殖周期复盘报告页
 *
 * 流程：
 *  1) 选择塘口（来自 URL pondId）+ 时间范围（最长 12 个月）
 *  2) 拉取 /api/analytics/cycle-review 数据
 *  3) 展示：综合评估 / 水质趋势 / 告警统计 / 增氧机分析 / 极值时刻 / pH-DO 关联
 *  4) 一键导出 PDF / Excel
 */
export default function CycleReviewPage() {
  const { pondId } = useParams();
  const navigate = useNavigate();

  const [rangePreset, setRangePreset] = useState('180d');
  const [customStart, setCustomStart] = useState(null);
  const [customEnd, setCustomEnd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  // 计算时间范围
  const range = useMemo(() => {
    const end = dayjs();
    let start;
    if (rangePreset === 'custom' && customStart && customEnd) {
      start = dayjs(customStart);
      return { startTime: start.toDate(), endTime: dayjs(customEnd).toDate() };
    }
    if (rangePreset === '30d') start = end.subtract(30, 'day');
    else if (rangePreset === '90d') start = end.subtract(90, 'day');
    else if (rangePreset === '180d') start = end.subtract(180, 'day');
    else if (rangePreset === '365d') start = end.subtract(365, 'day');
    else start = end.subtract(180, 'day');
    return { startTime: start.toDate(), endTime: end.toDate() };
  }, [rangePreset, customStart, customEnd]);

  const fetchReview = async () => {
    if (!pondId) {
      setError('缺少塘口编号');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const t0 = Date.now();
      const res = await api.getCycleReview({
        pondId,
        startTime: range.startTime.toISOString(),
        endTime: range.endTime.toISOString()
      });
      const costMs = Date.now() - t0;
      if (!res || !res.success) throw new Error((res && res.message) || '生成复盘报告失败');
      setData({ ...res.data, clientCostMs: costMs });
    } catch (e) {
      setError(e.message || '生成复盘报告失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pondId, rangePreset, customStart, customEnd]);

  // 导出
  const handleExport = async (format) => {
    if (!pondId || !data) return;
    setExporting(true);
    const toast = Toast.show({
      icon: 'loading',
      content: `正在生成${format.toUpperCase()}报告...`,
      duration: 0
    });
    try {
      const { blob, filename } = await api.exportCycleReview({
        pondId,
        startTime: range.startTime.toISOString(),
        endTime: range.endTime.toISOString(),
        format
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `复盘报告_${pondId}_${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      Toast.show({ icon: 'success', content: '导出完成' });
    } catch (e) {
      Toast.show({ icon: 'fail', content: e.message || '导出失败' });
    } finally {
      Toast.close(toast);
      setExporting(false);
    }
  };

  return (
    <div style={{ padding: '12px 12px 80px' }}>
      {/* 顶部操作区 */}
      <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Button size="mini" onClick={() => navigate(-1)}>‹ 返回</Button>
          <span style={{ fontSize: 15, fontWeight: 600 }}>养殖周期复盘</span>
        </div>

        <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>时间范围（最长 12 个月）</div>
        <Selector
          value={[rangePreset]}
          onChange={(v) => v && v.length > 0 && setRangePreset(v[0])}
          options={[
            { label: '近 30 天', value: '30d' },
            { label: '近 90 天', value: '90d' },
            { label: '近 180 天', value: '180d' },
            { label: '近 12 月', value: '365d' }
          ]}
          style={{ marginBottom: 10 }}
        />
        <div style={{ fontSize: 11, color: '#999' }}>
          区间：{dayjs(range.startTime).format('YYYY-MM-DD')} ~ {dayjs(range.endTime).format('YYYY-MM-DD')}
        </div>
      </Card>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <DotLoading color="primary" />
        </div>
      )}

      {error && !loading && (
        <ErrorBlock status="default" title="加载失败" description={error} style={{ marginTop: 20 }} />
      )}

      {data && !loading && !error && (
        <>
          {/* 塘口基础信息 + 综合评估 */}
          <PondInfoCard data={data} />

          {/* 关键指标均值卡片 */}
          <OverviewCards data={data} />

          {/* 水质趋势曲线 */}
          <TrendCard data={data} />

          {/* 告警统计 + 增氧机分析 */}
          <AlertAndAeratorCard data={data} />

          {/* 极值时刻 + pH-DO 相关性 */}
          <ExtremeCard data={data} />

          {/* 导出按钮 */}
          <Card style={{ borderRadius: 12, marginTop: 12 }} bodyStyle={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>导出报告</div>
            <Space block direction="vertical">
              <Button block color="primary" disabled={exporting} onClick={() => handleExport('xlsx')}>
                导出 Excel（多 sheet，含完整明细）
              </Button>
              <Button block disabled={exporting} onClick={() => handleExport('pdf')}>
                导出 PDF（概览 + 趋势采样）
              </Button>
            </Space>
            <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>
              耗时 {data.costMs ?? data.clientCostMs ?? '?'} ms · 共 {data.range.days} 天
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function PondInfoCard({ data }) {
  const ev = data.evaluation || {};
  const levelColor = {
    excellent: '#52c41a',
    good: '#73d13d',
    fair: '#faad14',
    poor: '#fa8c16',
    critical: '#ff4d4f'
  }[ev.level] || '#999';

  return (
    <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{data.pond.name}</div>
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            编号 {data.pond.pondId} · {data.pond.species} · {data.pond.region} · {data.pond.area} 亩
          </div>
          <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
            复盘区间：{dayjs(data.range.startTime).format('YYYY-MM-DD')} ~ {dayjs(data.range.endTime).format('YYYY-MM-DD')}（{data.range.days} 天）
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: '#999' }}>综合评级</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: levelColor, lineHeight: 1.1 }}>{ev.label}</div>
          <div style={{ fontSize: 11, color: '#999' }}>评分 {ev.score}</div>
        </div>
      </div>
      <div style={{
        marginTop: 12, padding: '10px 12px', background: '#fafafa', borderRadius: 6,
        fontSize: 12, color: '#555', lineHeight: 1.6
      }}>
        <b>调整建议：</b>{ev.suggestion}
      </div>
    </Card>
  );
}

function OverviewCards({ data }) {
  const m = data.overview.metrics;
  return (
    <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>关键指标均值</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <MetricCell title="溶氧 (mg/L)" value={m.dissolvedOxygen.avg} min={m.dissolvedOxygen.min} max={m.dissolvedOxygen.max} unit="mg/L" />
        <MetricCell title="pH" value={m.ph.avg} min={m.ph.min} max={m.ph.max} />
        <MetricCell title="水温 (℃)" value={m.temperature.avg} min={m.temperature.min} max={m.temperature.max} unit="℃" />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Tag color={data.overview.health.score >= 70 ? 'success' : 'warning'}>
          水质健康度 {data.overview.health.score ?? '--'} · {data.overview.health.gradeLabel}
        </Tag>
        <Tag color="primary">增氧机开启 {Math.round((data.overview.aerator.onRatio || 0) * 100)}%</Tag>
        <Tag>样本数 {data.overview.sampleCount}</Tag>
        <Tag color="warning">告警 {data.alerts.total}</Tag>
      </div>
    </Card>
  );
}

function MetricCell({ title, value, min, max, unit }) {
  return (
    <div style={{ background: '#fafafa', borderRadius: 8, padding: 10, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: '#999' }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#333', lineHeight: 1.2 }}>
        {value ?? '--'}<span style={{ fontSize: 11, color: '#999', fontWeight: 400, marginLeft: 2 }}>{unit || ''}</span>
      </div>
      <div style={{ fontSize: 10, color: '#999' }}>{min ?? '-'} ~ {max ?? '-'}</div>
    </div>
  );
}

function TrendCard({ data }) {
  const trend = (data.trend || []).map((d) => ({
    ...d,
    ts: dayjs(d.timestamp).format('MM-DD HH:mm')
  }));
  return (
    <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>水质变化趋势</div>
      <div style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>
        采样点 {trend.length} 个（自动降采样至 ≤120）
      </div>
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          <LineChart data={trend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="ts" tick={{ fontSize: 10 }} minTickGap={32} />
            <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} />
            <Tooltip labelStyle={{ fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line yAxisId="left" type="monotone" dataKey="temperature" name="水温℃" stroke="#fa8c16" dot={false} strokeWidth={1.5} />
            <Line yAxisId="left" type="monotone" dataKey="ph" name="pH" stroke="#722ed1" dot={false} strokeWidth={1.5} />
            <Line yAxisId="right" type="monotone" dataKey="dissolvedOxygen" name="溶氧mg/L" stroke="#1677ff" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function AlertAndAeratorCard({ data }) {
  const byType = data.alerts.byType || {};
  const types = Object.keys(byType);
  const byTypeData = types.map((t) => ({ type: alertTypeLabel(t), count: byType[t] }));

  // 增氧机按时段分布
  const hourData = (data.aeratorByHour || []).map((h) => ({
    hour: `${String(h.hour).padStart(2, '0')}时`,
    ratio: Math.round((h.onRatio || 0) * 100)
  }));

  return (
    <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>告警与增氧机分析</div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <Tag color="warning">一般 {data.alerts.byLevel.warning || 0}</Tag>
        <Tag color="danger">严重 {data.alerts.byLevel.critical || 0}</Tag>
        <Tag>合计 {data.alerts.total}</Tag>
      </div>

      {byTypeData.length === 0 ? (
        <Empty description="本周期无告警" />
      ) : (
        <div style={{ width: '100%', height: 200 }}>
          <ResponsiveContainer>
            <BarChart data={byTypeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="type" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="count" name="告警数" fill="#ff7a45" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, margin: '16px 0 6px' }}>增氧机按时段开启占比</div>
      <div style={{ width: '100%', height: 180 }}>
        <ResponsiveContainer>
          <BarChart data={hourData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={1} />
            <YAxis tick={{ fontSize: 11 }} unit="%" domain={[0, 100]} />
            <Tooltip formatter={(v) => `${v}%`} />
            <Bar dataKey="ratio" name="开启占比" radius={[3, 3, 0, 0]}>
              {hourData.map((d, idx) => (
                <Cell key={idx} fill={d.ratio > 60 ? '#1677ff' : d.ratio > 30 ? '#52c41a' : '#bfbfbf'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function ExtremeCard({ data }) {
  const list = data.extreme.lowDoMoments || [];
  const corr = data.correlation.phVsDo;
  return (
    <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>极值时刻与指标关联</div>

      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
        pH 与溶氧的皮尔逊相关系数：
        <b style={{ color: corrInterpretation(corr).color, marginLeft: 4 }}>
          {corr === null ? '无数据' : corr.toFixed(3)}
        </b>
        <span style={{ marginLeft: 8, color: '#999' }}>{corrInterpretation(corr).label}</span>
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, margin: '10px 0 6px' }}>最低溶氧 Top 5 时刻</div>
      {list.length === 0 ? (
        <Empty description="无明显低溶氧时刻" />
      ) : (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#fafafa' }}>
              <th style={exTh}>时间</th>
              <th style={exTh}>溶氧</th>
              <th style={exTh}>pH</th>
              <th style={exTh}>水温</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d, i) => (
              <tr key={i} style={{ borderTop: '1px solid #f0f0f0' }}>
                <td style={exTd}>{dayjs(d.timestamp).format('YYYY-MM-DD HH:mm')}</td>
                <td style={{ ...exTd, color: d.dissolvedOxygen < 3 ? '#ff4d4f' : '#fa8c16', fontWeight: 600 }}>{d.dissolvedOxygen}</td>
                <td style={exTd}>{d.ph}</td>
                <td style={exTd}>{d.temperature}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

const exTh = { padding: '6px 4px', textAlign: 'left', fontWeight: 600, color: '#333' };
const exTd = { padding: '6px 4px', whiteSpace: 'nowrap' };

function alertTypeLabel(t) {
  return ({
    low_oxygen: '低溶氧',
    high_ph: 'pH 偏高',
    low_ph: 'pH 偏低',
    high_temperature: '水温偏高',
    device_offline: '设备离线',
    aerator_command_failed: '增氧机命令失败'
  })[t] || t;
}

function corrInterpretation(c) {
  if (c === null) return { label: '无数据', color: '#999' };
  const abs = Math.abs(c);
  if (abs < 0.2) return { label: '几乎无线性关联', color: '#999' };
  if (abs < 0.5) return { label: '弱相关', color: '#faad14' };
  if (abs < 0.8) return { label: '中等相关', color: '#1677ff' };
  return { label: c < 0 ? '强负相关' : '强正相关', color: c < 0 ? '#52c41a' : '#722ed1' };
}
