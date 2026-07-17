import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Selector, DotLoading, ErrorBlock, Empty, Tag, Button } from 'antd-mobile';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, Cell, ReferenceLine
} from 'recharts';
import dayjs from 'dayjs';
import * as api from '../services/api';

/**
 * 塘口分级对比页
 *
 * 用法：
 *  - 选择分组维度（养殖品种/片区/塘口面积）
 *  - 选择分组值（动态加载）
 *  - 选择对比的时间范围
 *  - 点击"开始对比"拉数据
 *
 * 数据展示：
 *  - 顶部：分组内的最佳/最差塘口卡片（基于水质健康度评分）
 *  - 中部：横向条形图（每塘口的健康度评分，倒序排列；至少 20 个塘口同屏支持）
 *  - 底部：详细指标表（均值/最小/最大 + 增氧机开启占比 + 健康度）
 *
 * 设计原则：
 *  - 因为不同品种不可直接比较绝对值，所有塘口先按"健康度评分"对比，
 *    详情表再展示原始指标，避免误读
 */
export default function PondComparePage() {
  const navigate = useNavigate();
  const [groupBy, setGroupBy] = useState('species');
  const [groupValues, setGroupValues] = useState([]);
  const [groupValue, setGroupValue] = useState('');
  const [rangePreset, setRangePreset] = useState('30d');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  // 加载分组值
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.getGroupValues(groupBy);
        const list = (res && res.data && res.data.values) || [];
        if (!alive) return;
        setGroupValues(list);
        if (list.length > 0) setGroupValue(list[0].value);
        else setGroupValue('');
      } catch (e) {
        if (alive) setGroupValues([]);
      }
    })();
    return () => { alive = false; };
  }, [groupBy]);

  // 计算时间范围
  const range = useMemo(() => {
    const end = new Date();
    let start = new Date(end);
    if (rangePreset === '7d') start.setDate(end.getDate() - 7);
    else if (rangePreset === '30d') start.setDate(end.getDate() - 30);
    else if (rangePreset === '90d') start.setDate(end.getDate() - 90);
    else if (rangePreset === '180d') start.setDate(end.getDate() - 180);
    return { startTime: start, endTime: end };
  }, [rangePreset]);

  // 加载对比数据
  const fetchCompare = async () => {
    if (!groupValue) {
      setError('请选择分组值');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const t0 = Date.now();
      const res = await api.comparePonds({
        groupBy,
        groupValue,
        startTime: range.startTime.toISOString(),
        endTime: range.endTime.toISOString()
      });
      const costMs = Date.now() - t0;
      if (!res || !res.success) throw new Error((res && res.message) || '对比失败');
      setData({ ...res.data, clientCostMs: costMs });
    } catch (e) {
      setError(e.message || '对比失败');
    } finally {
      setLoading(false);
    }
  };

  // 初次进入时若已有 groupValue 自动加载
  useEffect(() => {
    if (groupValue) fetchCompare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupValue]);

  // 健康度条形图数据（按评分倒序）
  const chartData = useMemo(() => {
    if (!data || !data.ponds) return [];
    return [...data.ponds]
      .sort((a, b) => (b.health.score || 0) - (a.health.score || 0))
      .map((p) => ({
        name: p.name,
        score: p.health.score || 0,
        grade: p.health.grade,
        pondId: p.pondId,
        species: p.species,
        region: p.region
      }));
  }, [data]);

  const groupByLabel = { species: '养殖品种', region: '所属片区', area: '塘口面积' }[groupBy];

  return (
    <div style={{ padding: '12px 12px 80px' }}>
      <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>塘口横向对比</div>

        {/* 分组维度 */}
        <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>分组维度</div>
        <Selector
          value={[groupBy]}
          onChange={(v) => v && v.length > 0 && setGroupBy(v[0])}
          options={[
            { label: '养殖品种', value: 'species' },
            { label: '所属片区', value: 'region' },
            { label: '塘口面积', value: 'area' }
          ]}
          style={{ marginBottom: 12 }}
        />

        {/* 分组值 */}
        <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>{groupByLabel}</div>
        {groupValues.length === 0 ? (
          <div style={{ color: '#999', fontSize: 13, padding: '6px 0 12px' }}>该维度下暂无塘口</div>
        ) : (
          <Selector
            value={groupValue ? [groupValue] : []}
            onChange={(v) => v && v.length > 0 && setGroupValue(v[0])}
            options={groupValues.map((g) => ({ label: `${g.value} (${g.count})`, value: g.value }))}
            wrap
            style={{ marginBottom: 12 }}
          />
        )}

        {/* 时间范围 */}
        <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>对比时间范围</div>
        <Selector
          value={[rangePreset]}
          onChange={(v) => v && v.length > 0 && setRangePreset(v[0])}
          options={[
            { label: '近 7 天', value: '7d' },
            { label: '近 30 天', value: '30d' },
            { label: '近 90 天', value: '90d' },
            { label: '近 180 天', value: '180d' }
          ]}
          style={{ marginBottom: 12 }}
        />

        <Button
          block
          color="primary"
          onClick={fetchCompare}
          disabled={!groupValue || loading}
        >
          {loading ? '对比中...' : '开始对比'}
        </Button>
      </Card>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <DotLoading color="primary" />
        </div>
      )}

      {error && !loading && (
        <ErrorBlock status="default" title="对比失败" description={error} style={{ marginTop: 20 }} />
      )}

      {data && !loading && !error && (
        <>
          {/* 概览 + Best/Worst */}
          <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>
              {groupByLabel}：<span style={{ color: '#1677ff', fontWeight: 600 }}>{data.groupValue}</span>
              <span style={{ marginLeft: 12 }}>
                塘口数：<b>{data.count}</b>
              </span>
              <span style={{ marginLeft: 12, color: '#999' }}>
                耗时 {data.costMs ?? data.clientCostMs ?? '?'} ms
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
              对比区间：{dayjs(data.startTime).format('YYYY-MM-DD')} ~ {dayjs(data.endTime).format('YYYY-MM-DD')}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <PondCard
                title="最佳塘口"
                color="#52c41a"
                pond={data.rankings.best}
                onClick={(id) => navigate(`/review/${id}?fromCompare=1`)}
              />
              <PondCard
                title="最差塘口"
                color="#ff4d4f"
                pond={data.rankings.worst}
                onClick={(id) => navigate(`/review/${id}?fromCompare=1`)}
              />
            </div>
          </Card>

          {/* 健康度评分横向条形图（支持至少 20 个塘口同屏） */}
          <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>水质健康度评分对比</div>
            <div style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>
              评分已按养殖品种归一化（0~100），可跨品种横向比较
            </div>
            <div style={{ width: '100%', height: Math.max(280, chartData.length * 28 + 60) }}>
              <ResponsiveContainer>
                <BarChart
                  data={chartData}
                  layout="vertical"
                  margin={{ top: 8, right: 30, left: 8, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis type="number" domain={[0, 100]} />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(v, n, p) => {
                      if (n === 'score') return [`${v} (${p.payload.grade || '-'})`, '健康度'];
                      return [v, n];
                    }}
                  />
                  <ReferenceLine x={85} stroke="#52c41a" strokeDasharray="2 2" label={{ value: '优', fontSize: 10, position: 'top' }} />
                  <ReferenceLine x={40} stroke="#ff4d4f" strokeDasharray="2 2" label={{ value: '差', fontSize: 10, position: 'top' }} />
                  <Bar dataKey="score" radius={[0, 4, 4, 0]}>
                    {chartData.map((entry, idx) => (
                      <Cell key={idx} fill={gradeColor(entry.grade)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* 详细指标表 */}
          <Card style={{ borderRadius: 12 }} bodyStyle={{ padding: '14px 8px' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, padding: '0 8px' }}>详细指标</div>
            <PondMetricTable ponds={data.ponds} />
          </Card>
        </>
      )}
    </div>
  );
}

function PondCard({ title, color, pond, onClick }) {
  if (!pond) {
    return (
      <div style={{ flex: 1, padding: 12, border: `1px dashed ${color}55`, borderRadius: 8, color: '#999', textAlign: 'center', fontSize: 12 }}>
        <div style={{ fontWeight: 600, color }}>{title}</div>
        <div style={{ marginTop: 6 }}>无数据</div>
      </div>
    );
  }
  return (
    <div
      onClick={() => onClick && onClick(pond.pondId)}
      style={{
        flex: 1, padding: 12, border: `1px solid ${color}33`, borderRadius: 8, cursor: 'pointer', background: '#fff'
      }}
    >
      <div style={{ fontSize: 12, color, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{pond.name}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
        <Tag color={gradeTagColor(pond.health.grade)}>{pond.health.gradeLabel}</Tag>
        <span style={{ fontSize: 12, color: '#666' }}>评分 {pond.health.score}</span>
      </div>
      <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
        溶氧均值 {pond.metrics.dissolvedOxygen.avg} · pH {pond.metrics.ph.avg}
      </div>
    </div>
  );
}

function PondMetricTable({ ponds }) {
  const sorted = useMemo(
    () => [...ponds].sort((a, b) => (b.health.score || 0) - (a.health.score || 0)),
    [ponds]
  );
  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#fafafa' }}>
            <th style={thStyle}>塘口</th>
            <th style={thStyle}>品种</th>
            <th style={thStyle}>片区</th>
            <th style={thStyle}>溶氧均值<br/><span style={subThStyle}>min~max</span></th>
            <th style={thStyle}>pH 均值<br/><span style={subThStyle}>min~max</span></th>
            <th style={thStyle}>水温均值<br/><span style={subThStyle}>min~max</span></th>
            <th style={thStyle}>增氧机<br/>开启占比</th>
            <th style={thStyle}>健康度</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: '#999' }}>无数据</td></tr>
          )}
          {sorted.map((p) => (
            <tr key={p.pondId} style={{ borderTop: '1px solid #f0f0f0' }}>
              <td style={tdStyle}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 10, color: '#999' }}>{p.pondId}</div>
              </td>
              <td style={tdStyle}>{p.species}</td>
              <td style={tdStyle}>{p.region}</td>
              <td style={tdStyle}>
                <b>{p.metrics.dissolvedOxygen.avg ?? '--'}</b>
                <div style={{ fontSize: 10, color: '#999' }}>{p.metrics.dissolvedOxygen.min ?? '-'} ~ {p.metrics.dissolvedOxygen.max ?? '-'}</div>
              </td>
              <td style={tdStyle}>
                <b>{p.metrics.ph.avg ?? '--'}</b>
                <div style={{ fontSize: 10, color: '#999' }}>{p.metrics.ph.min ?? '-'} ~ {p.metrics.ph.max ?? '-'}</div>
              </td>
              <td style={tdStyle}>
                <b>{p.metrics.temperature.avg ?? '--'}</b>
                <div style={{ fontSize: 10, color: '#999' }}>{p.metrics.temperature.min ?? '-'} ~ {p.metrics.temperature.max ?? '-'}</div>
              </td>
              <td style={tdStyle}>
                {p.aerator.onRatio !== null ? `${(p.aerator.onRatio * 100).toFixed(1)}%` : '--'}
              </td>
              <td style={tdStyle}>
                <Tag color={gradeTagColor(p.health.grade)}>{p.health.gradeLabel}</Tag>
                <div style={{ fontSize: 10, color: '#999', marginTop: 2 }}>{p.health.score ?? '--'}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle = { padding: '8px 6px', textAlign: 'left', fontWeight: 600, color: '#333', whiteSpace: 'nowrap' };
const subThStyle = { fontWeight: 400, color: '#999', fontSize: 10 };
const tdStyle = { padding: '8px 6px', verticalAlign: 'top', whiteSpace: 'nowrap' };

function gradeColor(grade) {
  switch (grade) {
    case 'excellent': return '#52c41a';
    case 'good': return '#73d13d';
    case 'fair': return '#faad14';
    case 'poor': return '#fa8c16';
    case 'critical': return '#ff4d4f';
    default: return '#bfbfbf';
  }
}
function gradeTagColor(grade) {
  switch (grade) {
    case 'excellent': return 'success';
    case 'good': return 'success';
    case 'fair': return 'warning';
    case 'poor': return 'warning';
    case 'critical': return 'danger';
    default: return 'default';
  }
}
