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
      return res.status(resp.status).json({
        error: 'Alpaca orders request failed',
        status: resp.status,
        data: resp.data,
      });
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

module.exports = { router };
