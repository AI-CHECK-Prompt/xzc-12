#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <Arduino.h>

// 连接 WiFi（带超时）
bool connectWiFi();

// 检查 WiFi 连接状态
bool checkWiFiStatus();

// WiFi 断线重连
bool reconnectWiFi();

// 获取 WiFi 信号强度
int getWiFiRSSI();

#endif