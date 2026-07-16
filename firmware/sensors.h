#ifndef SENSORS_H
#define SENSORS_H

#include <Arduino.h>
#include <ModbusRTU.h>

// 传感器数据结构体
struct SensorData {
    float temperature;       // 水温 (°C)
    float ph;                // pH值
    float dissolvedOxygen;   // 溶氧 (mg/L)
    bool valid;              // 数据是否有效
};

// Modbus 从机地址
#define MODBUS_SLAVE_ID 1

// 传感器寄存器地址
#define REG_TEMPERATURE   0x0000  // 水温寄存器
#define REG_PH            0x0001  // pH值寄存器
#define REG_DO            0x0002  // 溶氧寄存器

// 读取寄存器数量
#define REG_COUNT 3

// 初始化传感器 Modbus 通信
void initSensors();

// 读取传感器数据
SensorData readSensors();

// 检查 Modbus 连接是否正常
bool checkSensorConnection();

#endif