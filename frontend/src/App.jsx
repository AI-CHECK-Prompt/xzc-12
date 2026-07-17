import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { isAuthenticated } from './utils/auth';
import Layout from './components/Layout';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import PondDetailPage from './pages/PondDetail';
import AlertListPage from './pages/AlertList';
import DataHistoryPage from './pages/DataHistory';
import PondComparePage from './pages/PondCompare';
import CycleReviewPage from './pages/CycleReview';

function ProtectedRoute({ children }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="pond/:pondId" element={<PondDetailPage />} />
          <Route path="alerts" element={<AlertListPage />} />
          <Route path="history/:pondId" element={<DataHistoryPage />} />
          {/* 塘口对比 */}
          <Route path="compare" element={<PondComparePage />} />
          {/* 养殖周期复盘 */}
          <Route path="review/:pondId" element={<CycleReviewPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}