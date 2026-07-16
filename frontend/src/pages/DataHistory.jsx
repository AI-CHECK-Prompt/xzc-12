import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Card, DatePicker, Button, DotLoading, ErrorBlock, Tabs, Toast } from 'antd-mobile';
import dayjs from 'dayjs';
import * as api from '../services/api';
import DataChart from '../components/DataChart';
import { DO_THRESHOLD_WARNING } from '../utils/constants';

export default function DataHistoryPage() {
  const { pondId } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState([]);
  const [pond, setPond] = useState(null);
  const [dateRange, setDateRange] = useState([
    dayjs().subtract(24, 'hour').toDate(),
    dayjs().toDate(),
  ]);
  const [activeMetric, setActiveMetric] = useState('do');

  const fetchData = useCallback(async () => {
    if (!dateRange || dateRange.length < 2) return;
    setLoading(true);
    setError(null);
    try {
      const params = {
        startTime: dayjs(dateRange[0]).toISOString(),
        endTime: dayjs(dateRange[1]).toISOString(),
      };
      const res = await api.getHistoryData(pondId, params);
      const list = res?.data || res || [];
      const chartData = (Array.isArray(list) ? list : []).map((item) => ({
        time: dayjs(item.timestamp || item.time).format('MM-DD HH:mm'),
        do: item.dissolvedOxygen ?? item.do,
        ph: item.ph,
        temp: item.temperature ?? item.temp,
      }));
      setData(chartData);
    } catch {
      setError('加载历史数据失败');
    } finally {
      setLoading(false);
    }
  }, [pondId, dateRange]);

  const fetchPondInfo = async () => {
    try {
      const res = await api.getPondDetail(pondId);
      setPond(res?.data || res);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchPondInfo();
  }, [pondId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const exportCSV = () => {
    if (!data || data.length === 0) {
      Toast.show({ icon: 'fail', content: '暂无数据可导出' });
      return;
    }

    const headers = ['时间', '溶氧(mg/L)', 'pH', '水温(°C)'];
    const rows = data.map((item) => [item.time, item.do ?? '', item.ph ?? '', item.temp ?? '']);
    const csvContent = [headers, ...rows]
      .map((row) => row.map((v) => `"${v ?? ''}"`).join(','))
      .join('\n');

    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `水质数据_${pond?.name || pondId}_${dayjs().format('YYYYMMDD')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    Toast.show({ icon: 'success', content: '导出成功' });
  };

  const metricConfigs = {
    do: { key: 'do', label: '溶氧', color: '#1677ff', yLabel: 'mg/L', threshold: DO_THRESHOLD_WARNING, thresholdLabel: `预警线 ${DO_THRESHOLD_WARNING}` },
    ph: { key: 'ph', label: 'pH', color: '#52c41a', yLabel: 'pH' },
    temp: { key: 'temp', label: '水温', color: '#faad14', yLabel: '°C' },
  };

  const currentMetric = metricConfigs[activeMetric];

  return (
    <div style={{ padding: '12px', paddingBottom: 60 }}>
      <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '12px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          {pond?.name || '历史数据'}
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>选择时间范围</div>
          <DatePicker
            value={dateRange[0]}
            onChange={(val) => setDateRange([val, dateRange[1]])}
            min={dayjs().subtract(30, 'day').toDate()}
            max={dateRange[1]}
          >
            {(value) =>
              value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '选择开始时间'
            }
          </DatePicker>
          <div style={{ textAlign: 'center', color: '#999', fontSize: 12, margin: '4px 0' }}>至</div>
          <DatePicker
            value={dateRange[1]}
            onChange={(val) => setDateRange([dateRange[0], val])}
            min={dateRange[0]}
            max={dayjs().toDate()}
          >
            {(value) =>
              value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '选择结束时间'
            }
          </DatePicker>
        </div>

        <Button
          block
          size="small"
          color="primary"
          fill="none"
          onClick={fetchData}
          loading={loading}
          style={{ borderRadius: 8, marginBottom: 8 }}
        >
          查询
        </Button>

        <Button
          block
          size="small"
          fill="none"
          onClick={exportCSV}
          style={{ borderRadius: 8, border: '1px solid #52c41a', color: '#52c41a' }}
        >
          导出 CSV
        </Button>
      </Card>

      <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '8px' }}>
        <Tabs
          activeKey={activeMetric}
          onChange={setActiveMetric}
          style={{
            '--title-font-size': '13px',
            '--active-title-color': '#1677ff',
            '--active-line-color': '#1677ff',
          }}
        >
          <Tabs.Tab title="溶氧" key="do" />
          <Tabs.Tab title="pH" key="ph" />
          <Tabs.Tab title="水温" key="temp" />
        </Tabs>
      </Card>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <DotLoading color="primary" />
        </div>
      )}

      {error && !loading && (
        <ErrorBlock status="default" title="加载失败" description={error} style={{ marginTop: 20 }} />
      )}

      {!loading && !error && (
        <Card style={{ borderRadius: 12 }} bodyStyle={{ padding: '12px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            {currentMetric.label} 趋势图
          </div>
          <DataChart
            data={data}
            dataKey={currentMetric.key}
            color={currentMetric.color}
            yLabel={currentMetric.yLabel}
            threshold={currentMetric.threshold}
            thresholdLabel={currentMetric.thresholdLabel}
          />
        </Card>
      )}

      {!loading && !error && data.length > 0 && (
        <Card style={{ borderRadius: 12, marginTop: 12 }} bodyStyle={{ padding: '12px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>数据明细</div>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa' }}>
                  <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #f0f0f0' }}>时间</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #f0f0f0' }}>{currentMetric.label}</th>
                </tr>
              </thead>
              <tbody>
                {data.slice(0, 50).map((item, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #fafafa' }}>
                    <td style={{ padding: '6px 8px', color: '#666' }}>{item.time}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 500 }}>
                      {item[currentMetric.key] !== null && item[currentMetric.key] !== undefined
                        ? item[currentMetric.key]
                        : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.length > 50 && (
              <div style={{ textAlign: 'center', padding: 8, fontSize: 12, color: '#999' }}>
                仅显示前50条记录
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}