const WebSocket = require('ws');
const url = require('url');
const jwt = require('jsonwebtoken');
const config = require('../config');

let wss = null;

function initWebSocket(server) {
  wss = new WebSocket.Server({
    server,
    path: '/ws'
  });

  wss.on('connection', (ws, req) => {
    try {
      const params = new URLSearchParams(url.parse(req.url).query);
      const token = params.get('token');

      if (!token) {
        ws.close(4001, '缺少认证令牌');
        return;
      }

      const decoded = jwt.verify(token, config.jwtSecret);
      ws.userId = decoded.userId;
      ws.isAlive = true;

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('close', () => {
        // 客户端断开连接，无需额外清理
      });

      ws.on('error', (err) => {
        console.error('[WebSocket] 客户端连接错误:', err.message);
      });

      console.log('[WebSocket] 客户端已连接, userId:', decoded.userId);
    } catch (err) {
      ws.close(4001, '认证失败');
    }
  });

  // 心跳检测
  const interval = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  console.log('[WebSocket] 服务器已初始化');
}

// 广播实时数据
function broadcastRealtimeData(pondId, data) {
  if (!wss) return;
  const message = JSON.stringify({ type: 'realtime_data', pondId, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// 广播告警
function broadcastAlert(alert) {
  if (!wss) return;
  const message = JSON.stringify({ type: 'alert', data: alert });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// 广播设备状态变化
function broadcastDeviceStatus(pondId, status) {
  if (!wss) return;
  const message = JSON.stringify({ type: 'device_status', pondId, status });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

module.exports = { initWebSocket, broadcastRealtimeData, broadcastAlert, broadcastDeviceStatus };