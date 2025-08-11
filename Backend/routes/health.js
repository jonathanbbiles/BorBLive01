const express = require('express');
const { alpaca } = require('../lib/alpaca');
const router = express.Router();

router.get('/ping', (req, res) => res.json({ status: 'ok' }));

router.get('/alpaca/ping', async (req, res) => {
  try {
    const r = await alpaca.get('/account');
    if (r.status >= 400) {
      return res
        .status(r.status)
        .json({ ok: false, status: r.status, data: r.data });
    }
    return res.json({ ok: true, account_id: r.data?.id, status: r.data?.status });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || String(e) });
  }
});

router.get('/alpaca/account', async (req, res) => {
  try {
    const r = await alpaca.get('/account');
    return res.status(r.status).json(r.data);
  } catch (e) {
    return res
      .status(500)
      .json({ error: 'Backend error fetching account', message: e?.message || String(e) });
  }
});

module.exports = { router };
