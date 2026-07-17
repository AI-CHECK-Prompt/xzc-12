import { getToken } from '../utils/auth';

const WS_URL = 'ws://localhost:3000/ws';
const MAX_RECONNECT = 5;
const RECONNECT_INTERVAL = 3000;

class WebSocketService {
  constructor() {
    this.ws = null;
    this.reconnectCount = 0;
    this.reconnectTimer = null;
    this.callbacks = {
      realtimeData: [],
      alert: [],
      deviceStatus: [],
    };
  }

  connect() {
    const token = getToken();
    if (!token) {
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.ws = new WebSocket(`${WS_URL}?token=${token}`);

    this.ws.onopen = () => {
      console.log('[WS] 已连接');
      this.reconnectCount = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.dispatch(message);
      } catch (e) {
        console.error('[WS] 消息解析失败:', e);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[WS] 连接关闭:', event.code);
      this.tryReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('[WS] 连接错误:', error);
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectCount = MAX_RECONNECT;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  tryReconnect() {
    if (this.reconnectCount >= MAX_RECONNECT) {
      console.log('[WS] 已达最大重连次数');
      return;
    }
    this.reconnectCount++;
    console.log(`[WS] 第 ${this.reconnectCount} 次重连...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, RECONNECT_INTERVAL);
  }

  dispatch(message) {
    const { type, data, pondId } = message;
    switch (type) {
      case 'realtime_data':
        // 把 pondId 合并到 data 里，前端回调能直接 data.pondId 过滤
        // 解决：旧实现只传内层 data，前端 data.pondId 永远为 undefined，
        //       导致 Dashboard/PondDetail 的 WS 实时更新永远命中不到对应塘口
        this.callbacks.realtimeData.forEach((cb) => cb({ pondId, ...data }));
        break;
      case 'alert':
        this.callbacks.alert.forEach((cb) => cb(data));
        break;
      case 'device_status':
        // 设备状态变化同样带上 pondId
        this.callbacks.deviceStatus.forEach((cb) => cb({ pondId, ...data }));
        break;
      default:
        console.log('[WS] 未知消息类型:', type);
    }
  }

  onRealtimeData(callback) {
    this.callbacks.realtimeData.push(callback);
    return () => {
      this.callbacks.realtimeData = this.callbacks.realtimeData.filter((cb) => cb !== callback);
    };
  }

  onAlert(callback) {
    this.callbacks.alert.push(callback);
    return () => {
      this.callbacks.alert = this.callbacks.alert.filter((cb) => cb !== callback);
    };
  }

  onDeviceStatus(callback) {
    this.callbacks.deviceStatus.push(callback);
    return () => {
      this.callbacks.deviceStatus = this.callbacks.deviceStatus.filter((cb) => cb !== callback);
    };
  }
}

const wsService = new WebSocketService();
export default wsService;