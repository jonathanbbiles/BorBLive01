const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:3000/api';

async function parseJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'Invalid JSON', raw: text };
  }
}

export async function fetchAccount() {
  const res = await fetch(`${BACKEND_URL}/alpaca/account`);
  return parseJson(res);
}

export async function getOpenOrders(symbol) {
  const res = await fetch(`${BACKEND_URL}/orders/open?symbol=${encodeURIComponent(symbol)}`);
  return parseJson(res);
}

export async function getPosition(symbol) {
  const res = await fetch(`${BACKEND_URL}/positions/${encodeURIComponent(symbol)}`);
  if (res.status === 404) return null;
  return parseJson(res);
}

export async function placeOrder(order) {
  const res = await fetch(`${BACKEND_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  });
  return parseJson(res);
}

export async function placeLimitSell({ symbol, qty, limit_price }) {
  const res = await fetch(`${BACKEND_URL}/orders/limit-sell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, qty, limit_price }),
  });
  return parseJson(res);
}

