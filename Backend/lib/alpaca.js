const axios = require('axios');

const {
  ALPACA_API_KEY,
  ALPACA_SECRET_KEY,
  ALPACA_BASE_URL = 'https://paper-api.alpaca.markets',
} = process.env;

if (!ALPACA_API_KEY || !ALPACA_SECRET_KEY) {
  throw new Error('Missing Alpaca API credentials. Check Backend/.env');
}

const base = (ALPACA_BASE_URL || '').replace(/\/+$/, '');
const alpaca = axios.create({
  baseURL: `${base}/v2`,
  headers: {
    'APCA-API-KEY-ID': ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  timeout: 15000,
  validateStatus: () => true,
});

module.exports = { alpaca };
