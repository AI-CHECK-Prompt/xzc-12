const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }

    const token = jwt.sign(
      { userId: user._id, username: user.username, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user._id,
          username: user.username,
          role: user.role,
          phone: user.phone
        }
      }
    });
  } catch (err) {
    console.error('[登录] 错误:', err.message);
    res.status(500).json({ success: false, message: '登录失败' });
  }
});

// POST /api/auth/register
router.post('/register', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '仅管理员可创建用户' });
    }

    const { username, password, role, phone } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ success: false, message: '用户名已存在' });
    }

    const validRoles = ['admin', 'operator', 'viewer'];
    const userRole = validRoles.includes(role) ? role : 'viewer';

    const user = new User({
      username,
      password,
      role: userRole,
      phone: phone || ''
    });

    await user.save();

    res.json({
      success: true,
      data: {
        id: user._id,
        username: user.username,
        role: user.role,
        phone: user.phone
      }
    });
  } catch (err) {
    console.error('[注册] 错误:', err.message);
    res.status(500).json({ success: false, message: '注册失败' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  res.json({
    success: true,
    data: {
      id: req.user._id,
      username: req.user.username,
      role: req.user.role,
      phone: req.user.phone
    }
  });
});

module.exports = router;