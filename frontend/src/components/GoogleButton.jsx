import { useEffect, useRef, useState } from 'react';
import { useAuthConfig } from '../api/queries.js';

// Google's "Sign in with Google" button (Google Identity Services). Google hands us a signed ID
// token; the API checks it with Google's keys. Shown only when the server has a GOOGLE_CLIENT_ID.
let script = null;
function loadGoogle() {
  script ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const tag = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
    tag.onload = () => resolve(window.google);
    tag.onerror = () => {
      script = null;
      tag.remove();
      reject(new Error('Google sign-in could not load'));
    };
    document.head.append(tag);
  });
  return script;
}

/** text: 'continue_with' | 'signin_with' | 'signup_with' (Google's wording). */
export default function GoogleButton({ onCredential, text = 'continue_with' }) {
  const { data: config } = useAuthConfig();
  const clientId = config?.google?.clientId;
  const box = useRef(null);
  const handler = useRef(onCredential);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    handler.current = onCredential;
  });

  useEffect(() => {
    if (!clientId) return undefined;
    let cancelled = false;
    loadGoogle()
      .then((google) => {
        if (cancelled || !box.current) return;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => handler.current(response.credential),
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        google.accounts.id.renderButton(box.current, {
          type: 'standard',
          theme: dark ? 'filled_black' : 'outline',
          size: 'large',
          shape: 'pill',
          text,
          logo_alignment: 'center',
          width: Math.max(200, Math.min(400, box.current.offsetWidth || 320)),
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [clientId, text]);

  if (!clientId) return null;
  if (failed) return <p className="hint">Google sign-in couldn't load. Check your connection, or use your email and password.</p>;
  return <div ref={box} className="google-button" />;
}

/** "or" between Google and the email form, only when Google is on. */
export function OrDivider() {
  const { data: config } = useAuthConfig();
  if (!config?.google) return null;
  return (
    <div className="or-divider" role="separator">
      <span>or with your email</span>
    </div>
  );
}
