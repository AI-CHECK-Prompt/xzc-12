const express = require('express');
const Pond = require('../models/Pond');
const Alert = require('../models/Alert');
const { authMiddleware, requireOperator } = require('../middleware/auth');
const { publishControl } = require('../services/mqttClient');
const { broadcastAlert, broadcastDeviceStatus } = require('../services/websocket');
const { isAlertDuplicate, markAlertSent } = require('../services/redisClient');
const { supportsControlAck, getCommandAckTimeoutMs } = require('../utils/firmware');

const router = express.Router();

// POST /api/control/:pondId/aerator - 远程控制增氧机
// 修复"假启动"：先 publish 等待 broker ack，成功后才更新 DB；失败时返回错误给前端
router.post('/:pondId/aerator', authMiddleware, requireOperator, async (req, res) => {
  try {
    const { action } = req.body;

    if (!action || !['on', 'off'].includes(action)) {
      return res.status(400).json({ success: false, message: '无效的操作，请使用 on 或 off' });
    }

    const pond = await Pond.findOne({ pondId: req.params.pondId });
    if (!pond) {
      return res.status(404).json({ success: false, message: '塘口不存在' });
    }

    const command = action === 'on' ? 'aerator_on' : 'aerator_off';

    // 终端固件能力判定：是否支持控制回执
    // 老固件（无回执）走"短超时+乐观更新"；新固件（>=1.1.0）走"长超时+ack"
    const hasAck = supportsControlAck(pond.deviceFirmwareVersion);
    const ackTimeoutMs = getCommandAckTimeoutMs(pond.deviceFirmwareVersion);

    // 1) 先发 MQTT 命令并等待真实结果
    const pubResult = await publishControl(req.params.pondId, command);

    if (!pubResult.success) {
      // 下发失败：不更新 DB 状态，给前端明确错误
      console.error(`[控制增氧机] ${req.params.pondId} 命令下发失败：${pubResult.message}`);

      // 记录 critical 告警（去重）
      const dup = await isAlertDuplicate(req.params.pondId, 'aerator_command_failed');
      if (!dup) {
        const alert = new Alert({
          pondId: req.params.pondId,
          type: 'aerator_command_failed',
          level: 'critical',
          value: 0,
          threshold: 0,
          message: `增氧机${action === 'on' ? '启动' : '关闭'}命令下发失败（${pubResult.reason}），请检查 MQTT/网络/设备`
        });
        await alert.save();
        await markAlertSent(req.params.pondId, 'aerator_command_failed');
        broadcastAlert(alert.toObject());
      }

      // 标记 pending 状态，前端展示"命令待确认"
      // 注意：下发失败时仍设置短超时，便于 commandTimeoutChecker 在 5s 后清除
      // 避免 MQTT 长期断开导致"待确认"永远停留
      const failDeadline = new Date(Date.now() + getCommandAckTimeoutMs(pond.deviceFirmwareVersion));
      await Pond.findOneAndUpdate(
        { pondId: req.params.pondId },
        {
          $set: {
            commandPending: true,
            commandPendingExpiresAt: failDeadline,
            lastCommand: command,
            lastCommandId: pubResult.commandId || '',
            lastCommandTime: new Date(),
            lastCommandFailReason: pubResult.reason || 'unknown',
            lastCommandNoAck: !hasAck
          }
        }
      );
      broadcastDeviceStatus(req.params.pondId, 'control_pending');

      return res.status(503).json({
        success: false,
        code: 'MQTT_PUBLISH_FAILED',
        message: `命令下发失败：${pubResult.message}，请检查设备/网络后重试`,
        data: {
          pondId: req.params.pondId,
          command,
          mqttSent: false,
          reason: pubResult.reason,
          firmwareVersion: pond.deviceFirmwareVersion || '',
          firmwareSupportsAck: hasAck
        }
      });
    }

    // 2) 下发成功：根据固件能力走不同状态流转
    // - 老固件：短超时（5s）后由 commandTimeoutChecker 乐观更新 aeratorStatus
    //   并设置 lastCommandNoAck=true，前端展示"已下发但无硬件回执，请现场确认"
    // - 新固件：长超时（30s）内若未收到 ack，标记 fault（设备可能真故障）
    const expiresAt = new Date(Date.now() + ackTimeoutMs);
    const update = {
      $set: {
        commandPending: true,
        commandPendingExpiresAt: expiresAt,
        lastCommand: command,
        lastCommandId: pubResult.commandId,
        lastCommandTime: new Date(),
        lastCommandFailReason: '',
        aeratorMode: 'manual',
        aeratorStatusFault: false,
        // 老固件：标记无回执，timeout 兜底后此标记用于前端文案
        lastCommandNoAck: !hasAck
      }
    };
    await Pond.findOneAndUpdate({ pondId: req.params.pondId }, update);

    res.json({
      success: true,
      data: {
        pondId: req.params.pondId,
        command,
        commandId: pubResult.commandId,
        mqttSent: true,
        commandPending: true,
        commandPendingExpiresAt: expiresAt.toISOString(),
        firmwareVersion: pond.deviceFirmwareVersion || '',
        firmwareSupportsAck: hasAck,
        // 前端按此字段提示
        message: hasAck
          ? '命令已下发到设备，请等待设备确认'
          : `命令已下发（终端固件 ${pond.deviceFirmwareVersion || '未知'} 不支持硬件回执，${Math.round(ackTimeoutMs / 1000)}s 后将自动确认状态，请现场核实）`
      },
      message: hasAck
        ? `增氧机${action === 'on' ? '启动' : '关闭'}命令已下发，等待设备确认`
        : `增氧机${action === 'on' ? '启动' : '关闭'}命令已下发，${Math.round(ackTimeoutMs / 1000)}s 后自动确认`
    });
  } catch (err) {
    console.error('[控制增氧机] 错误:', err.message);
    res.status(500).json({ success: false, message: '控制增氧机失败' });
  }
});

module.exports = router;