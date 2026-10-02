import { env } from '../config/env.js';

// Pings the Hub's own public address so Render's free plan doesn't put it to sleep. The request
// goes out through the internet and back in through Render's load balancer, which is what Render
// counts as activity; a call to localhost would not count. Keep the interval under 15 minutes.
export function startKeepAlive({ url = `${env.publicUrl}/health`, everyMs = env.keepAliveEveryMs, fetchFn = fetch } = {}) {
  if (!/^https?:\/\//.test(url) || url.includes('localhost')) {
    console.log('Keep-alive is off: PUBLIC_URL / RENDER_EXTERNAL_URL is not a public address');
    return () => {};
  }
  const ping = async () => {
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': 'isapay-keep-alive' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) console.warn(`Keep-alive ping to ${url} answered ${res.status}`);
    } catch (err) {
      console.warn(`Keep-alive ping to ${url} failed: ${err.message}`);
    }
  };
  const timer = setInterval(ping, Math.max(everyMs, 60_000));
  timer.unref?.();
  console.log(`Keep-alive on: pinging ${url} every ${Math.round(Math.max(everyMs, 60_000) / 60_000)} min (KEEP_ALIVE=false turns it off)`);
  return () => clearInterval(timer);
}
