import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Tabs, Card, DotLoading, ErrorBlock, Button, Toast } from 'antd-mobile';
import dayjs from 'dayjs';
import * as api from '../services/api';
import wsService from '../services/websocket';
import RealTimeCard from '../components/RealTimeCard';
import DataChart from '../components/DataChart';
import AeratorControl from '../components/AeratorControl';
import {
  DO_THRESHOLD_CRITICAL,
  DO_THRESHOLD_WARNING,
  FIRMWARE_ACK_SUPPORTED_HINT,
  FIRMWARE_NO_ACK_HINT
} from '../utils/constants';

// 详情页轮询周期（毫秒）：与列表页对齐，保证两个页面在窗口期内的数据一致
const POLL_INTERVAL_MS = 30000;

export default function PondDetailPage() {
  const { pondId } = useParams();
  const navigate = useNavigate();
  const [pond, setPond] = useState(null);
  const [realtimeData, setRealtimeData] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const pollTimerRef = useRef(null);

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
      const data = res?.data || res;
      // 兜底：万一 /api/data/:pondId/realtime 返回 null（比如 Redis 缓存被清空），
      // 仍能用 /api/ponds/:pondId 自带的 pond.realtime 顶上，确保页面不空白。
      setRealtimeData((prev) => {
        if (data && Object.keys(data).length > 0) return data;
        return prev;
      });
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
        // 数据源策略：详情页 DO/pH/水温 = /api/data/:pondId/realtime（控制态 + Redis 实时数据）
        // 兜底：若 /api/data 失败，用 /api/ponds/:pondId 自带的 pond.realtime（同源 Redis）顶上
        // 这样保证详情与列表卡片显示的数字来自同一份 Redis 快照。
        const [detailRes, realtimeRes, historyRes] = await Promise.all([
          api.getPondDetail(pondId).catch(() => null),
          api.getRealtimeData(pondId).catch(() => null),
          api.getHistoryData(pondId, {
            startTime: dayjs().subtract(24, 'hour').toISOString(),
            endTime: dayjs().toISOString(),
          }).catch(() => null),
        ]);

        const pondDoc = detailRes?.data || detailRes;
        setPond(pondDoc);

        const realtimeDoc = realtimeRes?.data || realtimeRes;
        if (realtimeDoc && Object.keys(realtimeDoc).length > 0) {
          setRealtimeData(realtimeDoc);
        } else if (pondDoc && pondDoc.realtime && Object.keys(pondDoc.realtime).length > 0) {
          setRealtimeData(pondDoc.realtime);
        } else {
          setRealtimeData({});
        }

        const historyList = historyRes?.data || historyRes || [];
        const list = Array.isArray(historyList) ? historyList : (historyList.list || []);
        const chartData = list.map((item) => ({
          time: dayjs(item.timestamp || item.time).format('HH:mm'),
          do: item.dissolvedOxygen ?? item.do,
          ph: item.ph,
          temp: item.temperature ?? item.temp,
        }));
        setHistoryData(chartData);
      } catch {
        setError('加载数据失败');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [pondId]);

  // 详情页轮询：保持与列表的实时数据"同源同频"
  useEffect(() => {
    pollTimerRef.current = setInterval(() => {
      fetchRealtimeData();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [fetchRealtimeData]);

  useEffect(() => {
    wsService.connect();

    const unsub = wsService.onRealtimeData((data) => {
      // WS 修复后 data.pondId 才有真实值；兼容字符串/数字
      if (
        data.pondId === pondId ||
        data.pondId === Number(pondId) ||
        String(data.pondId) === String(pondId)
      ) {
        setRealtimeData((prev) => ({ ...prev, ...data }));
        // 修复：固件 /data payload 现在携带 aeratorStatus 字段（设备读回 GPIO 实际电平）
        // 现场人工拉闸后 5 秒内会被 publishAeratorStateEvent 立即同步，
        // 30s 上报周期是兜底；这里同步到 pond 状态用于实时刷新 UI
        if (typeof data.aeratorStatus === 'boolean') {
          setPond((prev) => (prev ? { ...prev, aeratorStatus: data.aeratorStatus } : prev));
        }
      }
    });

    // 修复：监听设备状态变化广播（aerator_state_changed / status / ack），
    // 现场人工操作时固件 5s 内发布事件，后端广播后前端立即拉取最新 pond 状态
    const unsubStatus = wsService.onDeviceStatus((data) => {
      if (
        data.pondId !== pondId &&
        data.pondId !== Number(pondId) &&
        String(data.pondId) !== String(pondId)
      ) {
        return;
      }
      // 触发任意设备状态变化时，重新拉取 pond 详情以获取最新 aeratorStatus/pending/fault
      // 简单可靠，避免在前端维护额外的状态合并逻辑
      fetchPondDetail();
    });

    return () => {
      unsub();
      unsubStatus();
    };
  }, [pondId, fetchPondDetail]);

  const handleAeratorControl = async (pid, action) => {
    try {
      const res = await api.controlAerator(pid, action);
      // 后端返回的 message 已经区分"待设备确认"与"无回执超时兜底"
      const msg = res?.message || (action === 'start' ? '增氧机已开启' : '增氧机已关闭');
      Toast.show({ icon: 'success', content: msg });
      fetchRealtimeData();
    } catch (err) {
      // 优先展示后端 message
      const msg = err?.response?.data?.message || '操作失败，请重试';
      Toast.show({ icon: 'fail', content: msg });
      // 下发失败后刷新一次以同步 lastCommandFailReason 等
      fetchRealtimeData();
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
                    // 老固件无回执时会在超时后由后端乐观更新为 running/stopped，
                    // lastCommandNoAck 标记供文案"请现场核实"使用
                    if (data.commandPending) {
                      return <span style={{ color: '#faad14' }}>命令待确认（现场增氧机可能未启动）</span>;
                    }
                    if (data.aeratorStatusFault) {
                      return <span style={{ color: '#ff4d4f' }}>故障</span>;
                    }
                    const isRunning = data.aeratorStatus === true || data.aeratorStatus === 'running';
                    if (isRunning) {
                      return <span style={{ color: '#52c41a' }}>已启动-自动模式</span>;
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
              {data.commandPending && data.commandPendingExpiresAt && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>自动确认倒计时</span>
                  <span style={{ color: '#faad14' }}>
                    {dayjs(data.commandPendingExpiresAt).format('YYYY-MM-DD HH:mm:ss')}
                  </span>
                </div>
              )}
              {data.lastCommandFailReason && data.commandPending && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>失败原因</span>
                  <span style={{ color: '#ff4d4f' }}>{data.lastCommandFailReason}</span>
                </div>
              )}
              {/* 老固件无回执：超时后状态会乐观更新，但需要提示运维现场核实 */}
              {data.lastCommandNoAck && !data.commandPending && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>回执说明</span>
                  <span style={{ color: '#faad14', fontSize: 12 }}>无硬件回执，请现场核实</span>
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
            <Button
              block
              size="small"
              color="primary"
              onClick={() => navigate(`/review/${pondId}`)}
              style={{ borderRadius: 8 }}
            >
              周期复盘
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
                commandPendingExpiresAt={data.commandPendingExpiresAt || null}
                lastCommandNoAck={!!data.lastCommandNoAck}
                deviceFirmwareVersion={data.deviceFirmwareVersion || ''}
                onControl={handleAeratorControl}
              />
            </Card>

            {/* 终端固件能力卡：让运维知道"是否支持硬件回执"以解释为何"待确认"会自动恢复 */}
            <Card style={{ borderRadius: 12, marginTop: 12 }} bodyStyle={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>终端能力</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#555' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>固件版本</span>
                  <span>{data.deviceFirmwareVersion || '未上报'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>硬件回执</span>
                  <span style={{ color: data.lastCommandNoAck || !data.deviceFirmwareVersion ? '#faad14' : '#52c41a' }}>
                    {data.lastCommandNoAck || !data.deviceFirmwareVersion
                      ? '不支持（老固件）'
                      : '支持'}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                  {data.lastCommandNoAck || !data.deviceFirmwareVersion
                    ? FIRMWARE_NO_ACK_HINT
                    : FIRMWARE_ACK_SUPPORTED_HINT}
                </div>
              </div>
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