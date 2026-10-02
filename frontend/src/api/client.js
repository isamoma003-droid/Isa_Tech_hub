export const API_URL = new URL((import.meta.env.VITE_API_URL || '/api').replace(/\/$/, ''), window.location.origin).href;
const TOKEN_KEY = 'isa-hub-token';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Session storage: closing the tab signs you out, which suits a dashboard that runs the till.
export const tokenStore = {
  get: () => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token) => {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Storage unavailable: the session lasts until the page reloads.
    }
  },
};

let unauthorizedHandler = () => {};
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

const authHeaders = () => {
  const token = tokenStore.get();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

async function send(path, { method = 'GET', body } = {}) {
  try {
    return await fetch(`${API_URL}/admin${path}`, {
      method,
      headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach IsaPay. Check your connection and that the API is running.');
  }
}

async function fail(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  if (res.status === 401) unauthorizedHandler();
  throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
}

export async function api(path, options) {
  const res = await send(path, options);
  if (!res.ok) await fail(res);
  return res.status === 204 ? null : res.json();
}

// Downloads a file (CSV export) with the session token attached.
export async function download(path, fallbackName) {
  const res = await send(path);
  if (!res.ok) await fail(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Builds "?a=1&b=2" from an object, skipping empty values.
export function queryString(params) {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
}
