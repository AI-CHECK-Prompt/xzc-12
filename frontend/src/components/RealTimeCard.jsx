const statusColors = {
  normal: { bg: '#f6ffed', border: '#b7eb8f', text: '#52c41a', value: '#135200' },
  warning: { bg: '#fffbe6', border: '#ffe58f', text: '#faad14', value: '#ad6800' },
  critical: { bg: '#fff2f0', border: '#ffccc7', text: '#ff4d4f', value: '#a8071a' },
};

export default function RealTimeCard({ label, value, unit, status = 'normal', icon }) {
  const colors = statusColors[status] || statusColors.normal;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 100,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: '12px 10px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: colors.text }}>
        {icon && <span style={{ fontSize: 16 }}>{icon}</span>}
        <span style={{ fontSize: 12, fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: colors.value, lineHeight: 1.2 }}>
        {value !== null && value !== undefined ? value : '--'}
      </div>
      <div style={{ fontSize: 11, color: colors.text }}>{unit}</div>
    </div>
  );
}