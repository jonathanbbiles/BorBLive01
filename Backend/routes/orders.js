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
      return res
        .status(resp.status)
        .json({ error: 'Alpaca orders request failed', status: resp.status, data: resp.data });
    }

    const list = Array.isArray(resp.data) ? resp.data : resp.data?.orders ?? [];
    const filtered = Array.isArray(list) ? list.filter((o) => o?.symbol === symbol) : [];
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
    const order = req.body || {};
    if (!order.symbol) {
      return res.status(400).json({ error: 'Missing required field: symbol' });
    }
    const payload = { ...order, symbol: toAlpacaOrderSymbol(order.symbol) };
    const resp = await alpaca.post('/orders', payload);
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Backend error placing order', message: err?.message || String(err) });
  }
});

// GET /api/orders/:id
router.get('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resp = await alpaca.get(`/orders/${id}`);
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Backend error fetching order', message: err?.message || String(err) });
  }
});

// POST /api/orders/limit-sell
router.post('/orders/limit-sell', async (req, res) => {
  try {
    const { symbol, qty, limit_price } = req.body || {};
    if (!symbol || !qty || !limit_price) {
      return res
        .status(400)
        .json({ error: 'Missing required fields: symbol, qty, limit_price' });
    }
    const order = {
      symbol: toAlpacaOrderSymbol(symbol),
      qty,
      side: 'sell',
      type: 'limit',
      time_in_force: 'gtc',
      limit_price,
    };
    const resp = await alpaca.post('/orders', order);
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Backend error placing limit sell', message: err?.message || String(err) });
  }
});

module.exports = { router };

