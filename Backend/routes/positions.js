const express = require('express');
const { alpaca } = require('../lib/alpaca');
const router = express.Router();

function toAlpacaSymbol(sym) {
  if (!sym) return sym;
  if (sym.includes('/')) return sym;
  if (sym.endsWith('USD') && sym.length > 3) return `${sym.slice(0, -3)}/USD`;
  return sym;
}

// GET /api/positions/:symbol
router.get('/positions/:symbol', async (req, res) => {
  const symbol = toAlpacaSymbol((req.params.symbol || '').trim());
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  try {
    const r = await alpaca.get(`/positions/${encodeURIComponent(symbol)}`);
    return res.status(r.status).json(r.data);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch position', message: e?.message || String(e) });
  }
});

module.exports = { router };
