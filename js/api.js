import APP_CONFIG from '../app.config.js';

const TOKEN_KEY = 'rh.token';
const BASE_KEY = 'rh.apiBase';

/* localStorage throws in some privacy modes - never let that break the page. */
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Where the API lives. GitHub Pages is static-only, so a Pages deployment must
 * point at the Vercel deployment. Resolution order:
 *   ?api=<url>  ->  localStorage  ->  window.RH_API_BASE  ->  app.config.js  ->  same origin
 */
function resolveBase() {
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery !== null) store.set(BASE_KEY, fromQuery);
  const base =
    fromQuery || store.get(BASE_KEY) || window.RH_API_BASE || APP_CONFIG.apiBase || '';
  return String(base).replace(/\/+$/, '');
}

export const apiBase = resolveBase();

/** True when the page is served from somewhere that cannot host the API itself. */
export const needsRemoteApi = /\.github\.io$/i.test(location.hostname) && !apiBase;

export function getToken() {
  return store.get(TOKEN_KEY) || '';
}

export function setToken(token) {
  store.set(TOKEN_KEY, token);
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${apiBase}/api/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server. Check your connection.', 0);
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(`Unexpected response from ${apiBase || location.origin}/api/${path}`, res.status);
    }
  }
  if (!res.ok) {
    if (res.status === 401) setToken('');
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

export function fetchState({ from, to, signal } = {}) {
  const qs = from && to ? `?from=${from}&to=${to}` : '';
  return request(`state${qs}`, { signal });
}

export async function enter({ name, password, color }) {
  const data = await request('auth', {
    method: 'POST',
    body: { action: 'enter', name, password: password || undefined, color: color || undefined },
  });
  setToken(data.token);
  return data;
}

export async function logout() {
  try {
    await request('auth', { method: 'POST', body: { action: 'logout' } });
  } finally {
    setToken('');
  }
}

export function setColor(color) {
  return request('auth', { method: 'POST', body: { action: 'set-color', color } });
}

export function setPassword({ password, currentPassword }) {
  return request('auth', {
    method: 'POST',
    body: { action: 'set-password', password, currentPassword },
  });
}

export function writeSlots({ mode, days, startIdx, endIdx }) {
  return request('slots', { method: 'POST', body: { mode, days, startIdx, endIdx } });
}

export function clearAllSlots() {
  return request('slots', { method: 'POST', body: { mode: 'clear-all' } });
}
