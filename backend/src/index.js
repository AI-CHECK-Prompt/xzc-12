require('dotenv').config();

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const User = require('./models/User');

// 初始化服务
const { initRedis } = require('./services/redisClient');
const { initWebSocket } = require('./services/websocket');
const { initMqttClient } = require('./services/mqttClient');
const { checkDeviceOffline } = require('./services/alertEngine');

// 路由
const authRoutes = require('./routes/auth');
const pondRoutes = require('./routes/pond');
const dataRoutes = require('./routes/data');
const alertRoutes = require('./routes/alert');
const controlRoutes = require('./routes/control');
const deviceRoutes = require('./routes/device');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const server = http.createServer(app);

// 中间件
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 注册路由
app.use('/api/auth', authRoutes);
app.use('/api/ponds', pondRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/control', controlRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/analytics', analyticsRoutes);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'running',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[全局错误]', err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '服务器内部错误'
  });
});

// 404 处理
app.use((req, res) => {
  res.status(404).json({ success: false, message: '接口不存在' });
});

// 创建默认管理员账号
async function createDefaultAdmin() {
  try {
    const existingAdmin = await User.findOne({ username: 'admin' });
    if (!existingAdmin) {
      const admin = new User({
        username: 'admin',
        password: 'admin123',
        role: 'admin',
        phone: ''
      });
      await admin.save();
      console.log('[初始化] 默认管理员账号已创建: admin/admin123');
    }
  } catch (err) {
    console.error('[初始化] 创建默认管理员失败:', err.message);
  }
}

// 启动服务器
async function start() {
  try {
    // 连接 MongoDB
    console.log('[启动] 正在连接 MongoDB...');
    await mongoose.connect(config.mongodbUri);
    console.log('[MongoDB] 连接成功');

    // 连接 Redis
    console.log('[启动] 正在连接 Redis...');
    initRedis();
    console.log('[Redis] 初始化完成');

    // 创建默认管理员
    await createDefaultAdmin();

    // 初始化 WebSocket
    initWebSocket(server);

    // 启动 HTTP 服务器
    server.listen(config.port, () => {
      console.log(`[服务器] 已启动，端口: ${config.port}`);
    });

    // 初始化 MQTT 客户端
    console.log('[启动] 正在连接 MQTT Broker...');
    initMqttClient().then((client) => {
      if (client) {
        console.log('[MQTT] 初始化完成');
      } else {
        console.log('[MQTT] 启动时未连接到 Broker，将以离线模式运行');
      }
    });

    // 启动告警引擎定时检查（设备离线检查）
    setInterval(async () => {
      await checkDeviceOffline();
    }, 60000); // 每分钟检查一次

    console.log('[启动] 水质监控云平台后端服务已就绪');
  } catch (err) {
    console.error('[启动] 启动失败:', err.message);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\n[关闭] 正在关闭服务器...');
  await mongoose.connection.close();
  console.log('[MongoDB] 连接已关闭');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[关闭] 正在关闭服务器...');
  await mongoose.connection.close();
  console.log('[MongoDB] 连接已关闭');
  process.exit(0);
});

start();