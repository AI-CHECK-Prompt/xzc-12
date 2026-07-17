// 定时巡检：兜底老固件无回执导致的"待确认"状态永久停留
// 设计：
// - 每 2s 扫描一次 Pond 中 commandPending=true 且 commandPendingExpiresAt<now 的塘口
// - 对每条过期 pending：
//    * 老固件（lastCommandNoAck=true）：乐观更新 aeratorStatus，
//      前端从"待确认"切到 running/stopped，并展示"老固件无回执，请现场确认"提示
//    * 新固件（lastCommandNoAck=false）：标记 aeratorStatusFault=true
//      （设备应该 ack 但没回，可能真故障，运维需排查）
// - 通过 WebSocket 广播 device_status，触发前端刷新
// 关键修复：解决"运维人员反复刷新页面看到的状态一直是'待确认'"

const Pond = require('../models/Pond');
const { broadcastDeviceStatus } = require('./websocket');
const { supportsControlAck } = require('../utils/firmware');

const CHECK_INTERVAL_MS = 2000;
let timer = null;

async function checkPendingCommands() {
  try {
    const now = new Date();
    // 只查还处于 pending 且过期、未收到 ack 的塘口
    const expired = await Pond.find({
      commandPending: true,
      commandPendingExpiresAt: { $ne: null, $lte: now }
    }).lean();

    if (!expired || expired.length === 0) return;

    for (const pond of expired) {
      // 二次检查：避免在 await 期间被 ack 清掉（防止与 handleControlAck 竞争）
      const fresh = await Pond.findOne({ pondId: pond.pondId });
      if (!fresh || !fresh.commandPending) continue;
      if (!fresh.commandPendingExpiresAt || fresh.commandPendingExpiresAt > now) continue;

      const noAck = !!fresh.lastCommandNoAck;
      const cmd = fresh.lastCommand;
      const hasAck = supportsControlAck(fresh.deviceFirmwareVersion);

      const update = {
        $set: {
          commandPending: false,
          commandPendingExpiresAt: null,
          // 不再是"待确认"，但保留 lastCommandNoAck 标记供前端展示
          lastCommandFailReason: noAck
            ? 'device_no_ack_firmware_legacy'
            : 'device_ack_timeout'
        }
      };

      if (noAck) {
        // 老固件无回执：MQTT 已经下发成功，乐观认为设备已执行
        // 同时保留 lastCommandNoAck=true 让前端提示"无回执请现场确认"
        // 修复模式覆盖 bug：超时兜底只能确认动作执行结果，不能改变用户设置的增氧机模式。
        // 此前会把 manual 模式强行改为 auto，导致运维人员设置的模式丢失。
        if (cmd === 'aerator_on') {
          update.$set.aeratorStatus = true;
        } else if (cmd === 'aerator_off') {
          update.$set.aeratorStatus = false;
        }
      } else {
        // 新固件应该回执但没回：标记 fault，让前端显示红色故障状态
        if (cmd === 'aerator_on') {
          // 启动未确认：不能乐观认为已启动，置 fault 提示运维
          update.$set.aeratorStatusFault = true;
        } else if (cmd === 'aerator_off') {
          // 关闭未确认：保守起见置 fault，提示现场可能仍在运行
          update.$set.aeratorStatusFault = true;
        }
      }

      await Pond.findOneAndUpdate({ pondId: pond.pondId }, update);
      broadcastDeviceStatus(pond.pondId, noAck ? 'control_auto_confirmed' : 'control_ack_timeout');

      console.log(
        `[命令超时] ${pond.pondId} 命令 ${cmd} 超时（hasAck=${hasAck}, lastCommandNoAck=${noAck}），` +
        (noAck
          ? `乐观更新 aeratorStatus=${cmd === 'aerator_on' ? true : false}，前端展示"老固件无回执"`
          : `标记 aeratorStatusFault=true，提示运维现场排查`)
      );
    }
  } catch (err) {
    console.error('[命令超时] 巡检失败:', err.message);
  }
}

function startCommandTimeoutChecker() {
  if (timer) return;
  timer = setInterval(checkPendingCommands, CHECK_INTERVAL_MS);
  console.log(`[命令超时] 巡检已启动，间隔 ${CHECK_INTERVAL_MS}ms`);
}

function stopCommandTimeoutChecker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startCommandTimeoutChecker,
  stopCommandTimeoutChecker,
  checkPendingCommands
};
