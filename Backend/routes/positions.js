const express = require('express');
const { alpaca } = require('../lib/alpaca');

const router = express.Router();

function toAlpacaOrderSymbol(sym) {
  if (!sym) return sym;
  if (sym.includes('/')) return sym;
  if (sym.endsWith('USD') && sym.length > 3) return `${sym.slice(0, -3)}/USD`;
  return sym;
}

router.get('/positions/:symbol', async (req, res) => {
  try {
    const raw = (req.params.symbol || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing required param: symbol' });

    const symbol = toAlpacaOrderSymbol(raw);
    const resp = await alpaca.get(`/positions/${symbol}`);
    if (resp.status === 404) return res.status(404).json(null);
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'Backend error fetching position', message: err?.message || String(err) });
  }
});

module.exports = { router };

