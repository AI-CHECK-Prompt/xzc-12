#include "wifi_manager.h"
#include "config.h"
#include <WiFi.h>

// 内置 LED 引脚（ESP32 通常是 GPIO2）
#define LED_BUILTIN 2

// WiFi 连接状态
static bool wifiConnected = false;

// 连接 WiFi（带超时）
bool connectWiFi() {
    Serial.println(F("【WiFi】正在连接 WiFi..."));
    Serial.printf("【WiFi】SSID: %s\n", WIFI_SSID);
    
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    
    // 设置 LED 为输出
    pinMode(LED_BUILTIN, OUTPUT);
    
    unsigned long startTime = millis();
    bool ledState = false;
    
    // 连接中快闪 LED
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - startTime > WIFI_TIMEOUT) {
            Serial.println(F("【WiFi】连接超时"));
            // 慢闪表示连接失败
            digitalWrite(LED_BUILTIN, LOW);
            wifiConnected = false;
            return false;
        }
        
        // 快闪 LED（200ms 间隔）
        ledState = !ledState;
        digitalWrite(LED_BUILTIN, ledState ? HIGH : LOW);
        delay(200);
        Serial.print(".");
    }
    
    // 连接成功，LED 常亮
    digitalWrite(LED_BUILTIN, HIGH);
    wifiConnected = true;
    
    Serial.println();
    Serial.println(F("【WiFi】连接成功"));
    Serial.print(F("【WiFi】IP 地址: "));
    Serial.println(WiFi.localIP());
    Serial.printf("【WiFi】信号强度: %d dBm\n", WiFi.RSSI());
    
    return true;
}

// 检查 WiFi 连接状态
bool checkWiFiStatus() {
    return (WiFi.status() == WL_CONNECTED);
}

// WiFi 断线重连
bool reconnectWiFi() {
    if (WiFi.status() == WL_CONNECTED) {
        return true;
    }
    
    Serial.println(F("【WiFi】连接已断开，正在重连..."));
    
    // 慢闪 LED 表示断线
    digitalWrite(LED_BUILTIN, LOW);
    delay(500);
    digitalWrite(LED_BUILTIN, HIGH);
    delay(500);
    
    // 尝试重新连接
    WiFi.disconnect();
    delay(1000);
    
    return connectWiFi();
}

// 获取 WiFi 信号强度
int getWiFiRSSI() {
    return WiFi.RSSI();
}