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

export default api;