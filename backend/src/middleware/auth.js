const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: '缺少认证令牌' });
    }

    const token = authHeader.substring(7);
    if (!token) {
      return res.status(401).json({ success: false, message: '无效的认证令牌' });
    }

    const decoded = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: '认证令牌无效' });
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: '认证令牌已过期' });
    }
    return res.status(500).json({ success: false, message: '认证服务异常' });
  }
}

// 需要管理员权限
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: '请先登录' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '需要管理员权限' });
  }
  next();
}

// 需要操作权限
function requireOperator(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: '请先登录' });
  }
  if (!['admin', 'operator'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: '需要操作权限' });
  }
  next();
}

module.exports = { authMiddleware, requireAdmin, requireOperator };