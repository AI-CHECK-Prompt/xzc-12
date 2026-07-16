#include "relay_control.h"
#include "config.h"

// 增氧机状态
static bool aeratorStatus = false;
// 上次切换时间
static unsigned long lastToggleTime = 0;

// 初始化继电器控制引脚
void initRelay() {
    pinMode(AERATOR_RELAY, OUTPUT);
    // 默认关闭增氧机（低电平）
    digitalWrite(AERATOR_RELAY, LOW);
    aeratorStatus = false;
    lastToggleTime = 0;
    
    Serial.println(F("【继电器】初始化完成，引脚: ") + String(AERATOR_RELAY));
    Serial.println(F("【继电器】增氧机状态: 关闭"));
}

// 开启增氧机（高电平触发）
void turnAeratorOn() {
    unsigned long now = millis();
    
    // 安全保护：连续开关间隔至少3秒
    if (now - lastToggleTime < RELAY_COOLDOWN) {
        Serial.println(F("【继电器】冷却保护，请等待至少3秒后再操作"));
        return;
    }
    
    if (aeratorStatus) {
        Serial.println(F("【继电器】增氧机已在运行中"));
        return;
    }
    
    digitalWrite(AERATOR_RELAY, HIGH);
    aeratorStatus = true;
    lastToggleTime = now;
    
    Serial.println(F("【继电器】增氧机已开启"));
}

// 关闭增氧机
void turnAeratorOff() {
    unsigned long now = millis();
    
    // 安全保护：连续开关间隔至少3秒
    if (now - lastToggleTime < RELAY_COOLDOWN) {
        Serial.println(F("【继电器】冷却保护，请等待至少3秒后再操作"));
        return;
    }
    
    if (!aeratorStatus) {
        Serial.println(F("【继电器】增氧机已处于关闭状态"));
        return;
    }
    
    digitalWrite(AERATOR_RELAY, LOW);
    aeratorStatus = false;
    lastToggleTime = now;
    
    Serial.println(F("【继电器】增氧机已关闭"));
}

// 获取增氧机当前状态
bool getAeratorStatus() {
    return aeratorStatus;
}