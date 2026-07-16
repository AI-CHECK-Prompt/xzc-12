import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';

export default function DataChart({ data, dataKey, color = '#1677ff', yLabel, threshold, thresholdLabel }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
        暂无数据
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11 }}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11 }}
          label={
            yLabel
              ? { value: yLabel, angle: -90, position: 'insideLeft', style: { fontSize: 11 } }
              : undefined
          }
        />
        <Tooltip
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
          labelStyle={{ fontWeight: 'bold' }}
        />
        {threshold !== undefined && (
          <ReferenceLine
            y={threshold}
            stroke="#ff4d4f"
            strokeDasharray="5 5"
            label={
              thresholdLabel
                ? { value: thresholdLabel, position: 'right', fontSize: 11, fill: '#ff4d4f' }
                : undefined
            }
          />
        )}
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}