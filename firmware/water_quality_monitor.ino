/**
 * 水质采集终端 - 主程序
 * 
 * 功能:
 * - 通过 RS485/Modbus RTU 采集 pH、溶氧、水温数据
 * - 通过 WiFi + MQTT 上报数据到云端
 * - 断网时本地缓存数据，网络恢复后自动补传
 * - 接收远程控制命令，控制增氧机继电器
 * - 定时发送心跳和设备状态
 * 
 * 硬件: ESP32 + pH传感器 + 溶氧传感器 + 水温传感器 + 增氧机继电器
 */

#include "config.h"
#include "wifi_manager.h"
#include "sensors.h"
#include "mqtt_handler.h"
#include "relay_control.h"
#include "data_cache.h"

// ==================== 定时器变量 ====================

// 数据采集定时器
unsigned long lastSampleTime = 0;

// 数据上报定时器
unsigned long lastReportTime = 0;

// 看门狗重置时间
unsigned long lastWatchdogReset = 0;

// 增氧机状态巡检定时器
// 修复：定期读回 GPIO 实际电平，与固件内部目标值比对，
//       不一致时主动 publish 状态事件，平台后端据此同步 Pond.aeratorStatus
//       解决"现场人工拉闸后前端一直显示旧值"问题
unsigned long lastAeratorCheckTime = 0;
#define AERATOR_CHECK_INTERVAL 5000  // 5 秒巡检一次，平衡流量与响应速度

// ==================== 数据缓冲区 ====================

// 采集数据缓冲区（用于上报时取平均值）
#define SAMPLE_BUFFER_SIZE 10  // 最多缓存10次采集数据（10分钟）
static SensorData sampleBuffer[SAMPLE_BUFFER_SIZE];
static int sampleBufferCount = 0;

// ==================== 系统状态 ====================

// 系统运行状态
static bool systemReady = false;

// ==================== 函数声明 ====================

// 采集传感器数据
void collectSensorData();

// 上报数据（取平均值）
void reportAveragedData();

// 计算缓冲区数据的平均值
SensorData calculateAverage();

// 检查并补传缓存数据
void checkAndUploadCache();

// 重置看门狗
void resetWatchdog();

// ==================== 初始化 ====================

void setup() {
    // 初始化调试串口
    Serial.begin(115200);
    delay(1000);
    
    Serial.println(F("\n\n========================================"));
    Serial.println(F("   水质采集终端 - 系统启动"));
    Serial.println(F("========================================"));
    Serial.printf("固件版本: %s\n", FIRMWARE_VERSION);
    Serial.printf("设备编号: %s\n", DEVICE_ID);
    Serial.printf("塘口编号: %s\n", POND_ID);
    Serial.println(F("========================================\n"));
    
    // 1. 初始化 SPIFFS（数据缓存）
    Serial.println(F(">>> 初始化 SPIFFS..."));
    initCache();
    
    // 2. 连接 WiFi
    Serial.println(F(">>> 连接 WiFi..."));
    if (!connectWiFi()) {
        Serial.println(F("【警告】WiFi 连接失败，将以离线模式运行"));
    }
    
    // 3. 初始化传感器 Modbus 通信
    Serial.println(F(">>> 初始化传感器..."));
    initSensors();
    
    // 4. 初始化 MQTT
    Serial.println(F(">>> 初始化 MQTT..."));
    initMQTT();
    if (checkWiFiStatus()) {
        connectMQTT();
    }
    
    // 5. 初始化增氧机继电器
    Serial.println(F(">>> 初始化继电器..."));
    initRelay();
    
    // 6. 初始化定时器
    lastSampleTime = millis();
    lastReportTime = millis();
    lastWatchdogReset = millis();
    
    // 7. 初始化看门狗（ESP32 硬件看门狗，超时时间约5秒）
    // 在 loop 中需要定期喂狗
    esp_task_wdt_init(10, true);  // 10秒超时
    esp_task_wdt_add(NULL);
    
    systemReady = true;
    
    Serial.println(F("\n========================================"));
    Serial.println(F("   系统初始化完成，开始运行"));
    Serial.println(F("========================================\n"));
    Serial.printf("采集间隔: %d 秒\n", SAMPLE_INTERVAL / 1000);
    Serial.printf("上报间隔: %d 秒\n", REPORT_INTERVAL / 1000);
    Serial.printf("缓存上限: %d 条\n", MAX_CACHE_SIZE);
    Serial.println(F("========================================\n"));
}

// ==================== 主循环 ====================

void loop() {
    unsigned long now = millis();
    
    // 喂狗（每1秒）
    if (now - lastWatchdogReset > 1000) {
        resetWatchdog();
        lastWatchdogReset = now;
    }
    
    // 检查 WiFi 状态，断线自动重连
    if (!checkWiFiStatus()) {
        reconnectWiFi();
        // WiFi 恢复后重新连接 MQTT
        if (checkWiFiStatus() && !isMQTTConnected()) {
            connectMQTT();
        }
    }
    
    // 保持 MQTT 连接，处理消息
    mqttLoop();
    
    // 检查是否需要采集传感器数据
    if (now - lastSampleTime >= SAMPLE_INTERVAL) {
        lastSampleTime = now;
        collectSensorData();
    }
    
    // 检查是否需要上报数据
    if (now - lastReportTime >= REPORT_INTERVAL) {
        lastReportTime = now;
        reportAveragedData();
    }
    
    // 检查是否需要补传缓存数据
    checkAndUploadCache();

    // 检查增氧机状态是否与内部记录一致
    // 不一致时（如继电器被外部信号拉低/接触器辅助点异常）主动 publish 事件
    if (now - lastAeratorCheckTime >= AERATOR_CHECK_INTERVAL) {
        lastAeratorCheckTime = now;
        checkAeratorState();
    }

    // 短暂延时，避免 CPU 占用过高
    delay(100);
}

// ==================== 数据采集 ====================

// 采集传感器数据并存入缓冲区
void collectSensorData() {
    if (!systemReady) return;
    
    Serial.println(F("\n--- 采集传感器数据 ---"));
    
    SensorData data = readSensors();
    
    if (data.valid) {
        // 存入缓冲区
        if (sampleBufferCount < SAMPLE_BUFFER_SIZE) {
            sampleBuffer[sampleBufferCount] = data;
            sampleBufferCount++;
        } else {
            // 缓冲区已满，移除最旧的数据
            for (int i = 0; i < SAMPLE_BUFFER_SIZE - 1; i++) {
                sampleBuffer[i] = sampleBuffer[i + 1];
            }
            sampleBuffer[SAMPLE_BUFFER_SIZE - 1] = data;
        }
        Serial.printf("【采集】缓冲区数据量: %d/%d\n", sampleBufferCount, SAMPLE_BUFFER_SIZE);
    } else {
        Serial.println(F("【采集】传感器数据无效，跳过"));
    }
}

// ==================== 数据上报 ====================

// 计算缓冲区数据的平均值
SensorData calculateAverage() {
    SensorData avg;
    avg.temperature = 0;
    avg.ph = 0;
    avg.dissolvedOxygen = 0;
    avg.valid = false;
    
    if (sampleBufferCount == 0) {
        return avg;
    }
    
    int validCount = 0;
    for (int i = 0; i < sampleBufferCount; i++) {
        if (sampleBuffer[i].valid) {
            avg.temperature += sampleBuffer[i].temperature;
            avg.ph += sampleBuffer[i].ph;
            avg.dissolvedOxygen += sampleBuffer[i].dissolvedOxygen;
            validCount++;
        }
    }
    
    if (validCount > 0) {
        avg.temperature /= validCount;
        avg.ph /= validCount;
        avg.dissolvedOxygen /= validCount;
        avg.valid = true;
    }
    
    return avg;
}

// 上报数据（取平均值）
void reportAveragedData() {
    if (!systemReady) return;
    
    Serial.println(F("\n=== 上报数据 ==="));
    
    SensorData avgData = calculateAverage();
    
    if (!avgData.valid) {
        Serial.println(F("【上报】无有效数据可上报"));
        return;
    }
    
    Serial.printf("【上报】平均值 - 温度:%.1f°C pH:%.2f 溶氧:%.2fmg/L\n",
                  avgData.temperature, avgData.ph, avgData.dissolvedOxygen);
    
    // 判断网络状态
    bool networkOk = checkWiFiStatus() && isMQTTConnected();
    
    if (networkOk) {
        // 网络正常，直接上报
        if (publishData(avgData)) {
            Serial.println(F("【上报】数据上报成功"));
        } else {
            // 上报失败，存入缓存
            Serial.println(F("【上报】数据上报失败，存入缓存"));
            addToCache(avgData);
        }
    } else {
        // 网络断开，存入缓存
        Serial.println(F("【上报】网络不可用，数据存入缓存"));
        addToCache(avgData);
    }
    
    // 清空缓冲区，准备下一轮采集
    sampleBufferCount = 0;
}

// ==================== 缓存补传 ====================

// 检查并补传缓存数据
void checkAndUploadCache() {
    static unsigned long lastUploadCheck = 0;
    unsigned long now = millis();
    
    // 每30秒检查一次
    if (now - lastUploadCheck < 30000) {
        return;
    }
    lastUploadCheck = now;
    
    // 检查是否有缓存数据且网络可用
    if (getCacheCount() > 0 && checkWiFiStatus() && isMQTTConnected()) {
        Serial.println(F("\n--- 检查缓存补传 ---"));
        uploadCacheData(publishData);
    }
}

// ==================== 看门狗 ====================

// 重置看门狗定时器
void resetWatchdog() {
    // 使用 ESP32 任务看门狗
    esp_task_wdt_reset();
}

// ==================== 增氧机状态巡检 ====================

// 巡检增氧机真实状态：GPIO 实际电平 vs 固件内部目标值
// 不一致时主动 publish 状态事件，让平台后端同步 Pond.aeratorStatus
// 解决"现场人工拉闸 / 接触器异常 / 设备掉电重启"等场景下前端状态滞留问题
void checkAeratorState() {
    bool target = getAeratorStatus();
    bool actual = getAeratorActualStatus();

    if (target != actual) {
        Serial.printf("【增氧机巡检】目标=%s 实际=%s 不一致，发布状态事件\n",
                      target ? "on" : "off", actual ? "on" : "off");
        publishAeratorStateEvent(actual, "gpio_mismatch");
    }
}