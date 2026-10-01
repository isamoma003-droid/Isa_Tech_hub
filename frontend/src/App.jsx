import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import { useAuth } from './context/AuthContext.jsx';
import AccountPage from './pages/AccountPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NewPlatformPage from './pages/NewPlatformPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import PaymentPage from './pages/PaymentPage.jsx';
import PaymentsPage from './pages/PaymentsPage.jsx';
import PlatformPage from './pages/PlatformPage.jsx';
import PlatformsPage from './pages/PlatformsPage.jsx';
import TillPage from './pages/TillPage.jsx';
import TillsPage from './pages/TillsPage.jsx';

function RequireAdmin({ children }) {
  const { admin, checking } = useAuth();
  const location = useLocation();
  if (checking) return <Spinner label="Signing you in…" />;
  if (!admin) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAdmin>
            <Layout />
          </RequireAdmin>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="payments/:id" element={<PaymentPage />} />
        <Route path="platforms" element={<PlatformsPage />} />
        <Route path="platforms/new" element={<NewPlatformPage />} />
        <Route path="platforms/:id" element={<PlatformPage />} />
        <Route path="tills" element={<TillsPage />} />
        <Route path="tills/:id" element={<TillPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
