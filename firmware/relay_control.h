#ifndef RELAY_CONTROL_H
#define RELAY_CONTROL_H

#include <Arduino.h>

// 初始化继电器控制引脚
void initRelay();

// 开启增氧机
void turnAeratorOn();

// 关闭增氧机
void turnAeratorOff();

// 获取固件内部记录的增氧机状态（最后一次执行命令的目标值）
bool getAeratorStatus();

// 读回 GPIO 实际电平，反映继电器输出端的真实状态
// 说明：物理旁路（运维人员拉下空气开关 / 在接触器后端短接三相线）改变的是
//       接触器后端的真实通路，ESP32 读 GPIO 只能反映继电器线圈输出，
//       无法感知接触器之后的人工旁路——此局限需由硬件层面（接触器辅助触点反馈）解决。
bool getAeratorActualStatus();

#endif