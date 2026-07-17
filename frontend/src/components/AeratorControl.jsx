import { useState, useEffect, useMemo } from 'react';
import { Button, Dialog, SpinLoading } from 'antd-mobile';
import { AERATOR_STATUS_MAP, AERATOR_MODE_MAP, FIRMWARE_NO_ACK_HINT } from '../utils/constants';

export default function AeratorControl({
  pondId,
  status = 'stopped',
  mode = 'auto',
  // 倒计时与回执能力（修复"待确认"永久停留问题）
  commandPendingExpiresAt = null,
  lastCommandNoAck = false,
  deviceFirmwareVersion = '',
  onControl
}) {
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 兼容 boolean 类型（老数据）以及字符串枚举
  const normalizeStatus = (s) => {
    if (s === true) return 'running';
    if (s === false) return 'stopped';
    return s || 'stopped';
  };
  const normalizedStatus = normalizeStatus(status);
  const isRunning = normalizedStatus === 'running';
  const isPending = normalizedStatus === 'pending';
  const isFault = normalizedStatus === 'fault';
  const isManual = mode === 'manual';

  // pending 状态下禁止重复点击：避免在设备未确认时反复下发
  const buttonDisabled = !isManual || isPending || loading;

  // 倒计时：每秒刷新一次；当 deadline 已过则停止更新
  useEffect(() => {
    if (!isPending) return undefined;
    const deadline = commandPendingExpiresAt ? new Date(commandPendingExpiresAt).getTime() : null;
    if (!deadline) return undefined;
    setNow(Date.now());
    const t = setInterval(() => {
      const cur = Date.now();
      setNow(cur);
      // 倒计时归零即停，由后端超时巡检或后端 ack 来推进状态，前端不再重复 tick
      if (cur >= deadline) {
        clearInterval(t);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [isPending, commandPendingExpiresAt]);

  const remainingSeconds = useMemo(() => {
    if (!isPending || !commandPendingExpiresAt) return null;
    const deadline = new Date(commandPendingExpiresAt).getTime();
    const diff = Math.max(0, Math.round((deadline - now) / 1000));
    return diff;
  }, [isPending, commandPendingExpiresAt, now]);

  const handleToggle = async () => {
    const action = isRunning ? 'stop' : 'start';
    const actionLabel = isRunning ? '关闭' : '开启';

    const confirmed = await Dialog.confirm({
      title: '确认操作',
      content: `确定要${actionLabel}增氧机吗？`,
      confirmText: '确定',
      cancelText: '取消',
    });

    if (!confirmed) return;

    setLoading(true);
    try {
      if (onControl) {
        await onControl(pondId, action);
      }
    } finally {
      setLoading(false);
    }
  };

  // pending 与 fault 使用警示色；running 使用绿色
  const ringColor = isRunning ? '#52c41a' : isPending ? '#faad14' : isFault ? '#ff4d4f' : '#d9d9d9';
  const textColor = isRunning ? '#52c41a' : isPending ? '#faad14' : isFault ? '#ff4d4f' : '#999';
  const boxShadow = isRunning
    ? '0 0 20px rgba(82,196,26,0.4)'
    : isPending
    ? '0 0 20px rgba(250,173,20,0.4)'
    : 'none';

  return (
    <div style={{ padding: '16px 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: '50%',
            background: ringColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            boxShadow,
          }}
        >
          {isRunning ? (
            <div
              style={{
                width: 40,
                height: 40,
                border: '4px solid #fff',
                borderRadius: '50%',
                borderTopColor: 'transparent',
                animation: 'spin 1s linear infinite',
              }}
            />
          ) : isPending ? (
            // pending：脉动效果，提示"等待设备确认"
            <div
              style={{
                width: 40,
                height: 40,
                border: '4px solid #fff',
                borderRadius: '50%',
                borderTopColor: 'transparent',
                animation: 'spin 1.5s linear infinite',
                opacity: 0.85,
              }}
            />
          ) : (
            <div
              style={{
                width: 40,
                height: 40,
                border: '4px solid #fff',
                borderRadius: '50%',
              }}
            />
          )}
        </div>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: textColor }}>
          {AERATOR_STATUS_MAP[normalizedStatus] || status}
        </div>
        <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
          工作模式：{AERATOR_MODE_MAP[mode] || mode}
        </div>
        {isPending && (
          <div style={{ fontSize: 12, color: '#faad14', marginTop: 6 }}>
            {lastCommandNoAck
              ? `命令已下发，终端固件 ${deviceFirmwareVersion || '未知'} 不支持硬件回执，${FIRMWARE_NO_ACK_HINT}`
              : '命令已下发，正在等待设备确认，请关注现场增氧机是否实际启动'}
            {remainingSeconds !== null && (
              <span style={{ marginLeft: 6, color: '#faad14' }}>
                （剩余 {remainingSeconds}s）
              </span>
            )}
          </div>
        )}
        {isFault && (
          <div style={{ fontSize: 12, color: '#ff4d4f', marginTop: 6 }}>
            设备回执失败，状态未确认，请现场检查硬件
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
        <Button
          color={isRunning ? 'danger' : 'primary'}
          size="large"
          loading={loading}
          disabled={buttonDisabled}
          onClick={handleToggle}
          style={{ minWidth: 120, borderRadius: 20 }}
        >
          {loading ? <SpinLoading color="white" /> : isRunning ? '关闭增氧机' : '开启增氧机'}
        </Button>
      </div>

      {!isManual && mode !== 'off' && !isPending && (
        <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: '#999' }}>
          当前为{AERATOR_MODE_MAP[mode]}，请切换至手动模式后操作
        </div>
      )}

      {mode === 'off' && (
        <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: '#999' }}>
          增氧机控制已关闭
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}