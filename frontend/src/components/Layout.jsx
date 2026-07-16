import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { NavBar, TabBar, Badge } from 'antd-mobile';
import { AppOutline, UnorderedListOutline } from 'antd-mobile-icons';
import { getUser, logout } from '../utils/auth';
import * as api from '../services/api';

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [unreadCount, setUnreadCount] = useState(0);
  const user = getUser();

  const tabs = [
    { key: '/', title: '首页', icon: <AppOutline /> },
    { key: '/alerts', title: '告警', icon: <UnorderedListOutline />, badge: unreadCount > 0 ? Badge : null },
  ];

  const activeKey = location.pathname.startsWith('/alerts') ? '/alerts' : '/';

  useEffect(() => {
    fetchUnreadCount();
    const timer = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(timer);
  }, []);

  const fetchUnreadCount = async () => {
    try {
      const res = await api.getUnreadAlertCount();
      setUnreadCount(res?.count || 0);
    } catch {
      // ignore
    }
  };

  const handleLogout = () => {
    logout();
  };

  const tabBarItems = tabs.map((tab) => {
    const item = {
      key: tab.key,
      title: tab.title,
      icon: tab.icon,
    };
    if (tab.badge && unreadCount > 0) {
      item.badge = unreadCount > 99 ? '99+' : String(unreadCount);
    }
    return item;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#f5f5f5' }}>
      <NavBar
        back={null}
        style={{ background: '#1677ff', color: '#fff' }}
        right={
          <span
            onClick={handleLogout}
            style={{ color: '#fff', fontSize: 14, cursor: 'pointer' }}
          >
            退出
          </span>
        }
      >
        <span style={{ color: '#fff', fontSize: 16, fontWeight: 600 }}>水质监控</span>
      </NavBar>

      <div style={{ flex: 1, overflow: 'auto', paddingBottom: 50 }}>
        <Outlet />
      </div>

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#fff', borderTop: '1px solid #eee' }}>
        <TabBar
          activeKey={activeKey}
          onChange={(key) => navigate(key)}
          safeArea
        >
          {tabBarItems.map((item) => (
            <TabBar.Item key={item.key} {...item} />
          ))}
        </TabBar>
      </div>
    </div>
  );
}