export const DO_THRESHOLD_CRITICAL = 3.0;
export const DO_THRESHOLD_WARNING = 4.0;
export const PH_MIN = 6.5;
export const PH_MAX = 8.5;
export const TEMP_MIN = 10;
export const TEMP_MAX = 32;

export const ALERT_TYPE_MAP = {
  low_oxygen: '低溶氧告警',
  high_ph: 'pH偏高告警',
  low_ph: 'pH偏低告警',
  high_temp: '水温偏高告警',
  low_temp: '水温偏低告警',
  device_offline: '设备离线告警',
  aerator_fault: '增氧机故障',
  power_failure: '断电告警',
};

export const ALERT_LEVEL_COLOR = {
  critical: '#ff4d4f',
  warning: '#faad14',
  info: '#1890ff',
};

export const ALERT_LEVEL_LABEL = {
  critical: '严重',
  warning: '警告',
  info: '提示',
};

export const AERATOR_STATUS_MAP = {
  running: '运行中',
  stopped: '已关闭',
  fault: '故障',
};

export const AERATOR_MODE_MAP = {
  auto: '自动模式',
  manual: '手动模式',
  off: '关闭模式',
};