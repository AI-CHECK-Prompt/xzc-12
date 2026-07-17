#include "mqtt_handler.h"
#include "config.h"
#include "relay_control.h"
#include <WiFi.h>

// WiFi 客户端和 MQTT 客户端
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

// MQTT 主题定义
#define TOPIC_DATA        "pond/" POND_ID "/data"
#define TOPIC_STATUS      "pond/" POND_ID "/status"
#define TOPIC_CONTROL     "pond/" POND_ID "/control"
#define TOPIC_CONTROL_ACK "pond/" POND_ID "/control/ack"

// 最后心跳时间
unsigned long lastHeartbeat = 0;

// 初始化 MQTT 连接
void initMQTT() {
    mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    mqttClient.setCallback(onMQTTMessage);
    // 设置更大的缓冲区以容纳 JSON 数据
    mqttClient.setBufferSize(512);
    
    Serial.println(F("【MQTT】初始化完成"));
    Serial.println(F("【MQTT】Broker: ") + String(MQTT_HOST) + F(":") + String(MQTT_PORT));
    Serial.println(F("【MQTT】Client ID: ") + String(MQTT_CLIENT_ID));
}

// 连接 MQTT Broker
bool connectMQTT() {
    if (mqttClient.connected()) {
        return true;
    }
    
    Serial.println(F("【MQTT】正在连接 Broker..."));
    
    // 设置遗嘱消息：设备离线时自动发布
    String willTopic = TOPIC_STATUS;
    String willMessage = "{\"status\":\"offline\",\"deviceId\":\"" DEVICE_ID "\"}";
    
    if (mqttClient.connect(MQTT_CLIENT_ID, willTopic.c_str(), 0, true, willMessage.c_str())) {
        Serial.println(F("【MQTT】连接成功"));
        
        // 订阅控制命令主题
        subscribeControl();
        
        // 发布上线状态
        publishStatus("online");
        
        lastHeartbeat = millis();
        return true;
    } else {
        Serial.print(F("【MQTT】连接失败，状态码: "));
        Serial.println(mqttClient.state());
        return false;
    }
}

// 断开 MQTT
void disconnectMQTT() {
    if (mqttClient.connected()) {
        // 发布离线状态
        publishStatus("offline");
        mqttClient.disconnect();
        Serial.println(F("【MQTT】已断开连接"));
    }
}

// 保持 MQTT 连接（在 loop 中调用）
void mqttLoop() {
    if (!mqttClient.connected()) {
        // 断线重连
        static unsigned long lastReconnectAttempt = 0;
        unsigned long now = millis();
        
        if (now - lastReconnectAttempt > 5000) {
            lastReconnectAttempt = now;
            if (connectMQTT()) {
                lastReconnectAttempt = 0;
            }
        }
    }
    
    mqttClient.loop();
    
    // 定时发送心跳
    unsigned long now = millis();
    if (mqttClient.connected() && (now - lastHeartbeat > HEARTBEAT_INTERVAL)) {
        publishStatus("online");
        lastHeartbeat = now;
    }
}

// 发布传感器数据
bool publishData(SensorData data) {
    if (!mqttClient.connected()) {
        Serial.println(F("【MQTT】未连接，无法发布数据"));
        return false;
    }
    
    // 获取当前时间戳（使用 millis() 换算，实际应使用 NTP）
    // 格式: "2026-07-16T10:30:00Z"
    char timestamp[30];
    unsigned long secs = millis() / 1000;
    unsigned long hours = (secs / 3600) % 24;
    unsigned long mins = (secs / 60) % 60;
    unsigned long sec = secs % 60;
    snprintf(timestamp, sizeof(timestamp), "2026-01-01T%02lu:%02lu:%02luZ", hours, mins, sec);
    
    // 构建 JSON 数据
    char payload[512];
    snprintf(payload, sizeof(payload),
             "{\"pondId\":\"%s\",\"deviceId\":\"%s\",\"temperature\":%.1f,\"ph\":%.2f,\"dissolvedOxygen\":%.2f,\"timestamp\":\"%s\"}",
             POND_ID, DEVICE_ID, data.temperature, data.ph, data.dissolvedOxygen, timestamp);
    
    bool result = mqttClient.publish(TOPIC_DATA, payload);
    
    if (result) {
        Serial.println(F("【MQTT】数据上报成功"));
        Serial.println(F("【MQTT】Topic: ") + String(TOPIC_DATA));
        Serial.println(F("【MQTT】Payload: ") + String(payload));
    } else {
        Serial.println(F("【MQTT】数据上报失败"));
    }
    
    return result;
}

// 发布设备状态
bool publishStatus(const char* status) {
    if (!mqttClient.connected()) {
        return false;
    }
    
    // 获取 WiFi 信号强度
    int rssi = WiFi.RSSI();
    // 获取可用堆内存
    uint32_t freeHeap = ESP.getFreeHeap();
    
    char payload[256];
    snprintf(payload, sizeof(payload),
             "{\"deviceId\":\"%s\",\"status\":\"%s\",\"firmwareVersion\":\"%s\",\"rssi\":%d,\"freeHeap\":%u}",
             DEVICE_ID, status, FIRMWARE_VERSION, rssi, freeHeap);
    
    bool result = mqttClient.publish(TOPIC_STATUS, payload);
    
    if (result) {
        Serial.printf("【MQTT】状态上报: %s\n", payload);
    }
    
    return result;
}

// 订阅控制命令主题
void subscribeControl() {
    if (mqttClient.connected()) {
        mqttClient.subscribe(TOPIC_CONTROL);
        Serial.println(F("【MQTT】已订阅控制主题: ") + String(TOPIC_CONTROL));
    }
}

// 发布控制回执（1.1.0 起支持）
// 后端 handleControlAck 据此把 commandPending 置 false 并更新 aeratorStatus
void publishControlAck(const char* commandId, const char* command, const char* result, const char* error) {
    if (!mqttClient.connected()) {
        Serial.println(F("【MQTT】未连接，无法发送控制回执"));
        return;
    }
    if (!commandId || !command || !result) {
        Serial.println(F("【MQTT】控制回执参数缺失，已跳过"));
        return;
    }

    // JSON 编码 error：避免无效值直接拼字符串导致破图
    const char* safeError = (error && error[0]) ? error : "";

    char payload[384];
    snprintf(payload, sizeof(payload),
             "{\"deviceId\":\"%s\",\"commandId\":\"%s\",\"command\":\"%s\",\"result\":\"%s\",\"error\":\"%s\",\"timestamp\":\"%s\"}",
             DEVICE_ID, commandId, command, result, safeError,
             // 时间戳与 publishData 保持同样简化形式
             "2026-01-01T00:00:00Z");

    bool ok = mqttClient.publish(TOPIC_CONTROL_ACK, payload, 1);
    if (ok) {
        Serial.printf("【MQTT】控制回执已发送: commandId=%s command=%s result=%s\n", commandId, command, result);
    } else {
        Serial.println(F("【MQTT】控制回执发送失败"));
    }
}

// 检查 MQTT 是否连接
bool isMQTTConnected() {
    return mqttClient.connected();
}

// 回调函数：处理接收到的 MQTT 消息
void onMQTTMessage(char* topic, byte* payload, unsigned int length) {
    // 将 payload 转换为字符串
    char message[512];
    unsigned int copyLen = length < 511 ? length : 511;
    memcpy(message, payload, copyLen);
    message[copyLen] = '\0';

    Serial.printf("【MQTT】收到消息 - Topic: %s, Payload: %s\n", topic, message);

    // 简单 JSON 解析：查找 command 字段与 commandId
    // 支持的命令格式: {"command":"aerator_on","commandId":"xxx"}
    String msgStr = String(message);

    // 解析 commandId（用于 1.1.0+ 回执）
    char commandId[64] = "";
    int idKeyIdx = msgStr.indexOf("\"commandId\"");
    if (idKeyIdx > 0) {
        int colonIdx = msgStr.indexOf(':', idKeyIdx);
        int q1Idx = msgStr.indexOf('"', colonIdx + 1);
        int q2Idx = msgStr.indexOf('"', q1Idx + 1);
        if (colonIdx > 0 && q1Idx > 0 && q2Idx > q1Idx) {
            int idLen = q2Idx - q1Idx - 1;
            if (idLen > 0 && idLen < (int)sizeof(commandId)) {
                msgStr.substring(q1Idx + 1, q2Idx).toCharArray(commandId, sizeof(commandId));
            }
        }
    }

    if (msgStr.indexOf("\"aerator_on\"") > 0) {
        Serial.println(F("【控制】收到增氧机开启命令"));
        turnAeratorOn();
        // 1.1.0+：执行后回执，区分"待确认"与"已确认"
        publishControlAck(commandId, "aerator_on", "ok", "");
    } else if (msgStr.indexOf("\"aerator_off\"") > 0) {
        Serial.println(F("【控制】收到增氧机关闭命令"));
        turnAeratorOff();
        publishControlAck(commandId, "aerator_off", "ok", "");
    } else {
        Serial.println(F("【控制】未知命令"));
    }
}