// network.js — Snack-safe network client for Expo.dev

// Snack doesn't expose process.env. You MUST set this global in App.js (see below).
// It MUST be an HTTPS URL to your deployed backend, ending with /api
const BACKEND_URL = global?.EXPO_PUBLIC_BACKEND_URL;

if (!BACKEND_URL || !/^https:\/\//.test(BACKEND_URL)) {
  // Fail early with a clear message in Snack if the global isn't set
  console.warn(
    '[network] Missing or non-HTTPS global.EXPO_PUBLIC_BACKEND_URL. ' +
      'Set it at the top of App.js to your deployed backend, e.g. ' +
      "global.EXPO_PUBLIC_BACKEND_URL = 'https://<your-render>.onrender.com/api';"
  );
}

// --- helpers ---
async function parseJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'Invalid JSON', raw: text };
  }
}

function api(url) {
  if (!BACKEND_URL) throw new Error('BACKEND_URL not set. Define global.EXPO_PUBLIC_BACKEND_URL in App.js.');
  return `${BACKEND_URL}${url}`;
}

// --- endpoints ---
export async function fetchAccount() {
  const res = await fetch(api('/alpaca/account'));
  return parseJson(res);
}

export async function getOpenOrders(symbol) {
  const res = await fetch(api(`/orders/open?symbol=${encodeURIComponent(symbol)}`));
  const data = await parseJson(res);
  // Always return an array to keep UI safe from .filter/.map crashes
  return Array.isArray(data) ? data : [];
}

export async function getPosition(symbol) {
  const res = await fetch(api(`/positions/${encodeURIComponent(symbol)}`));
  if (res.status === 404) return null;
  return parseJson(res);
}

export async function placeOrder(order) {
  const res = await fetch(api('/orders/market'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  });
  return parseJson(res);
}

export async function placeLimitSell({ symbol, qty, limit_price }) {
  const res = await fetch(api('/orders/limit-sell'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, qty, limit_price }),
  });
  return parseJson(res);
}

// Visibility for Snack console
console.log('[network] BACKEND_URL =', BACKEND_URL);
