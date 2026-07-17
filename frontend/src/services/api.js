import axios from 'axios';
import { getToken, removeToken } from '../utils/auth';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response && error.response.status === 401) {
      removeToken();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export function login(username, password) {
  return api.post('/auth/login', { username, password });
}

export function getPonds() {
  return api.get('/ponds');
}

export function getPondDetail(pondId) {
  return api.get(`/ponds/${pondId}`);
}

export function getRealtimeData(pondId) {
  return api.get(`/ponds/${pondId}/realtime`);
}

export function getHistoryData(pondId, params) {
  return api.get(`/ponds/${pondId}/history`, { params });
}

export function getLatestData(pondId) {
  return api.get(`/ponds/${pondId}/latest`);
}

export function getAlerts(params) {
  return api.get('/alerts', { params });
}

export function acknowledgeAlert(alertId) {
  return api.put(`/alerts/${alertId}/acknowledge`);
}

export function getUnreadAlertCount() {
  return api.get('/alerts/unread-count');
}

export function controlAerator(pondId, action) {
  return api.post(`/ponds/${pondId}/aerator`, { action });
}

export function getDevices() {
  return api.get('/devices');
}

// ============= 塘口对比 =============

/**
 * 获取分组维度下的可选值列表
 * @param {'species'|'region'|'area'} type
 */
export function getGroupValues(type) {
  return api.get('/analytics/groups', { params: { type } });
}

/**
 * 按品种/片区/面积分组，对塘口做横向对比
 * @param {Object} params
 * @param {'species'|'region'|'area'} params.groupBy
 * @param {string} params.groupValue
 * @param {string} params.startTime  ISO
 * @param {string} params.endTime    ISO
 */
export function comparePonds(params) {
  return api.get('/analytics/compare', { params });
}

// ============= 养殖周期复盘 =============

/**
 * 获取塘口指定时间范围内的复盘数据
 */
export function getCycleReview(params) {
  return api.get('/analytics/cycle-review', { params });
}

/**
 * 导出复盘报告（xlsx / pdf）
 * 返回 blob，调用方通过 URL.createObjectURL 触发下载
 */
export async function exportCycleReview(params) {
  const token = getToken();
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`/api/analytics/cycle-review/export?${query}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) {
    let msg = '导出失败';
    try {
      const j = await res.json();
      if (j && j.message) msg = j.message;
    } catch (_) {}
    throw new Error(msg);
  }
  const contentType = res.headers.get('Content-Type') || '';
  const disposition = res.headers.get('Content-Disposition') || '';
  // 从 Content-Disposition 提取文件名
  let filename = '';
  const m = /filename\*?=(?:UTF-8'')?["']?([^;"']+)/i.exec(disposition);
  if (m) {
    try { filename = decodeURIComponent(m[1]); } catch (_) { filename = m[1]; }
  }
  const blob = await res.blob();
  return { blob, contentType, filename, size: blob.size };
}

export default api;