import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, PullToRefresh, DotLoading, ErrorBlock, NoticeBar } from 'antd-mobile';
import dayjs from 'dayjs';
import * as api from '../services/api';
import wsService from '../services/websocket';
import { DO_THRESHOLD_CRITICAL, DO_THRESHOLD_WARNING } from '../utils/constants';

export default function DashboardPage() {
  const navigate = useNavigate();
  const [ponds, setPonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [alertBanner, setAlertBanner] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await api.getPonds();
      const pondList = res?.data || res || [];
      const pondsWithData = await Promise.all(
        pondList.map(async (pond) => {
          try {
            const latestRes = await api.getLatestData(pond.id);
            const latest = latestRes?.data || latestRes || {};
            return { ...pond, latestData: latest };
          } catch {
            return { ...pond, latestData: {} };
          }
        })
      );
      setPonds(pondsWithData);
    } catch (err) {
      setError('加载塘口数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    fetchUnreadAlerts();
  }, [fetchData]);

  useEffect(() => {
    wsService.connect();

    const unsub1 = wsService.onRealtimeData((data) => {
      setPonds((prev) =>
        prev.map((pond) => {
          if (pond.id === data.pondId) {
            return { ...pond, latestData: { ...pond.latestData, ...data } };
          }
          return pond;
        })
      );
    });

    const unsub2 = wsService.onAlert((data) => {
      fetchUnreadAlerts();
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  const fetchUnreadAlerts = async () => {
    try {
      const res = await api.getUnreadAlertCount();
      const count = res?.count || 0;
      if (count > 0) {
        setAlertBanner(`您有 ${count} 条未确认告警，请及时处理`);
      } else {
        setAlertBanner(null);
      }
    } catch {
      // ignore
    }
  };

  const getDOStatus = (doValue) => {
    if (doValue === null || doValue === undefined || doValue === '') return 'normal';
    const val = Number(doValue);
    if (val < DO_THRESHOLD_CRITICAL) return 'critical';
    if (val < DO_THRESHOLD_WARNING) return 'warning';
    return 'normal';
  };

  const getDOColor = (doValue) => {
    const val = Number(doValue);
    if (isNaN(val)) return '#333';
    if (val < DO_THRESHOLD_CRITICAL) return '#ff4d4f';
    if (val < DO_THRESHOLD_WARNING) return '#faad14';
    return '#333';
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <DotLoading color="primary" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorBlock
        status="default"
        title="加载失败"
        description={error}
        style={{ marginTop: 40 }}
      />
    );
  }

  return (
    <div style={{ padding: '12px 12px 0' }}>
      {alertBanner && (
        <NoticeBar
          content={alertBanner}
          color="error"
          style={{ marginBottom: 12, borderRadius: 8, cursor: 'pointer' }}
          onClick={() => navigate('/alerts')}
        />
      )}

      <PullToRefresh onRefresh={async () => { await fetchData(); }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ponds.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
              暂无塘口数据
            </div>
          )}

          {ponds.map((pond) => {
            const data = pond.latestData || {};
            const isOnline = pond.status === 'online' || pond.isOnline;
            const doStatus = getDOStatus(data.dissolvedOxygen ?? data.do);
            const doVal = data.dissolvedOxygen ?? data.do;
            const phVal = data.ph;
            const tempVal = data.temperature ?? data.temp;
            const aeratorRunning = data.aeratorStatus === 'running';
            const updateTime = data.updatedAt || data.timestamp;

            return (
              <Card
                key={pond.id}
                onClick={() => navigate(`/pond/${pond.id}`)}
                style={{ borderRadius: 12, cursor: 'pointer' }}
                bodyStyle={{ padding: '14px 16px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: isOnline ? '#52c41a' : '#d9d9d9',
                        display: 'inline-block',
                      }}
                    />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{pond.name}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: aeratorRunning ? '#52c41a' : '#999' }}>
                      {aeratorRunning ? '⚡ 增氧中' : '⏸ 增氧关'}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1.5, textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#999' }}>溶氧</div>
                    <div style={{ fontSize: 30, fontWeight: 700, color: getDOColor(doVal), lineHeight: 1.2 }}>
                      {doVal !== null && doVal !== undefined ? doVal : '--'}
                    </div>
                    <div style={{ fontSize: 10, color: '#999' }}>mg/L</div>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center', borderLeft: '1px solid #f0f0f0', borderRight: '1px solid #f0f0f0' }}>
                    <div style={{ fontSize: 11, color: '#999' }}>pH</div>
                    <div style={{ fontSize: 22, fontWeight: 600, color: '#333', lineHeight: 1.2, marginTop: 4 }}>
                      {phVal !== null && phVal !== undefined ? phVal : '--'}
                    </div>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#999' }}>水温</div>
                    <div style={{ fontSize: 22, fontWeight: 600, color: '#333', lineHeight: 1.2, marginTop: 4 }}>
                      {tempVal !== null && tempVal !== undefined ? tempVal : '--'}
                    </div>
                    <div style={{ fontSize: 10, color: '#999' }}>°C</div>
                  </div>
                </div>

                {updateTime && (
                  <div style={{ textAlign: 'right', marginTop: 8, fontSize: 11, color: '#bbb' }}>
                    更新于 {dayjs(updateTime).format('HH:mm:ss')}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </PullToRefresh>
    </div>
  );
}