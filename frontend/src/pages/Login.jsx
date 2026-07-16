import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Input, Button, Toast } from 'antd-mobile';
import { UserOutline, LockOutline } from 'antd-mobile-icons';
import { login as apiLogin } from '../services/api';
import { setToken, setUser } from '../utils/auth';

export default function LoginPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const res = await apiLogin(values.username, values.password);
      if (res && res.token) {
        setToken(res.token);
        setUser({ id: res.userId, username: values.username, role: res.role });
        Toast.show({ icon: 'success', content: '登录成功' });
        navigate('/', { replace: true });
      } else {
        Toast.show({ icon: 'fail', content: '登录失败，请重试' });
      }
    } catch (err) {
      const msg = err?.response?.data?.message || err?.message || '登录失败，请检查用户名和密码';
      Toast.show({ icon: 'fail', content: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1677ff 0%, #0050b3 50%, #003a8c 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 32px',
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
            fontSize: 36,
          }}
        >
          💧
        </div>
        <h1 style={{ color: '#fff', fontSize: 24, fontWeight: 700, margin: 0 }}>
          智慧水质监控平台
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, marginTop: 8 }}>
          实时监测 · 智能预警 · 远程控制
        </p>
      </div>

      <div
        style={{
          width: '100%',
          maxWidth: 360,
          background: '#fff',
          borderRadius: 16,
          padding: '32px 24px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
        }}
      >
        <h2 style={{ textAlign: 'center', fontSize: 18, fontWeight: 600, marginBottom: 24, color: '#333' }}>
          用户登录
        </h2>

        <Form
          onFinish={onFinish}
          layout="horizontal"
          footer={
            <Button
              block
              type="submit"
              color="primary"
              size="large"
              loading={loading}
              style={{ borderRadius: 8, height: 44, marginTop: 8 }}
            >
              登 录
            </Button>
          }
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<UserOutline />}
              placeholder="请输入用户名"
              clearable
              style={{ '--font-size': '16px' }}
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input
              prefix={<LockOutline />}
              placeholder="请输入密码"
              type="password"
              clearable
              style={{ '--font-size': '16px' }}
            />
          </Form.Item>
        </Form>
      </div>

      <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 32 }}>
        © 2024 智慧水质监控平台
      </p>
    </div>
  );
}