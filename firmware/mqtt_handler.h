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

// 发布控制回执（1.1.0 起支持）
// commandId: 平台下发的命令 ID，必须原样回传
// command:   "aerator_on" / "aerator_off"
// result:    "ok" / "fail"
// error:     失败原因（成功可为空）
void publishControlAck(const char* commandId, const char* command, const char* result, const char* error);

// 检查 MQTT 是否连接
bool isMQTTConnected();

// 回调函数：处理接收到的 MQTT 消息
void onMQTTMessage(char* topic, byte* payload, unsigned int length);

#endif