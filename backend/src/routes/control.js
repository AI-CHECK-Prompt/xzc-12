const express = require('express');
const Pond = require('../models/Pond');
const Alert = require('../models/Alert');
const { authMiddleware, requireOperator } = require('../middleware/auth');
const { publishControl } = require('../services/mqttClient');
const { broadcastAlert, broadcastDeviceStatus } = require('../services/websocket');
const { isAlertDuplicate, markAlertSent } = require('../services/redisClient');

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
      await Pond.findOneAndUpdate(
        { pondId: req.params.pondId },
        {
          $set: {
            commandPending: true,
            lastCommand: command,
            lastCommandId: pubResult.commandId || '',
            lastCommandTime: new Date(),
            lastCommandFailReason: pubResult.reason || 'unknown'
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
          reason: pubResult.reason
        }
      });
    }

    // 2) 下发成功：更新 DB 标记为 pending 等待设备回执
    // 注意：实际硬件状态由设备 ack 来确认，避免再次出现"假启动"
    const update = {
      $set: {
        commandPending: true,
        lastCommand: command,
        lastCommandId: pubResult.commandId,
        lastCommandTime: new Date(),
        lastCommandFailReason: '',
        aeratorMode: 'manual',
        aeratorStatusFault: false
      }
    };
    // 关闭命令的最终结果以设备 ack 为准，但同步先更新为已请求状态
    if (command === 'aerator_off') {
      // 关闭命令 ack 后才会真正置 false
    }
    await Pond.findOneAndUpdate({ pondId: req.params.pondId }, update);

    res.json({
      success: true,
      data: {
        pondId: req.params.pondId,
        command,
        commandId: pubResult.commandId,
        mqttSent: true,
        commandPending: true,
        // 前端按此字段提示"命令已下发，等待设备确认"
        message: '命令已下发到设备，请等待设备确认'
      },
      message: `增氧机${action === 'on' ? '启动' : '关闭'}命令已下发，等待设备确认`
    });
  } catch (err) {
    console.error('[控制增氧机] 错误:', err.message);
    res.status(500).json({ success: false, message: '控制增氧机失败' });
  }
});

module.exports = router;