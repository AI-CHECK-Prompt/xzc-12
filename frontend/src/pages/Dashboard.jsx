import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, PullToRefresh, DotLoading, ErrorBlock, NoticeBar, Selector } from 'antd-mobile';
import dayjs from 'dayjs';
import * as api from '../services/api';
import wsService from '../services/websocket';
import { DO_THRESHOLD_CRITICAL, DO_THRESHOLD_WARNING } from '../utils/constants';

// 列表页轮询周期（毫秒）
// 原因：设备以 30~60s 间隔上报，列表 30s 轮询一次即可保证用户不会看到"列表旧值、详情新值"的撕裂。
const POLL_INTERVAL_MS = 30000;

export default function DashboardPage() {
  const navigate = useNavigate();
  const [ponds, setPonds] = useState([]);
  // allPonds：未筛选的全量塘口，用于构建"养殖品种"下拉的可选项
  // （避免下拉值随筛选结果动态消失，造成"选了之后再选别的"清空）
  const [allPonds, setAllPonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [alertBanner, setAlertBanner] = useState(null);
  // 筛选条件：'all' 表示不限
  const [speciesFilter, setSpeciesFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const pollTimerRef = useRef(null);

  // 拉取全量塘口（用于构建筛选下拉的可选项；与列表筛选解耦，避免下拉值随筛选结果消失）
  const fetchAllPonds = useCallback(async () => {
    try {
      const res = await api.getPonds();
      const pondList = res?.data || res || [];
      setAllPonds(pondList);
    } catch {
      // 静默失败：下拉为空时降级为只显示"全部"选项，不影响主流程
    }
  }, []);

  // 按当前筛选条件拉取列表
  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const params = {};
      if (speciesFilter !== 'all') params.species = speciesFilter;
      if (statusFilter !== 'all') params.status = statusFilter;
      const res = await api.getPonds(params);
      const pondList = res?.data || res || [];

      // 数据源统一：直接采用后端 /api/ponds 返回的 pond.realtime（来自 Redis），
      // 不再额外请求 /api/ponds/:id/latest（该路径在前端 api.js 修复前一直 404，
      // 修复后也仍然是另一份独立数据，与详情 pond.realtime 来源/时机不同步）。
      // 这样列表与详情都用 pond.realtime（同一份 Redis 快照）→ 数据源 + 时机一致。
      const pondsWithData = pondList.map((pond) => {
        // 兼容历史响应：可能没有 realtime 字段（旧版本或 Redis 缺失）
        const realtime = pond.realtime && Object.keys(pond.realtime).length > 0
          ? pond.realtime
          : (pond.latestData || {});
        return { ...pond, latestData: realtime };
      });
      setPonds(pondsWithData);
    } catch (err) {
      setError('加载塘口数据失败');
    } finally {
      setLoading(false);
    }
  }, [speciesFilter, statusFilter]);

  useEffect(() => {
    fetchData();
    fetchAllPonds();
    fetchUnreadAlerts();
  }, [fetchData, fetchAllPonds]);

  // 从全量数据中提取实际出现过的品种（去重 + 排序）
  const speciesOptions = useMemo(() => {
    const set = new Set();
    allPonds.forEach((p) => {
      if (p.species && String(p.species).trim()) set.add(String(p.species).trim());
    });
    const list = Array.from(set).sort();
    return [
      { label: '全部', value: 'all' },
      ...list.map((s) => ({ label: s, value: s }))
    ];
  }, [allPonds]);

  // 轮询拉取，保证列表数据不会长时间滞后于详情
  useEffect(() => {
    pollTimerRef.current = setInterval(() => {
      fetchData();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [fetchData]);

  // 用户从详情页返回列表时立即刷新一次（visibilitychange / pageshow）
  useEffect(() => {
    const handleVisible = () => {
      if (document.visibilityState === 'visible') {
        fetchData();
      }
    };
    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('pageshow', handleVisible);
    return () => {
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('pageshow', handleVisible);
    };
  }, [fetchData]);

  useEffect(() => {
    wsService.connect();

    const unsub1 = wsService.onRealtimeData((data) => {
      // WS 修复后 data.pondId 才会有值，过滤命中目标塘口
      // 兼容 pondId 可能是字符串/数字
      const targetPondId = data.pondId;
      if (targetPondId === undefined || targetPondId === null) return;
      setPonds((prev) =>
        prev.map((pond) => {
          if (pond.pondId === targetPondId || String(pond.pondId) === String(targetPondId)) {
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

      {/* 筛选区：品种 + 状态，两个条件为 AND 关系 */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>养殖品种</div>
        <Selector
          options={speciesOptions}
          value={[speciesFilter]}
          onChange={(arr) => {
            if (arr.length > 0) setSpeciesFilter(arr[0]);
          }}
          style={{ '--border-radius': '8px' }}
        />
        <div style={{ fontSize: 12, color: '#999', margin: '10px 0 6px' }}>塘口状态</div>
        <Selector
          options={[
            { label: '全部', value: 'all' },
            { label: '在线', value: 'online' },
            { label: '离线', value: 'offline' }
          ]}
          value={[statusFilter]}
          onChange={(arr) => {
            if (arr.length > 0) setStatusFilter(arr[0]);
          }}
          style={{ '--border-radius': '8px' }}
        />
        {(speciesFilter !== 'all' || statusFilter !== 'all') && (
          <div
            onClick={() => {
              setSpeciesFilter('all');
              setStatusFilter('all');
            }}
            style={{ fontSize: 12, color: '#1677ff', marginTop: 10, textAlign: 'right', cursor: 'pointer' }}
          >
            清除筛选
          </div>
        )}
      </div>

      <PullToRefresh onRefresh={async () => { await fetchData(); }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ponds.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
              {speciesFilter !== 'all' || statusFilter !== 'all'
                ? '当前筛选条件下无塘口数据'
                : '暂无塘口数据'}
            </div>
          )}

          {ponds.map((pond) => {
            const data = pond.latestData || {};
            const isOnline = pond.status === 'online' || pond.isOnline;
            const doStatus = getDOStatus(data.dissolvedOxygen ?? data.do);
            const doVal = data.dissolvedOxygen ?? data.do;
            const phVal = data.ph;
            const tempVal = data.temperature ?? data.temp;
            // 增氧机状态兼容：布尔/字符串均识别，与 PondDetail 保持一致
            const aeratorRunning =
              data.aeratorStatus === true ||
              data.aeratorStatus === 'running' ||
              data.aeratorStatus === 'true';
            const updateTime = data.updatedAt || data.timestamp;
            // 业务主键使用 pondId，不要用 MongoDB _id
            const pondKey = pond.pondId || pond.id;

            return (
              <Card
                key={pondKey}
                onClick={() => navigate(`/pond/${pondKey}`)}
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