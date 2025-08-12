const axios = require('axios');

const ALPACA_BASE_URL = 'https://paper-api.alpaca.markets/v2';
const DATA_URL = 'https://data.alpaca.markets/v1beta2';
const API_KEY = process.env.ALPACA_API_KEY;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;

const HEADERS = {
  'APCA-API-KEY-ID': API_KEY,
  'APCA-API-SECRET-KEY': SECRET_KEY,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Places a limit buy order first, then a limit sell after the buy is filled.
async function placeLimitBuyThenSell(symbol, qty, limitPrice) {
  // submit the limit buy order
  const buyRes = await axios.post(
    `${ALPACA_BASE_URL}/orders`,
    {
      symbol,
      qty,
      side: 'buy',
      type: 'limit',
      // crypto orders must be GTC
      time_in_force: 'gtc',
      limit_price: limitPrice,
    },
    { headers: HEADERS }
  );

  const buyOrder = buyRes.data;

  // poll until the order is filled
  let filledOrder = buyOrder;
  for (let i = 0; i < 20; i++) {
    const check = await axios.get(`${ALPACA_BASE_URL}/orders/${buyOrder.id}`, {
      headers: HEADERS,
    });
    filledOrder = check.data;
    if (filledOrder.status === 'filled') break;
    await sleep(3000);
  }

  if (filledOrder.status !== 'filled') {
    throw new Error('Buy order not filled in time');
  }

  const avgPrice = parseFloat(filledOrder.filled_avg_price);
  const sellPrice = (avgPrice * 1.0025).toFixed(2);

  const sellRes = await axios.post(
    `${ALPACA_BASE_URL}/orders`,
    {
      symbol,
      qty: filledOrder.filled_qty,
      side: 'sell',
      type: 'limit',
      // match the buy order's time in force
      time_in_force: 'gtc',
      limit_price: sellPrice,
    },
    { headers: HEADERS }
  );

  return { buy: filledOrder, sell: sellRes.data };
}

// Fetch latest trade price for a symbol
async function getLatestPrice(symbol) {
  const res = await axios.get(
    `${DATA_URL}/crypto/latest/trades?symbols=${symbol}`,
    { headers: HEADERS }
  );
  const trade = res.data.trades && res.data.trades[symbol];
  if (!trade) throw new Error(`Price not available for ${symbol}`);
  return parseFloat(trade.p);
}

// Get available cash in the Alpaca account
async function getAccountCash() {
  const res = await axios.get(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
  return parseFloat(res.data.cash);
}

// Round quantities to Alpaca's supported crypto precision
function roundQty(qty) {
  return parseFloat(Number(qty).toFixed(8));
}

// Round prices to two decimals
function roundPrice(price) {
  return parseFloat(Number(price).toFixed(2));
}

// Market buy using 10% of cash then place a limit sell 0.25% higher
async function placeMarketBuyThenSell(symbol) {
  const [price, cash] = await Promise.all([
    getLatestPrice(symbol),
    getAccountCash(),
  ]);

  if (cash < 10) {
    throw new Error('Insufficient cash for trade');
  }

  const allocation = Math.min(Math.max(cash * 0.1, 10), cash);
  const qty = roundQty(allocation / price);
  if (qty <= 0) {
    throw new Error('Insufficient cash for trade');
  }

  const buyRes = await axios.post(
    `${ALPACA_BASE_URL}/orders`,
    {
      symbol,
      qty,
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc',
    },
    { headers: HEADERS }
  );

  const buyOrder = buyRes.data;

  // Wait for fill
  let filled = buyOrder;
  for (let i = 0; i < 20; i++) {
    const chk = await axios.get(`${ALPACA_BASE_URL}/orders/${buyOrder.id}`, {
      headers: HEADERS,
    });
    filled = chk.data;
    if (filled.status === 'filled') break;
    await sleep(3000);
  }

  if (filled.status !== 'filled') {
    throw new Error('Buy order not filled in time');
  }

  // Wait 10 seconds before selling
  await sleep(10000);

  const limitPrice = roundPrice(parseFloat(filled.filled_avg_price) * 1.0025);

  try {
    const sellRes = await axios.post(
      `${ALPACA_BASE_URL}/orders`,
      {
        symbol,
        qty: filled.filled_qty,
        side: 'sell',
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: limitPrice,
      },
      { headers: HEADERS }
    );
    return { buy: filled, sell: sellRes.data };
  } catch (err) {
    console.error('Sell order failed:', err?.response?.data || err.message);
    return { buy: filled, sell: null, sellError: err.message };
  }
}

module.exports = {
  placeLimitBuyThenSell,
  placeMarketBuyThenSell,
};
