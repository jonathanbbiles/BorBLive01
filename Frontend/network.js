const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:3000/api';

export async function fetchAccount() {
  const r = await fetch(`${BACKEND_URL}/alpaca/account`);
  if (!r.ok) throw new Error(`Account fetch failed ${r.status}`);
  return r.json();
}

export async function getOpenOrders(symbol) {
  const url = `${BACKEND_URL}/orders/open?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function getPosition(symbol) {
  const r = await fetch(`${BACKEND_URL}/positions/${encodeURIComponent(symbol)}`);
  if (!r.ok) return null;
  return r.json();
}

export async function placeOrder(order) {
  const r = await fetch(`${BACKEND_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Order failed ${r.status}: ${body}`);
  }
  return r.json();
}

export async function placeLimitSell({ symbol, qty, limit_price }) {
  return placeOrder({
    symbol,
    qty,
    side: 'sell',
    type: 'limit',
    time_in_force: 'gtc',
    limit_price,
  });
}
