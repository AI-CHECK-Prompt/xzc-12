#ifndef CONFIG_H
#define CONFIG_H

// WiFi 配置
#define WIFI_SSID "water_monitor"
#define WIFI_PASSWORD "water123456"

// MQTT Broker 配置
#define MQTT_HOST "192.168.1.100"
#define MQTT_PORT 1883
#define MQTT_CLIENT_ID "ESP32_POND_001"

// 塘口和设备编号
#define POND_ID "POND_001"
#define DEVICE_ID "DEV_001"

// 数据上报间隔（毫秒），默认5分钟
#define REPORT_INTERVAL 300000

// 传感器采集间隔（毫秒），默认60秒
#define SAMPLE_INTERVAL 60000

// RS485 引脚
#define RS485_RX 16
#define RS485_TX 17
#define RS485_DE_RE 4  // RS485 方向控制引脚

// 增氧机继电器引脚
#define AERATOR_RELAY 5

// Modbus 从机地址
#define MODBUS_SLAVE_ID 1

// 缓存文件路径
#define CACHE_FILE "/data_cache.json"

// 最大缓存条数
#define MAX_CACHE_SIZE 240  // 2小时 x 每分钟一条

// 固件版本号
// 1.1.0 起：执行增氧机控制后主动回执（pond/{POND_ID}/control/ack），
//           后端可据此区分"待确认"和"已确认"
// 1.0.0：不发回执，后端走短超时兜底
#define FIRMWARE_VERSION "1.1.0"

// 心跳间隔（毫秒），默认30秒
#define HEARTBEAT_INTERVAL 30000

// 继电器最小开关间隔（毫秒）
#define RELAY_COOLDOWN 3000

// 传感器读取超时（毫秒）
#define SENSOR_TIMEOUT 500

// 传感器读取重试次数
#define SENSOR_RETRY_COUNT 3

// WiFi 连接超时（毫秒）
#define WIFI_TIMEOUT 30000

#endif