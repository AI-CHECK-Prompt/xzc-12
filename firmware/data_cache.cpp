#include "data_cache.h"
#include "config.h"
#include <SPIFFS.h>

// 缓存数据（内存中的 JSON 数组）
// 格式: [{"t":25.5,"ph":7.8,"do":5.2,"ts":"2026-07-16T10:30:00Z"},...]
static String cacheData = "";
static int cacheCount = 0;

// 初始化缓存（SPIFFS）
void initCache() {
    // 初始化 SPIFFS
    if (!SPIFFS.begin(true)) {
        Serial.println(F("【缓存】SPIFFS 初始化失败"));
        return;
    }
    
    Serial.println(F("【缓存】SPIFFS 初始化成功"));
    Serial.printf("【缓存】SPIFFS 总空间: %u 字节\n", SPIFFS.totalBytes());
    Serial.printf("【缓存】SPIFFS 已用空间: %u 字节\n", SPIFFS.usedBytes());
    
    // 读取已有缓存数据
    if (SPIFFS.exists(CACHE_FILE)) {
        File file = SPIFFS.open(CACHE_FILE, "r");
        if (file) {
            cacheData = file.readString();
            file.close();
            
            // 统计缓存条数
            cacheCount = 0;
            for (unsigned int i = 0; i < cacheData.length(); i++) {
                if (cacheData.charAt(i) == '{') {
                    cacheCount++;
                }
            }
            
            Serial.printf("【缓存】已加载 %d 条历史缓存数据\n", cacheCount);
        }
    } else {
        // 初始化空缓存
        cacheData = "[]";
        cacheCount = 0;
        Serial.println(F("【缓存】无历史缓存数据"));
    }
}

// 添加数据到缓存
void addToCache(SensorData data) {
    // 获取时间戳
    char timestamp[30];
    unsigned long secs = millis() / 1000;
    unsigned long hours = (secs / 3600) % 24;
    unsigned long mins = (secs / 60) % 60;
    unsigned long sec = secs % 60;
    snprintf(timestamp, sizeof(timestamp), "2026-01-01T%02lu:%02lu:%02luZ", hours, mins, sec);
    
    // 构建单条数据 JSON
    char entry[128];
    snprintf(entry, sizeof(entry),
             "{\"t\":%.1f,\"ph\":%.2f,\"do\":%.2f,\"ts\":\"%s\"}",
             data.temperature, data.ph, data.dissolvedOxygen, timestamp);
    
    // 如果缓存已满，删除最旧的数据（第一个条目）
    if (cacheCount >= MAX_CACHE_SIZE) {
        // 找到第一个逗号位置，删除第一个条目
        int firstComma = cacheData.indexOf(',', 1);  // 从索引1开始找，跳过开头的 '['
        if (firstComma > 0) {
            cacheData = "[" + cacheData.substring(firstComma + 1);
        } else {
            // 只有一条数据，重置为单条
            cacheData = "[" + String(entry) + "]";
            cacheCount = 0;
        }
        cacheCount--;
    }
    
    // 添加新数据
    if (cacheCount == 0) {
        cacheData = "[" + String(entry) + "]";
    } else {
        // 移除结尾的 ']'，添加逗号和新条目，再添加 ']'
        cacheData = cacheData.substring(0, cacheData.length() - 1);
        cacheData += "," + String(entry) + "]";
    }
    cacheCount++;
    
    // 写入 SPIFFS
    File file = SPIFFS.open(CACHE_FILE, "w");
    if (file) {
        file.print(cacheData);
        file.close();
        Serial.printf("【缓存】数据已缓存，当前缓存数: %d\n", cacheCount);
    } else {
        Serial.println(F("【缓存】写入文件失败"));
    }
}

// 获取缓存数据条数
int getCacheCount() {
    return cacheCount;
}

// 清空缓存
void clearCache() {
    cacheData = "[]";
    cacheCount = 0;
    
    if (SPIFFS.exists(CACHE_FILE)) {
        SPIFFS.remove(CACHE_FILE);
    }
    
    Serial.println(F("【缓存】缓存已清空"));
}

// 补传缓存数据（通过 MQTT 逐条发送）
int uploadCacheData(bool (*publishFunc)(SensorData)) {
    if (cacheCount == 0) {
        return 0;
    }
    
    Serial.printf("【缓存】开始补传 %d 条缓存数据\n", cacheCount);
    
    int uploadedCount = 0;
    int failedCount = 0;
    
    // 解析缓存数据并逐条发送
    String remainingData = cacheData;
    // 去掉开头的 '[' 和结尾的 ']'
    remainingData = remainingData.substring(1, remainingData.length() - 1);
    
    int pos = 0;
    String newCache = "[";
    bool first = true;
    
    // 逐条解析
    while (pos < (int)remainingData.length()) {
        // 跳过空白字符
        while (pos < (int)remainingData.length() && remainingData.charAt(pos) == ' ') {
            pos++;
        }
        
        if (pos >= (int)remainingData.length()) break;
        
        // 找到完整的 JSON 对象 '{' 到 '}'
        int start = remainingData.indexOf('{', pos);
        if (start < 0) break;
        
        int end = remainingData.indexOf('}', start);
        if (end < 0) break;
        
        String entry = remainingData.substring(start, end + 1);
        
        // 解析数据
        SensorData data;
        data.temperature = NAN;
        data.ph = NAN;
        data.dissolvedOxygen = NAN;
        data.valid = true;
        
        // 简单解析 JSON: {"t":25.5,"ph":7.8,"do":5.2,"ts":"..."}
        int tIdx = entry.indexOf("\"t\":");
        int phIdx = entry.indexOf("\"ph\":");
        int doIdx = entry.indexOf("\"do\":");
        
        if (tIdx > 0) data.temperature = entry.substring(tIdx + 4, entry.indexOf(',', tIdx)).toFloat();
        if (phIdx > 0) data.ph = entry.substring(phIdx + 5, entry.indexOf(',', phIdx)).toFloat();
        if (doIdx > 0) {
            int doEnd = entry.indexOf(',', doIdx);
            if (doEnd < 0) doEnd = entry.indexOf('}', doIdx);
            data.dissolvedOxygen = entry.substring(doIdx + 5, doEnd).toFloat();
        }
        
        // 尝试发送
        if (publishFunc(data)) {
            uploadedCount++;
            if (uploadedCount % 10 == 0) {
                Serial.printf("【缓存】已补传 %d 条...\n", uploadedCount);
            }
        } else {
            failedCount++;
            // 保留发送失败的数据
            if (!first) newCache += ",";
            newCache += entry;
            first = false;
        }
        
        // 移动到下一条
        pos = end + 1;
        // 跳过逗号
        while (pos < (int)remainingData.length() && remainingData.charAt(pos) == ',') {
            pos++;
        }
    }
    
    newCache += "]";
    
    // 更新缓存
    cacheData = newCache;
    // 重新计数
    cacheCount = 0;
    for (unsigned int i = 0; i < cacheData.length(); i++) {
        if (cacheData.charAt(i) == '{') cacheCount++;
    }
    
    // 更新 SPIFFS
    if (cacheCount == 0) {
        clearCache();
    } else {
        File file = SPIFFS.open(CACHE_FILE, "w");
        if (file) {
            file.print(cacheData);
            file.close();
        }
    }
    
    Serial.printf("【缓存】补传完成: 成功%d条, 失败%d条, 剩余%d条\n", 
                  uploadedCount, failedCount, cacheCount);
    
    return uploadedCount;
}

// 获取缓存数据（用于调试）
String getCacheData() {
    return cacheData;
}