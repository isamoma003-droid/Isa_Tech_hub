import { useEffect, useState } from 'react';

// Makes the dashboard an installable app (desktop, Android, iPhone). The browser offers to install
// it once the service worker is running; the Install button below triggers that offer.
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('IsaPay app mode is unavailable:', err.message));
  });
}

let deferredPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;

/**
 * { canInstall, install, installed, iosHint }: canInstall when the browser can install the app
 * with one click; iosHint on iPhone/iPad, where it's added from Share → Add to Home Screen.
 */
export function useInstallPrompt() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  const installed = isStandalone();
  return {
    installed,
    canInstall: Boolean(deferredPrompt) && !installed,
    iosHint: !installed && !deferredPrompt && isIos(),
    install: async () => {
      if (!deferredPrompt) return false;
      const prompt = deferredPrompt;
      deferredPrompt = null;
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      notify();
      return outcome === 'accepted';
    },
  };
}
