import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import { useAuth } from './context/AuthContext.jsx';
import AccountPage from './pages/AccountPage.jsx';
import { AccountDetailPage, AccountsPage } from './pages/AccountsPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import BillingPage from './pages/BillingPage.jsx';
import DevelopersPage from './pages/DevelopersPage.jsx';
import FAQPage from './pages/FAQPage.jsx';
import HomePage from './pages/HomePage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import NewPlatformPage from './pages/NewPlatformPage.jsx';
import NewTillPage from './pages/NewTillPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/PasswordPages.jsx';
import PaymentPage from './pages/PaymentPage.jsx';
import PaymentsPage from './pages/PaymentsPage.jsx';
import PlatformPage from './pages/PlatformPage.jsx';
import PlatformsPage from './pages/PlatformsPage.jsx';
import PrivacyPage from './pages/PrivacyPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import TermsPage from './pages/TermsPage.jsx';
import TillPage from './pages/TillPage.jsx';
import TillsPage from './pages/TillsPage.jsx';

function RequireSignIn({ children }) {
  const { admin, checking } = useAuth();
  const location = useLocation();
  if (checking) return <Spinner label="Signing you in…" />;
  if (!admin) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

// Pages only the ISA Tech team sees (the API refuses merchants too).
function StaffOnly({ children }) {
  const { isStaff } = useAuth();
  return isStaff ? children : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/home" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />

      {/* Public informational pages */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/faq" element={<FAQPage />} />

      <Route
        element={
          <RequireSignIn>
            <Layout />
          </RequireSignIn>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="payments/:id" element={<PaymentPage />} />
        <Route path="platforms" element={<PlatformsPage />} />
        <Route path="platforms/new" element={<NewPlatformPage />} />
        <Route path="platforms/:id" element={<PlatformPage />} />
        <Route path="tills" element={<TillsPage />} />
        <Route path="tills/new" element={<NewTillPage />} />
        <Route path="tills/:id" element={<TillPage />} />
        <Route path="developers" element={<DevelopersPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route
          path="accounts"
          element={
            <StaffOnly>
              <AccountsPage />
            </StaffOnly>
          }
        />
        <Route
          path="accounts/:id"
          element={
            <StaffOnly>
              <AccountDetailPage />
            </StaffOnly>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
