#ifndef MQTT_HANDLER_H
#define MQTT_HANDLER_H

#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFiClient.h>
#include "sensors.h"

// 初始化 MQTT 连接
void initMQTT();

// 连接 MQTT Broker
bool connectMQTT();

// 断开 MQTT
void disconnectMQTT();

// 保持 MQTT 连接（在 loop 中调用）
void mqttLoop();

// 发布传感器数据
bool publishData(SensorData data);

// 发布设备状态
bool publishStatus(const char* status);

// 订阅控制命令主题
void subscribeControl();

// 检查 MQTT 是否连接
bool isMQTTConnected();

// 回调函数：处理接收到的 MQTT 消息
void onMQTTMessage(char* topic, byte* payload, unsigned int length);

#endif