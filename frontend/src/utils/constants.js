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
  aerator_command_failed: '增氧机命令下发失败',
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

// 增氧机状态：
//  - running:  设备 ack 确认启动成功
//  - stopped:  设备 ack 确认关闭
//  - pending:  命令已下发但尚未收到设备确认（最容易与 running 混淆，单独区分）
//  - fault:    设备回执失败
export const AERATOR_STATUS_MAP = {
  running: '已启动-自动模式',
  stopped: '已关闭',
  pending: '命令待确认',
  fault: '故障',
};

export const AERATOR_MODE_MAP = {
  auto: '自动模式',
  manual: '手动模式',
  off: '关闭模式',
};