#include "sensors.h"
#include "config.h"

// Modbus 主站对象，使用 Serial2 作为 RS485 通信接口
ModbusRTU mb;

// 初始化传感器 Modbus 通信
void initSensors() {
    // Serial2 用于 RS485 通信
    Serial2.begin(9600, SERIAL_8N1, RS485_RX, RS485_TX);
    
    // 初始化 Modbus 主站
    mb.begin(&Serial2, RS485_DE_RE);
    mb.master();
    
    Serial.println(F("【传感器】Modbus 初始化完成"));
    Serial.println(F("【传感器】RS485 引脚: RX=") + String(RS485_RX) + 
                    F(" TX=") + String(RS485_TX) + 
                    F(" DE_RE=") + String(RS485_DE_RE));
}

// 读取传感器数据
SensorData readSensors() {
    SensorData data;
    data.temperature = NAN;
    data.ph = NAN;
    data.dissolvedOxygen = NAN;
    data.valid = false;
    
    uint16_t regValues[REG_COUNT];
    bool readSuccess = false;
    
    // 重试读取
    for (int retry = 0; retry < SENSOR_RETRY_COUNT; retry++) {
        // 读取保持寄存器，起始地址 0x0000，读取3个寄存器
        uint8_t result = mb.readHreg(MODBUS_SLAVE_ID, REG_TEMPERATURE, regValues, REG_COUNT, cbRead);
        
        // 等待读取完成
        unsigned long startTime = millis();
        while (mb.slave()) {
            // 处理 Modbus 通信
            if (millis() - startTime > SENSOR_TIMEOUT) {
                Serial.println(F("【传感器】读取超时，重试..."));
                break;
            }
            delay(10);
        }
        
        // 检查是否成功读取（通过查看是否有有效数据）
        // 验证数据合理性：温度通常在 0-50°C，pH 在 0-14，溶氧在 0-20mg/L
        float temp = regValues[0] / 10.0;   // 水温，除以10
        float phVal = regValues[1] / 100.0;  // pH值，除以100
        float doVal = regValues[2] / 100.0;  // 溶氧，除以100
        
        // 数据合理性校验
        if (temp >= 0 && temp <= 50 && phVal >= 0 && phVal <= 14 && doVal >= 0 && doVal <= 20) {
            data.temperature = temp;
            data.ph = phVal;
            data.dissolvedOxygen = doVal;
            data.valid = true;
            readSuccess = true;
            break;
        }
        
        if (retry < SENSOR_RETRY_COUNT - 1) {
            Serial.println(F("【传感器】数据校验失败，重试..."));
            delay(SENSOR_TIMEOUT);
        }
    }
    
    if (!readSuccess) {
        Serial.println(F("【传感器】读取失败，已重试") + String(SENSOR_RETRY_COUNT) + F("次"));
        data.temperature = NAN;
        data.ph = NAN;
        data.dissolvedOxygen = NAN;
        data.valid = false;
    } else {
        Serial.printf("【采集】温度:%.1f°C pH:%.2f 溶氧:%.2fmg/L\n",
                      data.temperature, data.ph, data.dissolvedOxygen);
    }
    
    return data;
}

// Modbus 读取回调函数
uint8_t cbRead(Modbus::ResultCode event, uint16_t transactionId, void* data) {
    if (event == Modbus::EX_SUCCESS) {
        // 读取成功
    } else {
        // 读取失败
        Serial.printf("【传感器】Modbus 错误码: 0x%02X\n", event);
    }
    return 0;
}

// 检查 Modbus 连接是否正常
bool checkSensorConnection() {
    uint16_t testReg;
    uint8_t result = mb.readHreg(MODBUS_SLAVE_ID, REG_TEMPERATURE, &testReg, 1, cbRead);
    
    unsigned long startTime = millis();
    while (mb.slave()) {
        if (millis() - startTime > SENSOR_TIMEOUT) {
            return false;
        }
        delay(10);
    }
    return true;
}