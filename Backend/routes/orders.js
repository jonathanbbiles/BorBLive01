const express = require('express');
const { alpaca } = require('../lib/alpaca');
const router = express.Router();

function toAlpacaOrderSymbol(sym) {
  if (!sym) return sym;
  if (sym.includes('/')) return sym;
  if (sym.endsWith('USD') && sym.length > 3) return `${sym.slice(0, -3)}/USD`;
  return sym;
}

// GET /api/orders/open?symbol=BTCUSD
router.get('/orders/open', async (req, res) => {
  try {
    const raw = (req.query.symbol || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing required query param: symbol' });
    const symbol = toAlpacaOrderSymbol(raw);
    const resp = await alpaca.get('/orders', {
      params: { status: 'open', symbols: symbol, nested: false, limit: 200 },
    });
    if (resp.status >= 400) {
      return res.status(resp.status).json(Array.isArray(resp.data) ? resp.data : []);
    }
    const list = Array.isArray(resp.data) ? resp.data : (resp.data?.orders ?? []);
    const filtered = Array.isArray(list) ? list.filter(o => o?.symbol === symbol) : [];
    return res.json(filtered);
  } catch (err) {
    return res.status(500).json({
      error: 'Backend error fetching open orders',
      message: err?.message || String(err),
    });
  }
});

// POST /api/orders
router.post('/orders', async (req, res) => {
  try {
    const payload = { ...req.body };
    if (!payload || !payload.symbol || !payload.side || !payload.type) {
      return res.status(400).json({ error: 'symbol, side, and type are required' });
    }
    payload.symbol = toAlpacaOrderSymbol(String(payload.symbol).trim());
    if (!payload.time_in_force) payload.time_in_force = 'gtc';
    const r = await alpaca.post('/orders', payload);
    return res.status(r.status).json(r.data);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to place order', message: e?.message || String(e) });
  }
});

// GET /api/orders/:id
router.get('/orders/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing order id' });
  try {
    const r = await alpaca.get(`/orders/${encodeURIComponent(id)}`);
    return res.status(r.status).json(r.data);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch order', message: e?.message || String(e) });
  }
});

// POST /api/orders/limit-sell { symbol, qty, limit_price }
router.post('/orders/limit-sell', async (req, res) => {
  try {
    const { symbol, qty, limit_price } = req.body || {};
    if (!symbol || !qty || !limit_price) {
      return res.status(400).json({ error: 'symbol, qty, and limit_price are required' });
    }
    const payload = {
      symbol: toAlpacaOrderSymbol(String(symbol).trim()),
      qty,
      side: 'sell',
      type: 'limit',
      time_in_force: 'gtc',
      limit_price,
    };
    const r = await alpaca.post('/orders', payload);
    return res.status(r.status).json(r.data);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to place limit sell', message: e?.message || String(e) });
  }
});

module.exports = { router };
