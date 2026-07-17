// 终端固件能力判定工具
// 背景：1.0.0 老固件不发布控制回执（pond/+/control/ack），后端永远等不到 ack，
//       commandPending 一直为 true，前端停留在"待确认"。
// 1.1.0 起固件会发送 control ack，后端可以走标准 ack 流程。
// 这里集中维护版本对比与能力判定逻辑，避免散落在多处。

// 支持控制回执的固件最低版本（>= 即支持）
const ACK_SUPPORTED_VERSION = '1.1.0';

// 通用 semver 对比：v1 > v2 返回 1；v1 < v2 返回 -1；相等返回 0
// 允许 "1.0"、"1.0.0"、"1.0.0-beta" 等格式，缺失段按 0 处理
function compareFirmwareVersion(v1, v2) {
  const normalize = (v) => String(v || '')
    .split('.')
    .map((s) => parseInt(s, 10) || 0);
  const parts1 = normalize(v1);
  const parts2 = normalize(v2);
  const len = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < len; i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

// 是否支持控制回执：固件版本 >= 1.1.0
// 未上报固件版本（空字符串、null）按老固件处理，避免误判
function supportsControlAck(firmwareVersion) {
  if (!firmwareVersion) return false;
  return compareFirmwareVersion(firmwareVersion, ACK_SUPPORTED_VERSION) >= 0;
}

// 控制命令等待回执的超时时间（毫秒）
// 老固件（无回执）使用短超时：MQTT 消息已到达 broker，3-5 秒足够设备执行继电器动作，
//   之后乐观更新 aeratorStatus，避免"待确认"一直停留
// 新固件（有回执）使用长超时：覆盖网络抖动与设备短暂离线
const COMMAND_ACK_TIMEOUT_OLD_FIRMWARE_MS = 5 * 1000;
const COMMAND_ACK_TIMEOUT_NEW_FIRMWARE_MS = 30 * 1000;

function getCommandAckTimeoutMs(firmwareVersion) {
  return supportsControlAck(firmwareVersion)
    ? COMMAND_ACK_TIMEOUT_NEW_FIRMWARE_MS
    : COMMAND_ACK_TIMEOUT_OLD_FIRMWARE_MS;
}

module.exports = {
  ACK_SUPPORTED_VERSION,
  compareFirmwareVersion,
  supportsControlAck,
  getCommandAckTimeoutMs,
  COMMAND_ACK_TIMEOUT_OLD_FIRMWARE_MS,
  COMMAND_ACK_TIMEOUT_NEW_FIRMWARE_MS
};
