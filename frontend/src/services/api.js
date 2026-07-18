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

/**
 * 获取塘口列表，支持按养殖品种/塘口状态组合筛选
 * @param {Object} [params]
 * @param {string} [params.species]   养殖品种（如 '南美白对虾'），精确匹配
 * @param {string} [params.status]    塘口状态（'online' | 'offline'），精确匹配
 * 多个条件之间为 AND；任一参数缺省/为空时该条件不参与筛选
 */
export function getPonds(params) {
  // 过滤掉空值/未定义，避免把空字符串发给后端被错误地当成有效值
  const cleanParams = {};
  if (params && typeof params === 'object') {
    if (params.species) cleanParams.species = params.species;
    if (params.status) cleanParams.status = params.status;
  }
  return api.get('/ponds', { params: cleanParams });
}

export function getPondDetail(pondId) {
  return api.get(`/ponds/${pondId}`);
}

export function getRealtimeData(pondId) {
  // 修正：实时数据接口在 /api/data 下，不在 /api/ponds 下。
  // 旧路径 /ponds/:pondId/realtime 会被路由表忽略，前端拿到 404，
  // PondDetail 只能依赖 pond.realtime（来自 /api/ponds/:pondId 的快照），
  // 这是"列表 5.8 / 详情 5.2"不一致的根因之一。
  return api.get(`/data/${pondId}/realtime`);
}

export function getHistoryData(pondId, params) {
  return api.get(`/data/${pondId}/history`, { params });
}

export function getLatestData(pondId) {
  return api.get(`/data/${pondId}/latest`);
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