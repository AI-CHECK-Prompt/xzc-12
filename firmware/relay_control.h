#ifndef RELAY_CONTROL_H
#define RELAY_CONTROL_H

#include <Arduino.h>

// 初始化继电器控制引脚
void initRelay();

// 开启增氧机
void turnAeratorOn();

// 关闭增氧机
void turnAeratorOff();

// 获取增氧机当前状态
bool getAeratorStatus();

#endif