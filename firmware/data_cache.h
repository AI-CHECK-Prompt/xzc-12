#ifndef DATA_CACHE_H
#define DATA_CACHE_H

#include <Arduino.h>
#include "sensors.h"

// 初始化缓存（SPIFFS）
void initCache();

// 添加数据到缓存
void addToCache(SensorData data);

// 获取缓存数据条数
int getCacheCount();

// 清空缓存
void clearCache();

// 补传缓存数据（通过 MQTT 逐条发送）
// 返回实际发送成功的条数
int uploadCacheData(bool (*publishFunc)(SensorData));

// 获取缓存数据（用于调试）
String getCacheData();

#endif