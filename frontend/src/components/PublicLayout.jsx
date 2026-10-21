import { Outlet } from 'react-router-dom';
import Footer from './Footer.jsx';
import PublicNav from './PublicNav.jsx';

export default function PublicLayout() {
  return (
    <div className="public-layout">
      <PublicNav />
      <main className="public-main">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
