import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Tabs, Card, DotLoading, ErrorBlock, Button, Toast } from 'antd-mobile';
import dayjs from 'dayjs';
import * as api from '../services/api';
import wsService from '../services/websocket';
import RealTimeCard from '../components/RealTimeCard';
import DataChart from '../components/DataChart';
import AeratorControl from '../components/AeratorControl';
import { DO_THRESHOLD_CRITICAL, DO_THRESHOLD_WARNING } from '../utils/constants';

export default function PondDetailPage() {
  const { pondId } = useParams();
  const navigate = useNavigate();
  const [pond, setPond] = useState(null);
  const [realtimeData, setRealtimeData] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchPondDetail = useCallback(async () => {
    try {
      const res = await api.getPondDetail(pondId);
      setPond(res?.data || res);
    } catch {
      // ignore
    }
  }, [pondId]);

  const fetchRealtimeData = useCallback(async () => {
    try {
      const res = await api.getRealtimeData(pondId);
      setRealtimeData(res?.data || res);
    } catch {
      // ignore
    }
  }, [pondId]);

  const fetchHistoryData = useCallback(async () => {
    try {
      const now = dayjs();
      const params = {
        startTime: now.subtract(24, 'hour').toISOString(),
        endTime: now.toISOString(),
      };
      const res = await api.getHistoryData(pondId, params);
      const list = res?.data || res || [];
      const chartData = (Array.isArray(list) ? list : []).map((item) => ({
        time: dayjs(item.timestamp || item.time).format('HH:mm'),
        do: item.dissolvedOxygen ?? item.do,
        ph: item.ph,
        temp: item.temperature ?? item.temp,
      }));
      setHistoryData(chartData);
    } catch {
      // ignore
    }
  }, [pondId]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        await Promise.all([fetchPondDetail(), fetchRealtimeData(), fetchHistoryData()]);
      } catch {
        setError('加载数据失败');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [fetchPondDetail, fetchRealtimeData, fetchHistoryData]);

  useEffect(() => {
    wsService.connect();

    const unsub = wsService.onRealtimeData((data) => {
      if (data.pondId === pondId || data.pondId === Number(pondId)) {
        setRealtimeData((prev) => ({ ...prev, ...data }));
      }
    });

    return () => unsub();
  }, [pondId]);

  const handleAeratorControl = async (pid, action) => {
    try {
      await api.controlAerator(pid, action);
      Toast.show({ icon: 'success', content: action === 'start' ? '增氧机已开启' : '增氧机已关闭' });
      fetchRealtimeData();
    } catch (err) {
      Toast.show({ icon: 'fail', content: '操作失败，请重试' });
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <DotLoading color="primary" />
      </div>
    );
  }

  if (error) {
    return <ErrorBlock status="default" title="加载失败" description={error} style={{ marginTop: 40 }} />;
  }

  const data = realtimeData || {};
  const doVal = data.dissolvedOxygen ?? data.do;
  const phVal = data.ph;
  const tempVal = data.temperature ?? data.temp;

  const getDOStatus = (val) => {
    const v = Number(val);
    if (isNaN(v)) return 'normal';
    if (v < DO_THRESHOLD_CRITICAL) return 'critical';
    if (v < DO_THRESHOLD_WARNING) return 'warning';
    return 'normal';
  };

  const getPHStatus = (val) => {
    const v = Number(val);
    if (isNaN(v)) return 'normal';
    if (v < 6.5 || v > 8.5) return 'warning';
    return 'normal';
  };

  return (
    <div style={{ padding: '12px' }}>
      <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>{pond?.name || '塘口详情'}</div>
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#666' }}>
          {pond?.area && <span>面积：{pond.area} 亩</span>}
          {pond?.species && <span>品种：{pond.species}</span>}
        </div>
      </Card>

      <Tabs
        defaultActiveKey="realtime"
        style={{
          '--title-font-size': '14px',
          '--active-title-color': '#1677ff',
          '--active-line-color': '#1677ff',
        }}
      >
        <Tabs.Tab title="实时数据" key="realtime">
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <RealTimeCard
              label="溶氧"
              value={doVal}
              unit="mg/L"
              status={getDOStatus(doVal)}
              icon="💧"
            />
            <RealTimeCard
              label="pH"
              value={phVal}
              unit=""
              status={getPHStatus(phVal)}
              icon="🧪"
            />
            <RealTimeCard
              label="水温"
              value={tempVal}
              unit="°C"
              status="normal"
              icon="🌡️"
            />
          </div>

          <Card style={{ borderRadius: 12, marginTop: 12 }} bodyStyle={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>数据详情</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: '#555' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>更新时间</span>
                <span>{data.updatedAt || data.timestamp ? dayjs(data.updatedAt || data.timestamp).format('YYYY-MM-DD HH:mm:ss') : '--'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>设备状态</span>
                <span style={{ color: pond?.isOnline || pond?.status === 'online' ? '#52c41a' : '#d9d9d9' }}>
                  {pond?.isOnline || pond?.status === 'online' ? '在线' : '离线'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>增氧机</span>
                <span>
                  {(() => {
                    // 增氧机状态展示：
                    // 优先级：commandPending=true 视为 pending（避免"假启动"误导）
                    // 其次根据 aeratorStatus 布尔或字符串
                    if (data.commandPending) {
                      return <span style={{ color: '#faad14' }}>命令待确认（现场增氧机可能未启动）</span>;
                    }
                    const isRunning = data.aeratorStatus === true || data.aeratorStatus === 'running';
                    if (isRunning) {
                      return <span style={{ color: '#52c41a' }}>已启动-自动模式</span>;
                    }
                    if (data.aeratorStatus === 'fault' || data.aeratorStatusFault) {
                      return <span style={{ color: '#ff4d4f' }}>故障</span>;
                    }
                    return <span style={{ color: '#999' }}>已关闭</span>;
                  })()}
                </span>
              </div>
              {data.commandPending && data.lastCommandTime && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>命令下发时间</span>
                  <span style={{ color: '#faad14' }}>
                    {dayjs(data.lastCommandTime).format('YYYY-MM-DD HH:mm:ss')}
                  </span>
                </div>
              )}
              {data.lastCommandFailReason && data.commandPending && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>失败原因</span>
                  <span style={{ color: '#ff4d4f' }}>{data.lastCommandFailReason}</span>
                </div>
              )}
            </div>
          </Card>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button
              block
              size="small"
              fill="none"
              onClick={() => navigate(`/history/${pondId}`)}
              style={{ borderRadius: 8, border: '1px solid #1677ff', color: '#1677ff' }}
            >
              查看历史数据
            </Button>
          </div>
        </Tabs.Tab>

        <Tabs.Tab title="数据曲线" key="chart">
          <div style={{ marginTop: 12 }}>
            <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '12px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>溶氧 (mg/L) - 近24小时</div>
              <DataChart
                data={historyData}
                dataKey="do"
                color="#1677ff"
                yLabel="mg/L"
                threshold={DO_THRESHOLD_WARNING}
                thresholdLabel={`预警线 ${DO_THRESHOLD_WARNING}`}
              />
            </Card>

            <Card style={{ borderRadius: 12, marginBottom: 12 }} bodyStyle={{ padding: '12px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>pH - 近24小时</div>
              <DataChart
                data={historyData}
                dataKey="ph"
                color="#52c41a"
                yLabel="pH"
              />
            </Card>

            <Card style={{ borderRadius: 12 }} bodyStyle={{ padding: '12px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>水温 (°C) - 近24小时</div>
              <DataChart
                data={historyData}
                dataKey="temp"
                color="#faad14"
                yLabel="°C"
              />
            </Card>
          </div>
        </Tabs.Tab>

        <Tabs.Tab title="设备控制" key="control">
          <div style={{ marginTop: 12 }}>
            <Card style={{ borderRadius: 12 }} bodyStyle={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>增氧机控制</div>
              <AeratorControl
                pondId={pondId}
                status={
                  // 优先：commandPending 时显示 pending，避免"假启动"误显示为 running
                  data.commandPending
                    ? 'pending'
                    : data.aeratorStatusFault
                    ? 'fault'
                    : data.aeratorStatus === true || data.aeratorStatus === 'running'
                    ? 'running'
                    : 'stopped'
                }
                mode={data.aeratorMode || 'auto'}
                onControl={handleAeratorControl}
              />
            </Card>

            {pond?.devices && pond.devices.length > 0 && (
              <Card style={{ borderRadius: 12, marginTop: 12 }} bodyStyle={{ padding: '14px 16px' }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>设备信息</div>
                {pond.devices.map((device, idx) => (
                  <div
                    key={device.id || idx}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '8px 0',
                      borderBottom: idx < pond.devices.length - 1 ? '1px solid #f5f5f5' : 'none',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: '#666' }}>{device.name || device.type}</span>
                    <span style={{ color: device.status === 'online' ? '#52c41a' : '#d9d9d9' }}>
                      {device.status === 'online' ? '在线' : '离线'}
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </div>
        </Tabs.Tab>
      </Tabs>
    </div>
  );
}