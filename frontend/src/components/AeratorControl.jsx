import { useState } from 'react';
import { Button, Dialog, SpinLoading } from 'antd-mobile';
import { AERATOR_STATUS_MAP, AERATOR_MODE_MAP } from '../utils/constants';

export default function AeratorControl({ pondId, status = 'stopped', mode = 'auto', onControl }) {
  const [loading, setLoading] = useState(false);

  const isRunning = status === 'running';
  const isManual = mode === 'manual';

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
            background: isRunning ? '#52c41a' : '#d9d9d9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            boxShadow: isRunning ? '0 0 20px rgba(82,196,26,0.4)' : 'none',
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
        <div style={{ fontSize: 16, fontWeight: 600, color: isRunning ? '#52c41a' : '#999' }}>
          {AERATOR_STATUS_MAP[status] || status}
        </div>
        <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
          工作模式：{AERATOR_MODE_MAP[mode] || mode}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
        <Button
          color={isRunning ? 'danger' : 'primary'}
          size="large"
          loading={loading}
          disabled={!isManual}
          onClick={handleToggle}
          style={{ minWidth: 120, borderRadius: 20 }}
        >
          {loading ? <SpinLoading color="white" /> : isRunning ? '关闭增氧机' : '开启增氧机'}
        </Button>
      </div>

      {!isManual && mode !== 'off' && (
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