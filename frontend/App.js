import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  Switch,
} from 'react-native';

/*
* Educational example. Uses Alpaca + CryptoCompare.
* Adds: statistical entry gates, ATR risk sizing, TP + trailing stop + break-even.
* NOTE: Hardcoded keys are for illustration only. Move to env/secure storage in production.
*/

// ==================== API CONFIG ====================
const ALPACA_KEY = 'AKS3TBCTY4CFZ2LBK2GZ';
const ALPACA_SECRET = 'fX1QUAM5x8FGeGcEneIrgTCQXRSwcZnoaxHC6QXM';
const ALPACA_BASE_URL = 'https://api.alpaca.markets/v2'; // live

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json',
};

// (Kept for compatibility; not used now that exits are ATR-based)
const FEE_BUFFER = 0.0025; // 0.25% taker fee
const TARGET_PROFIT = 0.0005; // 0.05% desired profit
const TOTAL_MARKUP = FEE_BUFFER + TARGET_PROFIT;

const CRYPTO_TIME_IN_FORCE = 'gtc';

// Track tokens that ran out of funds this cycle (kept from original)
let perSymbolFundsLock = {};

// ===== Strategy Config (tunable) =====
// LOOSENED: thresholds + flexible N-of-4 gate + edge guard
const CFG = {
  // gating (loosened)
  vol:   { lookbackBars: 20, minSigma: 0.0015 },   // was 0.003
  z:     { lookbackBars: 20, minAbsZ: 0.6 },       // was 1.0
  macd:  { fast: 12, slow: 26, signal: 9, minHistSlopeBars: 1 }, // was 2
  trend: { emaFast: 50, emaSlow: 200, requireUp: false },        // allow counter-trend entries
  rsi:   { length: 14 },

  // scoring (slightly easier)
  weights: { macdSlope: 0.4, trendAlign: 0.35, rsiCtx: 0.25 },
  minScore: 50,  // was 60

  // NEW: flexible gate — how many of {slopeOK, volOK, zOK, trendPass} must be true
  gating: { minPassCount: 2 },  // use 2 for aggressive, 3 for balanced

  // risk & sizing (unchanged) + minimal TP edge guard
  risk: {
    riskPerTradePctEquity: 0.25,   // % equity at risk if stop hits
    atrLen: 14,
    atrKStop: 1.5,                 // initial stop distance = k * ATR
    maxPosPctEquity: 15,
    minNotionalUSD: 5,
    useNonMarginableBP: true,      // crypto sizing fix
    minEdgeBps: 8,                 // NEW: require TP >= 8 bps of price (~0.08%)
  },

  // exits (unchanged)
  exits: {
    tpKatr: 1.0,                   // take profit = entry + k*ATR
    trailKatr: 0.75,               // trailing stop distance after break-even
    breakevenAfterKatr: 0.75,      // once up this much, stop bumps to entry
    limitReplaceSecs: 30,          // how often to refresh TP limit
    markRefreshSecs: 10,           // trailing/stop cadence
  },
};

// Allow components to subscribe to log entries so they can display them
let logSubscriber = null;
export const registerLogSubscriber = (fn) => { logSubscriber = fn; };

// Simple logger to trace trade attempts.
const logTradeAction = async (type, symbol, details = {}) => {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, symbol, ...details };
  console.log('[TRADE LOG]', entry);
  if (typeof logSubscriber === 'function') {
    try { logSubscriber(entry); } catch (err) { console.warn('Log subscriber error:', err); }
  }
};

// List of crypto pairs we want to follow.
const ORIGINAL_TOKENS = [
  { name: 'BTC/USD', symbol: 'BTCUSD', cc: 'BTC' },
  { name: 'ETH/USD', symbol: 'ETHUSD', cc: 'ETH' },
  { name: 'SOL/USD', symbol: 'SOLUSD', cc: 'SOL' },
  { name: 'LTC/USD', symbol: 'LTCUSD', cc: 'LTC' },
  { name: 'BCH/USD', symbol: 'BCHUSD', cc: 'BCH' },
  { name: 'DOGE/USD', symbol: 'DOGEUSD', cc: 'DOGE' },
  { name: 'AVAX/USD', symbol: 'AVAXUSD', cc: 'AVAX' },
  { name: 'ADA/USD', symbol: 'ADAUSD', cc: 'ADA' },
  { name: 'AAVE/USD', symbol: 'AAVEUSD', cc: 'AAVE' },
  { name: 'UNI/USD', symbol: 'UNIUSD', cc: 'UNI' },
  { name: 'MATIC/USD', symbol: 'MATICUSD', cc: 'MATIC' },
  { name: 'LINK/USD', symbol: 'LINKUSD', cc: 'LINK' },
  { name: 'SHIB/USD', symbol: 'SHIBUSD', cc: 'SHIB' },
  { name: 'XRP/USD', symbol: 'XRPUSD', cc: 'XRP' },
  { name: 'USDT/USD', symbol: 'USDTUSD', cc: 'USDT' },
  { name: 'USDC/USD', symbol: 'USDCUSD', cc: 'USDC' },
  { name: 'TRX/USD', symbol: 'TRXUSD', cc: 'TRX' },
  { name: 'ETC/USD', symbol: 'ETCUSD', cc: 'ETC' },
];

// ============== Math & Indicators Helpers ==============
const emaArr = (arr, span) => {
  if (!arr?.length) return [];
  const k = 2 / (span + 1);
  let prev = arr[0];
  const out = [prev];
  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
};

const stdDev = (arr) => {
  const n = arr.length;
  if (n < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const v = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(v);
};

const calcATR = (bars, len = 14) => {
  if (!Array.isArray(bars) || bars.length < len + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, cPrev = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev)));
  }
  return emaArr(tr, len).slice(-1)[0]; // Wilder via EMA approx
};

const zScore = (closes, L = 20) => {
  if (!closes || closes.length < L) return 0;
  const s = closes.slice(-L);
  const mu = s.reduce((a, b) => a + b, 0) / L;
  const sd = stdDev(s);
  return sd === 0 ? 0 : (s[s.length - 1] - mu) / sd;
};

const logRetSigma = (closes, L = 20) => {
  if (!closes || closes.length < L + 1) return 0;
  const last = closes.slice(-(L + 1));
  const rets = [];
  for (let i = 1; i < last.length; i++) rets.push(Math.log(last[i] / last[i - 1]));
  return stdDev(rets);
};

const calcMACDFull = (closes, fast = 12, slow = 26, sig = 9) => {
  if (!closes || closes.length < slow + sig) return null;
  const emaFast = emaArr(closes, fast);
  const emaSlow = emaArr(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signal = emaArr(macdLine, sig);
  const hist = macdLine.map((v, i) => v - signal[i]);
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signal[signal.length - 1],
    histArr: hist,
  };
};

const macdHistSlopeIncreasing = (histArr, k = 2) => {
  if (!histArr || histArr.length < k + 1) return false;
  const h = histArr.slice(-(k + 1));
  for (let i = 1; i < h.length; i++) if (!(h[i] > h[i - 1])) return false;
  return true;
};

const emaTrendOK = (closes, fast = 50, slow = 200) => {
  if (!closes || closes.length < slow) return false;
  const ef = emaArr(closes, fast).slice(-1)[0];
  const es = emaArr(closes, slow).slice(-1)[0];
  return ef > es;
};

// ===== Original helpers kept =====
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Basic RSI (original)
const calcRSI = (closes, period = 14) => {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta; else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

// Trend glyph via linear regression slope (original)
const getTrendSymbol = (closes) => {
  if (!Array.isArray(closes) || closes.length < 15) return '🟰';
  const x = Array.from({ length: 15 }, (_, i) => i);
  const y = closes.slice(-15);
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const slope = (15 * sumXY - sumX * sumY) / (15 * sumX2 - sumX * sumX);
  return slope > 0.02 ? '⬆️' : slope < -0.02 ? '⬇️' : '🟰';
};

// Original MACD (kept for compatibility; we use calcMACDFull)
const calcMACD = (closes, short = 12, long = 26, signalPeriod = 9) => {
  if (!Array.isArray(closes) || closes.length < long + signalPeriod) {
    return { macd: null, signal: null };
  }
  const kShort = 2 / (short + 1);
  const kLong = 2 / (long + 1);
  const kSig = 2 / (signalPeriod + 1);
  let emaShort = closes[0];
  let emaLong = closes[0];
  const macdLine = [];
  closes.forEach((price) => {
    emaShort = price * kShort + emaShort * (1 - kShort);
    emaLong = price * kLong + emaLong * (1 - kLong);
    macdLine.push(emaShort - emaLong);
  });
  let signal = macdLine[0];
  for (let i = 1; i < macdLine.length; i++) {
    signal = macdLine[i] * kSig + signal * (1 - kSig);
  }
  return { macd: macdLine[macdLine.length - 1], signal };
};

// RSI score + composite
const rsiContextScore = (rsi) => {
  if (rsi == null) return 50;
  if (rsi < 25 || rsi > 80) return 20;
  if (rsi >= 45 && rsi <= 60) return 100;
  if (rsi >= 35 && rsi <= 70) return 70;
  return 50;
};

const compositeScore = ({ macdSlope, trendOK, rsiVal }, w) => {
  const parts = {
    macdSlope: macdSlope ? 100 : 0,
    trendAlign: trendOK ? 100 : 0,
    rsiCtx: rsiContextScore(rsiVal),
  };
  const num = parts.macdSlope * w.macdSlope + parts.trendAlign * w.trendAlign + parts.rsiCtx * w.rsiCtx;
  const den = w.macdSlope + w.trendAlign + w.rsiCtx;
  return (num / den); // 0..100
};

// ============== Trade/Exit Helpers & State ==============
const tradeState = {}; // { [symbol]: { entry, atrAtEntry, peak, stop, tp, lastLimitPostTs } }

const getPositionInfo = async (symbol) => {
  try {
    const res = await fetch(`${ALPACA_BASE_URL}/positions/${symbol}`, { headers: HEADERS });
    if (!res.ok) return null;
    const info = await res.json();
    const qty = parseFloat(info.qty);
    const basis = parseFloat(info.avg_entry_price);
    const available = parseFloat(info.qty_available ?? info.available ?? info.qty);
    if (isNaN(available) || available <= 0) return null;

    const marketValue = parseFloat(info.market_value ?? 'NaN');
    const markFromMV = Number.isFinite(marketValue) && qty > 0 ? marketValue / qty : NaN;
    const markFallback = parseFloat(info.current_price ?? info.asset_current_price ?? 'NaN');
    const mark = Number.isFinite(markFromMV) ? markFromMV : (Number.isFinite(markFallback) ? markFallback : NaN);

    return {
      qty: parseFloat(Number(qty).toFixed(6)),
      basis,
      available,
      mark,
    };
  } catch (err) {
    console.error('getPositionInfo error:', err);
    return null;
  }
};

const getOpenOrders = async (symbol) => {
  try {
    const res = await fetch(
      `${ALPACA_BASE_URL}/orders?status=open&symbols=${symbol}`,
      { headers: HEADERS }
    );
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`getOpenOrders failed ${res.status}:`, txt);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('getOpenOrders error:', err);
    return [];
  }
};

const cancelOpenOrders = async (symbol) => {
  try {
    const open = await getOpenOrders(symbol);
    await Promise.all(
      open.map((o) =>
        fetch(`${ALPACA_BASE_URL}/orders/${o.id}`, { method: 'DELETE', headers: HEADERS }).catch(() => null)
      )
    );
    logTradeAction('cancel_open_orders', symbol, { count: open.length });
  } catch (e) {
    console.warn('cancelOpenOrders err', e.message);
  }
};

const placeMarketSellAll = async (symbol) => {
  const pos = await getPositionInfo(symbol);
  if (!pos) return;
  const order = { symbol, qty: pos.available, side: 'sell', type: 'market', time_in_force: CRYPTO_TIME_IN_FORCE };
  try {
    await cancelOpenOrders(symbol);
    const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify(order),
    });
    const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
    if (res.ok && data.id) logTradeAction('stop_market_sell_success', symbol, { id: data.id, qty: pos.available });
    else logTradeAction('stop_market_sell_failed', symbol, { status: res.status, raw: data });
  } catch (e) {
    logTradeAction('stop_market_sell_error', symbol, { error: e.message });
  }
};

const ensureLimitTP = async (symbol, limitPrice) => {
  const pos = await getPositionInfo(symbol);
  if (!pos) return;
  const open = await getOpenOrders(symbol);
  const existing = open.find((o) => o.side === 'sell' && o.type === 'limit');
  const now = Date.now();
  const lastTs = tradeState[symbol]?.lastLimitPostTs || 0;

  const needsPost =
    !existing ||
    Math.abs(parseFloat(existing.limit_price) - limitPrice) / limitPrice > 0.001 || // >0.1% drift
    now - lastTs > CFG.exits.limitReplaceSecs * 1000;

  if (!needsPost) return;

  try {
    if (existing) await cancelOpenOrders(symbol);
    const order = {
      symbol, qty: pos.available, side: 'sell', type: 'limit',
      time_in_force: CRYPTO_TIME_IN_FORCE, limit_price: limitPrice.toFixed(5),
    };
    const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify(order),
    });
    const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
    if (res.ok && data.id) {
      tradeState[symbol] = { ...(tradeState[symbol] || {}), lastLimitPostTs: now };
      logTradeAction('tp_limit_set', symbol, { id: data.id, limit: order.limit_price });
    } else {
      logTradeAction('tp_limit_failed', symbol, { status: res.status, raw: data });
    }
  } catch (e) {
    logTradeAction('tp_limit_error', symbol, { error: e.message });
  }
};

// ==================== UI COMPONENT ====================
export default function App() {
  const [tracked] = useState(ORIGINAL_TOKENS);
  const [data, setData] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const autoTrade = true; // always enabled
  const [hideOthers, setHideOthers] = useState(false);
  const [notification, setNotification] = useState(null);
  const [logHistory, setLogHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [acctSummary, setAcctSummary] = useState({
    portfolioValue: null,
    dailyChangeUsd: null,
    dailyChangePct: null,
  });

  const intervalRef = useRef(null);
  const exitIntervalRef = useRef(null);

  // Subscribe to log events and keep only the most recent five entries
  useEffect(() => {
    registerLogSubscriber((entry) => {
      setLogHistory((prev) => [entry, ...prev].slice(0, 5));
    });
  }, []);

  // Helper to update the toast notification.
  const showNotification = (message) => {
    setNotification(message);
    setTimeout(() => setNotification(null), 5000);
  };

  // ===== Account summary (Portfolio Value + Daily % Change) =====
  const getAccountSummary = async () => {
    try {
      const res = await fetch(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
      if (!res.ok) throw new Error(`Account ${res.status}`);
      const a = await res.json();

      const equity = parseFloat(a.equity ?? a.portfolio_value ?? 'NaN');
      const prior = parseFloat(a.last_equity ?? 'NaN');
      const priorFallback = parseFloat(a.equity_previous_close ?? 'NaN');
      const ref = Number.isFinite(prior) ? prior :
                  (Number.isFinite(priorFallback) ? priorFallback : NaN);

      let changeUsd = Number.isFinite(equity) && Number.isFinite(ref) ? (equity - ref) : NaN;
      let changePct = Number.isFinite(changeUsd) && ref > 0 ? (changeUsd / ref) * 100 : NaN;

      setAcctSummary({
        portfolioValue: Number.isFinite(equity) ? equity : null,
        dailyChangeUsd: Number.isFinite(changeUsd) ? changeUsd : null,
        dailyChangePct: Number.isFinite(changePct) ? changePct : null,
      });
    } catch (err) {
      console.warn('getAccountSummary error:', err.message);
      setAcctSummary({ portfolioValue: null, dailyChangeUsd: null, dailyChangePct: null });
    }
  };
  // ===============================================================

  const getPriceUSD = async (ccOrSymbol) => {
    const r = await fetch(`https://min-api.cryptocompare.com/data/price?fsym=${ccOrSymbol}&tsyms=USD`);
    const j = await r.json();
    return parseFloat(j?.USD ?? 'NaN');
  };

  const getBars15m = async (ccOrSymbol, limit = 220) => {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${ccOrSymbol}&tsym=USD&limit=${limit}&aggregate=15`
    );
    const j = await res.json();
    const arr = Array.isArray(j?.Data?.Data) ? j.Data.Data : [];
    // Normalize: { open, high, low, close }
    return arr.map(b => ({ open: b.open, high: b.high, low: b.low, close: b.close }));
  };

  const placeOrder = async (symbol, ccSymbol = symbol, isManual = false) => {
    const openOrders = await getOpenOrders(symbol);
    if (openOrders.length > 0) {
      logTradeAction('skip_open_orders', symbol, { openOrders });
      return;
    }

    const held = await getPositionInfo(symbol);
    if (held && held.available * held.basis > 1) {
      logTradeAction('skip_held_position', symbol, { held });
      showNotification(`💼 Held: ${symbol} x${held.qty} @ $${held.basis}`);
      return;
    }

    logTradeAction('buy_attempt', symbol, { isManual });

    try {
      const price = await getPriceUSD(ccSymbol);
      if (!Number.isFinite(price)) throw new Error('Invalid price data');

      const accountRes = await fetch(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
      const accountData = await accountRes.json();

      const equity = parseFloat(accountData.portfolio_value ?? accountData.equity ?? '0');
      const nonMarginBP = parseFloat(accountData.non_marginable_buying_power ?? 'NaN');
      const buyingPower = parseFloat(accountData.buying_power ?? '0');
      const cash = parseFloat(accountData.cash || 0);

      // ATR for sizing
      const bars = await getBars15m(ccSymbol, 120);
      const atr = calcATR(bars, CFG.risk.atrLen);
      if (!atr || !isFinite(atr) || atr <= 0) {
        logTradeAction('skip_small_order', symbol, { reason: 'ATR unavailable for sizing' });
        return;
      }

      // Risk-based sizing
      const riskUSD = (CFG.risk.riskPerTradePctEquity / 100) * equity;
      const stopDist = CFG.risk.atrKStop * atr;
      const qty = Math.max(0, riskUSD / stopDist);
      let notional = qty * price;

      // Caps
      const capNotionalByMaxEquity = (CFG.risk.maxPosPctEquity / 100) * equity;
      const bp = CFG.risk.useNonMarginableBP && Number.isFinite(nonMarginBP) ? nonMarginBP : buyingPower;
      const cap = Math.max(0, Math.min(capNotionalByMaxEquity, bp, cash));
      notional = Math.min(notional, cap);

      if (!isFinite(notional) || notional < CFG.risk.minNotionalUSD) {
        logTradeAction('skip_small_order', symbol, { reason: 'below min notional', notional });
        return;
      }

      notional = Math.floor(notional * 100) / 100; // cents

      const order = {
        symbol,
        notional,
        side: 'buy',
        type: 'market',
        time_in_force: CRYPTO_TIME_IN_FORCE,
      };

      const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(order),
      });

      const raw = await res.text();
      let result;
      try { result = JSON.parse(raw); } catch { result = { raw }; }

      if (res.ok && result.id) {
        logTradeAction('buy_success', symbol, { id: result.id, notional });
        showNotification(`✅ Bought ${symbol} $${notional}`);

        // seed trade state
        tradeState[symbol] = {
          ...(tradeState[symbol] || {}),
          entry: price,
          atrAtEntry: atr,
          peak: price,
          stop: price - CFG.risk.atrKStop * atr,
          tp:  price + CFG.exits.tpKatr * atr,
          lastLimitPostTs: 0,
        };

        // place/refresh the TP limit immediately
        ensureLimitTP(symbol, tradeState[symbol].tp);

      } else {
        logTradeAction('buy_failed', symbol, { status: res.status, reason: result.message || raw });
        showNotification(`❌ Buy Failed ${symbol}: ${result.message || raw}`);
      }
    } catch (err) {
      logTradeAction('buy_error', symbol, { error: err.message });
      showNotification(`❌ Buy Error ${symbol}: ${err.message}`);
    }
  };

  // Refresh all token data + account summary
  const loadData = async () => {
    if (isLoading) return;
    setIsLoading(true);

    await getAccountSummary();

    logTradeAction('refresh', 'all');
    perSymbolFundsLock = {};
    const results = [];

    for (const asset of tracked) {
      const token = {
        ...asset,
        price: null,
        rsi: null,
        macd: null,
        signal: null,
        signalDiff: null,
        trend: '🟰',
        entryReady: false,
        watchlist: false,
        missingData: false,
        error: null,
        time: new Date().toLocaleTimeString(),
      };
      try {
        const [price, bars] = await Promise.all([
          getPriceUSD(asset.cc || asset.symbol),
          getBars15m(asset.cc || asset.symbol, 220), // more bars for EMA200/ATR
        ]);
        if (Number.isFinite(price)) token.price = price;

        const closes = bars.map(b => b.close).filter((c) => typeof c === 'number');

        if (closes.length >= 30) {
          const r = calcRSI(closes, CFG.rsi.length);
          token.rsi = r != null ? r.toFixed(1) : null;

          const macdFull = calcMACDFull(closes, CFG.macd.fast, CFG.macd.slow, CFG.macd.signal);
          if (macdFull) {
            token.macd = macdFull.macd;
            token.signal = macdFull.signal;
            token.signalDiff = token.macd - token.signal;
          }

          const sigma = logRetSigma(closes, CFG.vol.lookbackBars);
          const z = zScore(closes, CFG.z.lookbackBars);
          const slopeOK = macdFull ? macdHistSlopeIncreasing(macdFull.histArr, CFG.macd.minHistSlopeBars) : false;
          const trendOK = CFG.trend.requireUp ? emaTrendOK(closes, CFG.trend.emaFast, CFG.trend.emaSlow) : true;

          const score = compositeScore({ macdSlope: slopeOK, trendOK, rsiVal: r }, CFG.weights);
          const macdCrossUp = macdFull && macdFull.macd != null && macdFull.signal != null && macdFull.macd > macdFull.signal;

          token.trend = getTrendSymbol(closes);

          // diagnostics (optional UI)
          token._score = Math.round(score);
          token._sigma = sigma;
          token._z = z;
          token._slopeOK = slopeOK;
          token._trendOK = trendOK;

          // ================== LOOSER ENTRY LOGIC (N-of-4 + edge guard) ==================
          const volOK = sigma >= CFG.vol.minSigma;
          const zOK = Math.abs(z) >= CFG.z.minAbsZ;

          // Edge guard: ensure TP (in bps) isn't smaller than costs proxy
          const atrNow = calcATR(bars, CFG.risk.atrLen);
          const tpEdgeBps = atrNow && token.price
            ? (CFG.exits.tpKatr * atrNow / token.price) * 10000
            : 0;
          const edgeOK = (CFG.risk.minEdgeBps ?? 0) === 0 || tpEdgeBps >= CFG.risk.minEdgeBps;

          // N-of-4 gate: slopeOK, volOK, zOK, trendOK (trendOK already respects requireUp)
          const passCount = [slopeOK, volOK, zOK, trendOK].filter(Boolean).length;
          const need = CFG.gating?.minPassCount ?? 3;

          token.entryReady = macdCrossUp && score >= CFG.minScore && passCount >= need && edgeOK;

          // Watchlist = MACD crossed up and at least one gate passes (for visibility)
          token.watchlist = !token.entryReady && macdCrossUp && passCount >= 1;
          // ==============================================================================

        }

        token.missingData = token.price == null || closes.length < 30;

        // Position exits are managed by the trailing loop; nothing to do here.

        if (autoTrade && token.entryReady) {
          logTradeAction('entry_ready_confirmed', asset.symbol, { score: token._score });
          await placeOrder(asset.symbol, asset.cc);
        } else {
          logTradeAction('entry_skipped', asset.symbol, { entryReady: token.entryReady });
        }
      } catch (err) {
        console.error(`Failed to load ${asset.symbol}:`, err);
        token.error = err.message;
        token.missingData = true;
        showNotification('⚠️ Load Failed: ' + asset.symbol);
      }
      results.push(token);
    }

    setData(results);
    setRefreshing(false);
    setIsLoading(false);
  };

  // Strategy scan loop (60s)
  useEffect(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    intervalRef.current = setInterval(loadData, 60000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  // Exit manager loop (TP refresh + trailing stop + break-even)
  useEffect(() => {
    if (exitIntervalRef.current) { clearInterval(exitIntervalRef.current); exitIntervalRef.current = null; }
    exitIntervalRef.current = setInterval(async () => {
      for (const asset of tracked) {
        const symbol = asset.symbol;
        const pos = await getPositionInfo(symbol);
        if (!pos) continue;

        // fetch fresh mark & bars
        try {
          const [mark, bars] = await Promise.all([
            getPriceUSD(asset.cc || asset.symbol),
            getBars15m(asset.cc || asset.symbol, 60),
          ]);
          const atrNow = calcATR(bars, CFG.risk.atrLen) || tradeState[symbol]?.atrAtEntry;

          if (!Number.isFinite(mark) || !Number.isFinite(atrNow)) continue;

          if (!tradeState[symbol]?.entry) {
            const entryBasis = pos.basis || mark;
            tradeState[symbol] = {
              entry: entryBasis,
              atrAtEntry: atrNow,
              peak: mark,
              stop: entryBasis - CFG.risk.atrKStop * atrNow,
              tp: entryBasis + CFG.exits.tpKatr * atrNow,
              lastLimitPostTs: 0,
            };
          }

          const s = tradeState[symbol];
          s.peak = Math.max(s.peak, mark);

          // move to break-even after enough run-up
          if ((mark - s.entry) >= CFG.exits.breakevenAfterKatr * atrNow) {
            s.stop = Math.max(s.stop, s.entry);
          }

          // trailing stop after break-even
          const trailStop = Math.max(s.entry, s.peak - CFG.exits.trailKatr * atrNow);
          s.stop = Math.max(s.stop, trailStop);

          // refresh TP limit
          ensureLimitTP(symbol, s.tp);

          // stop breach => market exit
          if (mark <= s.stop) {
            logTradeAction('stop_hit', symbol, { mark, stop: s.stop });
            await placeMarketSellAll(symbol);
            delete tradeState[symbol];
          }
        } catch (e) {
          console.warn('exit loop error', symbol, e.message);
        }
      }
    }, CFG.exits.markRefreshSecs * 1000);

    return () => { if (exitIntervalRef.current) clearInterval(exitIntervalRef.current); };
  }, [tracked]);

  // Kick off a data load on mount + verify connection
  useEffect(() => {
    (async () => {
      await getAccountSummary();
      try {
        const res = await fetch(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
        const account = await res.json();
        console.log('[ALPACA CONNECTED]', account.account_number, 'Equity:', account.equity);
        showNotification('✅ Connected to Alpaca');
      } catch (err) {
        console.error('[ALPACA CONNECTION FAILED]', err);
        showNotification('❌ Alpaca API Error');
      }
    })();
    loadData();
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const renderCard = (asset) => {
    const borderColor = asset.entryReady ? 'green' : asset.watchlist ? '#FFA500' : 'red';
    const cardStyle = [
      styles.card,
      { borderLeftColor: borderColor },
      asset.watchlist && !asset.entryReady && styles.cardWatchlist,
    ];
    return (
      <View key={asset.symbol} style={cardStyle}>
        <Text style={styles.symbol}>
          {asset.name} ({asset.symbol})
        </Text>
        {asset.entryReady && <Text style={styles.entryReady}>✅ ENTRY READY</Text>}
        {asset.watchlist && !asset.entryReady && <Text style={styles.watchlist}>🟧 WATCHLIST</Text>}
        {asset.price != null && <Text>Price: ${asset.price}</Text>}
        {asset.rsi != null && <Text>RSI: {asset.rsi}</Text>}
        <Text>Trend: {asset.trend}</Text>
        {asset._score != null && (
          <Text style={{ fontSize: 12, color: '#444' }}>
            Score {asset._score} | σ {(asset._sigma||0).toFixed(4)} | Z {(asset._z||0).toFixed(2)} | {asset._trendOK?'Trend✅':'Trend—'} | {asset._slopeOK?'Slope✅':'Slope—'}
          </Text>
        )}
        {asset.missingData && <Text style={styles.missing}>⚠️ Missing data</Text>}
        {asset.error && <Text style={styles.error}>❌ Not tradable: {asset.error}</Text>}
        <Text>{asset.time}</Text>
        <TouchableOpacity onPress={() => placeOrder(asset.symbol, asset.cc, true)}>
          <Text style={styles.buyButton}>Manual BUY</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const bySignal = (a, b) => {
    const diffA = a.signalDiff ?? -Infinity;
    const diffB = b.signalDiff ?? -Infinity;
    if (diffA === diffB) return a.symbol.localeCompare(b.symbol);
    return diffB - diffA;
  };

  const entryReadyTokens = data.filter((t) => t.entryReady).sort(bySignal);
  const watchlistTokens = data.filter((t) => !t.entryReady && t.watchlist).sort(bySignal);
  const otherTokens = data.filter((t) => !t.entryReady && !t.watchlist).sort(bySignal);

  const pv = acctSummary.portfolioValue;
  const chUsd = acctSummary.dailyChangeUsd;
  const chPct = acctSummary.dailyChangePct;
  const changeColor = chPct == null ? '#666' : chPct >= 0 ? '#0a8f08' : '#c62828';

  return (
    <ScrollView
      contentContainerStyle={[styles.container, darkMode && styles.containerDark]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.row}>
        <Switch value={darkMode} onValueChange={setDarkMode} />
        <Text style={[styles.title, darkMode && styles.titleDark]}>🎭 Bullish or Bust!</Text>
      </View>

      {/* === Portfolio header (value + daily change) === */}
      <View style={[styles.portfolioCard, darkMode && styles.portfolioCardDark]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={[styles.portfolioLabel, darkMode && styles.titleDark]}>Your Portfolio</Text>
          <Text style={[styles.periodPill, darkMode && styles.periodPillDark]}>1D</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 6 }}>
          <Text style={[styles.portfolioValue, darkMode && styles.titleDark]}>
            {pv == null ? '—' : `$ ${pv.toFixed(2)}`}
          </Text>
          <Text style={[styles.portfolioChangePct, { color: changeColor }]}>
            {chPct == null ? '' : `  ${chPct.toFixed(2)}%`}
          </Text>
        </View>
        {chUsd != null && (
          <Text style={[styles.portfolioChangeUsd, darkMode && styles.titleDark]}>
            Daily Change {chUsd >= 0 ? '+' : ''}${Math.abs(chUsd).toFixed(2)}
          </Text>
        )}
      </View>
      {/* ============================================== */}

      <View style={styles.row}>
        <Text style={[styles.title, darkMode && styles.titleDark]}>Hide Others</Text>
        <Switch value={hideOthers} onValueChange={setHideOthers} />
      </View>

      <Text style={styles.sectionHeader}>✅ Entry Ready</Text>
      {entryReadyTokens.length > 0 ? (
        <View style={styles.cardGrid}>{entryReadyTokens.map(renderCard)}</View>
      ) : (
        <Text style={styles.noData}>No Entry Ready tokens</Text>
      )}

      <Text style={styles.sectionHeader}>🟧 Watchlist</Text>
      {watchlistTokens.length > 0 ? (
        <View style={styles.cardGrid}>{watchlistTokens.map(renderCard)}</View>
      ) : (
        <Text style={styles.noData}>No Watchlist tokens</Text>
      )}

      {!hideOthers && (
        <>
          <Text style={styles.sectionHeader}>❌ Others</Text>
          {otherTokens.length > 0 ? (
            <View style={styles.cardGrid}>{otherTokens.map(renderCard)}</View>
          ) : (
            <Text style={styles.noData}>No other tokens</Text>
          )}
        </>
      )}

      {logHistory.length > 0 && (
        <View style={styles.logPanel}>
          {logHistory.map((log, idx) => (
            <Text key={idx} style={styles.logText}>
              {`${log.timestamp.split('T')[1].slice(0,8)} ${log.type} ${log.symbol}`}
            </Text>
          ))}
        </View>
      )}
      {notification && (
        <View
          style={{
            position: 'absolute',
            bottom: 40,
            left: 20,
            right: 20,
            padding: 12,
            backgroundColor: '#333',
            borderRadius: 8,
            zIndex: 999,
          }}
        >
          <Text style={{ color: '#fff', textAlign: 'center' }}>{notification}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, paddingTop: 40, paddingHorizontal: 10, backgroundColor: '#fff' },
  containerDark: { backgroundColor: '#121212' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  title: { fontSize: 18, fontWeight: 'bold', color: '#000' },
  titleDark: { color: '#fff' },

  // Portfolio header styles
  portfolioCard: {
    backgroundColor: '#f7f7f7',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  portfolioCardDark: { backgroundColor: '#1e1e1e' },
  portfolioLabel: { fontSize: 14, fontWeight: '600', color: '#333' },
  periodPill: {
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: '#e6e6e6',
    overflow: 'hidden',
    color: '#333',
  },
  periodPillDark: { backgroundColor: '#2a2a2a', color: '#fff' },
  portfolioValue: { fontSize: 28, fontWeight: '800', color: '#000' },
  portfolioChangePct: { fontSize: 18, fontWeight: '700', marginLeft: 6 },
  portfolioChangeUsd: { marginTop: 4, color: '#666' },

  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  card: {
    width: '48%',
    backgroundColor: '#f0f0f0',
    padding: 10,
    borderRadius: 6,
    borderLeftWidth: 5,
    marginBottom: 10,
  },
  cardWatchlist: {
    borderColor: '#FFA500',
    borderWidth: 2,
  },
  symbol: { fontSize: 15, fontWeight: 'bold', color: '#005eff' },
  error: { color: 'red', fontSize: 12 },
  buyButton: { color: '#0066cc', marginTop: 8, fontWeight: 'bold' },
  noData: { textAlign: 'center', marginTop: 20, fontStyle: 'italic', color: '#777' },
  entryReady: { color: 'green', fontWeight: 'bold' },
  watchlist: { color: '#FFA500', fontWeight: 'bold' },
  waiting: { alignItems: 'center', marginTop: 20 },
  sectionHeader: { fontSize: 16, fontWeight: 'bold', marginBottom: 5, marginTop: 10 },
  missing: { color: 'red', fontStyle: 'italic' },
  logPanel: {
    position: 'absolute',
    bottom: 90,
    left: 20,
    right: 20,
    backgroundColor: '#222',
    padding: 8,
    borderRadius: 8,
    zIndex: 998,
  },
  logText: { color: '#fff', fontSize: 12 },
});
