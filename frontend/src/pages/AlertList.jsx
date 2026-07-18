import { useState, useEffect, useCallback } from 'react';
import { List, Tag, Button, DotLoading, ErrorBlock, Selector, InfiniteScroll, Toast } from 'antd-mobile';
import dayjs from 'dayjs';
import * as api from '../services/api';
import { ALERT_TYPE_MAP, ALERT_LEVEL_COLOR, ALERT_LEVEL_LABEL } from '../utils/constants';

const PAGE_SIZE = 20;

export default function AlertListPage() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [pondFilter, setPondFilter] = useState('all');
  const [ponds, setPonds] = useState([]);

  const fetchPonds = async () => {
    try {
      const res = await api.getPonds();
      const list = res?.data || res || [];
      setPonds(list);
    } catch {
      // ignore
    }
  };

  const fetchAlerts = useCallback(async (pageNum = 1, append = false) => {
    try {
      setError(null);
      const params = {
        page: pageNum,
        pageSize: PAGE_SIZE,
      };
      if (statusFilter !== 'all') {
        params.acknowledged = statusFilter === 'acknowledged';
      }
      if (pondFilter !== 'all') {
        params.pondId = pondFilter;
      }

      const res = await api.getAlerts(params);
      const list = res?.data?.list || res?.data || res || [];
      const total = res?.data?.total ?? res?.total;

      if (append) {
        setAlerts((prev) => [...prev, ...list]);
      } else {
        setAlerts(list);
      }

      setHasMore(list.length === PAGE_SIZE);
    } catch {
      setError('加载告警列表失败');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, pondFilter]);

  useEffect(() => {
    fetchPonds();
  }, []);

  useEffect(() => {
    setLoading(true);
    setPage(1);
    setAlerts([]);
    setHasMore(true);
    fetchAlerts(1, false);
  }, [fetchAlerts]);

  const handleAcknowledge = async (alertId) => {
    try {
      await api.acknowledgeAlert(alertId);
      Toast.show({ icon: 'success', content: '已确认' });
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a))
      );
    } catch {
      Toast.show({ icon: 'fail', content: '操作失败' });
    }
  };

  const loadMore = async () => {
    const nextPage = page + 1;
    setPage(nextPage);
    await fetchAlerts(nextPage, true);
  };

  const pondOptions = [
    { label: '全部塘口', value: 'all' },
    ...ponds.map((p) => ({ label: p.name, value: p.id })),
  ];

  if (loading && alerts.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <DotLoading color="primary" />
      </div>
    );
  }

  if (error && alerts.length === 0) {
    return <ErrorBlock status="default" title="加载失败" description={error} style={{ marginTop: 40 }} />;
  }

  return (
    <div style={{ padding: '12px', paddingBottom: 60 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>状态筛选</div>
        <Selector
          options={[
            { label: '全部', value: 'all' },
            { label: '未确认', value: 'unacknowledged' },
            { label: '已确认', value: 'acknowledged' },
          ]}
          value={[statusFilter]}
          onChange={(arr) => {
            if (arr.length > 0) setStatusFilter(arr[0]);
          }}
          style={{ '--border-radius': '8px' }}
        />
      </div>

      {pondOptions.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>塘口筛选</div>
          <Selector
            options={pondOptions}
            value={[pondFilter]}
            onChange={(arr) => {
              if (arr.length > 0) setPondFilter(arr[0]);
            }}
            style={{ '--border-radius': '8px' }}
          />
        </div>
      )}

      {alerts.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
          暂无告警记录
        </div>
      )}

      <List style={{ borderRadius: 12, overflow: 'hidden' }}>
        {alerts.map((alert) => {
          const levelColor = ALERT_LEVEL_COLOR[alert.level] || '#999';
          const levelLabel = ALERT_LEVEL_LABEL[alert.level] || alert.level;
          const typeLabel = ALERT_TYPE_MAP[alert.type] || alert.type;

          return (
            <List.Item
              key={alert.id}
              prefix={
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    background: levelColor,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 18,
                    flexShrink: 0,
                  }}
                >
                  ⚠
                </div>
              }
              extra={
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <Tag color={alert.acknowledged ? 'default' : 'danger'} style={{ fontSize: 11 }}>
                    {alert.acknowledged ? '已确认' : '未确认'}
                  </Tag>
                  {!alert.acknowledged && (
                    <Button
                      size="mini"
                      color="primary"
                      fill="none"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAcknowledge(alert.id);
                      }}
                    >
                      确认
                    </Button>
                  )}
                </div>
              }
              style={{ padding: '12px 16px' }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{typeLabel}</div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>
                {alert.pondName || `塘口 #${alert.pondId}`}
              </div>
              <div style={{ fontSize: 12, color: '#333', marginBottom: 4 }}>{alert.message}</div>
              <div style={{ fontSize: 11, color: '#bbb' }}>
                {(() => {
                  // 修复：优先使用 detectedAt（设备真实检测时间），缺失时回退到 createdAt
                  // 解决"运维现场处理时间早于平台告警时间"的时序错乱问题
                  const displayTime = alert.detectedAt || alert.createdAt || alert.timestamp;
                  return displayTime ? dayjs(displayTime).format('YYYY-MM-DD HH:mm:ss') : '';
                })()}
              </div>
            </List.Item>
          );
        })}
      </List>

      <InfiniteScroll loadMore={loadMore} hasMore={hasMore} />
    </div>
  );
}