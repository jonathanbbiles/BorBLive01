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
* This component implements a simple crypto trading dashboard for Alpaca.  It
* tracks a predefined list of crypto pairs, calculates a handful of
* technical indicators (RSI, MACD and a simple linear‐regression trend
* indicator) from minute data provided by CryptoCompare and then exposes
* manual and automatic trade actions against the Alpaca paper trading API.
*
* Key improvements over the original implementation:
*  - All network interactions are wrapped in try/catch blocks and return
*    sensible defaults on failure to ensure the UI never crashes because
*    of a bad response.
*  - A small concurrency guard prevents multiple overlapping refreshes
*    from running at the same time.  This is important because the
*    component refreshes itself on a timer when auto trading is enabled.
*  - We added a helper to check for open orders on a symbol before
*    attempting to place a new trade.  Without this guard duplicate buy
*    orders could be fired off if an earlier order was still pending.
*  - The refresh interval is stored in a ref and cleaned up properly when
*    the component unmounts or when auto trading is toggled off.
*  - A handful of comments have been sprinkled throughout the code to
*    explain why certain decisions were made.  Feel free to remove them
*    for production use.
*/

// API credentials are expected to be provided via environment variables.
// If they are missing the app will still run but trading requests will fail.
// For temporary testing we hardcode the credentials. Remove before committing
// to production.
const ALPACA_KEY = 'AKS3TBCTY4CFZ2LBK2GZ';
const ALPACA_SECRET = 'fX1QUAM5x8FGeGcEneIrgTCQXRSwcZnoaxHC6QXM';
const ALPACA_BASE_URL = 'https://api.alpaca.markets/v2'; // live

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json',
};

// Buffer the sell price to offset taker fees while keeping the profit target
const FEE_BUFFER = 0.0025; // 0.25% taker fee
const TARGET_PROFIT = 0.0005; // 0.05% desired profit
const TOTAL_MARKUP = FEE_BUFFER + TARGET_PROFIT;

// Crypto orders require GTC time in force
const CRYPTO_TIME_IN_FORCE = 'gtc';

// Track tokens that ran out of funds this cycle
let perSymbolFundsLock = {};

// Allow components to subscribe to log entries so they can display them
let logSubscriber = null;
export const registerLogSubscriber = (fn) => {
  logSubscriber = fn;
};

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

export default function App() {
  const [tracked] = useState(ORIGINAL_TOKENS);
  const [data, setData] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  // Auto trading is always enabled
  const autoTrade = true;
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

      // Use equity as current portfolio value (for crypto it reflects live equity).
      const equity = parseFloat(a.equity ?? a.portfolio_value ?? 'NaN');
      // Prior-day reference: try last_equity first, then equity_previous_close.
      const prior =
        parseFloat(a.last_equity ?? 'NaN');
      const priorFallback =
        parseFloat(a.equity_previous_close ?? 'NaN');
      const ref = Number.isFinite(prior) ? prior :
                  (Number.isFinite(priorFallback) ? priorFallback : NaN);

      let changeUsd = Number.isFinite(equity) && Number.isFinite(ref) ? (equity - ref) : NaN;
      let changePct = Number.isFinite(changeUsd) && ref > 0 ? (changeUsd / ref) * 100 : NaN;

      setAcctSummary({
        portfolioValue: Number.isFinite(equity) ? equity : null,
        dailyChangeUsd: Number.isFinite(changeUsd) ? changeUsd : null,
        dailyChangePct: Number.isFinite(changePct) ? changePct : null,
      });

      console.log('[ACCOUNT]', {
        equity,
        last_equity: a.last_equity,
        equity_previous_close: a.equity_previous_close,
        changeUsd,
        changePct,
      });
    } catch (err) {
      console.warn('getAccountSummary error:', err.message);
      setAcctSummary({ portfolioValue: null, dailyChangeUsd: null, dailyChangePct: null });
    }
  };
  // ===============================================================

  // Basic RSI
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

  // Trend via linear regression slope
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

  // MACD
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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const getPositionInfo = async (symbol) => {
    try {
      const res = await fetch(`${ALPACA_BASE_URL}/positions/${symbol}`, {
        headers: HEADERS,
      });
      if (!res.ok) return null;
      const info = await res.json();
      const qty = parseFloat(info.qty);
      const basis = parseFloat(info.avg_entry_price);
      const available = parseFloat(
        info.qty_available ?? info.available ?? info.qty
      );
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

  const placeLimitSell = async (symbol) => {
    const position = await getPositionInfo(symbol);
    if (!position) {
      logTradeAction('sell_skip_reason', symbol, { reason: 'no position held' });
      console.log(`[SELL SKIPPED] No position held for ${symbol}`);
      return;
    }

    const qty = parseFloat(position.available);
    const basis = parseFloat(position.basis);
    if (!qty || qty <= 0 || !basis || basis <= 0) {
      logTradeAction('sell_skip_reason', symbol, {
        reason: 'invalid qty or basis',
        availableQty: qty,
        basisPrice: basis,
      });
      console.log(`[SELL SKIPPED] Invalid qty or basis for ${symbol}: qty=${qty}, basis=${basis}`);
      return;
    }
    logTradeAction('sell_qty_confirm', symbol, { qtyRequested: qty, qtyAvailable: position.available });
    console.log(`[SELL QTY CONFIRM] ${symbol} available=${position.available} qty=${qty}`);

    const notional = qty * basis;
    if (notional < 1) {
      logTradeAction('sell_skip', symbol, {
        availableQty: qty, basisPrice: basis, notionalValue: notional, reason: 'notional below $1',
      });
      logTradeAction('sell_skip_reason', symbol, { reason: 'notional below $1', availableQty: qty, basisPrice: basis, notionalValue: notional });
      console.log(`[SELL SKIPPED] ${symbol} notional $${notional.toFixed(2)} below $1`);
      showNotification(`❌ Skip ${symbol}: $${notional.toFixed(2)} < $1`);
      return;
    }

    const liveMark = parseFloat(position.mark);
    const ref = Math.max(basis, Number.isFinite(liveMark) ? liveMark : 0);
    const limit_price = (ref * (1 + TOTAL_MARKUP)).toFixed(5);

    const limitSell = {
      symbol,
      qty,
      side: 'sell',
      type: 'limit',
      time_in_force: CRYPTO_TIME_IN_FORCE,
      limit_price,
    };

    logTradeAction('sell_attempt', symbol, { qty, basis, limit_price });
    showNotification(`📤 Sell: ${symbol} @ $${limit_price} x${qty}`);

    try {
      const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(limitSell),
      });

      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { raw }; }

      if (res.ok && data.id) {
        logTradeAction('sell_success', symbol, { orderId: data.id, qty });
        showNotification(`✅ Sell Placed: ${symbol} @ $${limit_price}`);
        console.log(`[SELL SUCCESS] ${symbol}`, data);
      } else {
        const msg = data?.message || JSON.stringify(data);
        logTradeAction('sell_failed', symbol, { status: res.status, reason: msg });
        console.warn(`[SELL FAILED] ${symbol}:`, msg);
        showNotification(`❌ Sell Failed: ${symbol} - ${msg}`);
      }
    } catch (err) {
      logTradeAction('sell_error', symbol, { error: err.message });
      console.error(`[SELL EXCEPTION] ${symbol}:`, err.message);
      showNotification(`❌ Sell Error: ${symbol} - ${err.message}`);
    }
  };

  const placeOrder = async (symbol, ccSymbol = symbol, isManual = false) => {
    const openOrders = await getOpenOrders(symbol);
    if (openOrders.length > 0) {
      logTradeAction('skip_open_orders', symbol, { openOrders });
      console.log(`🔁 Skipping ${symbol} - already has open orders`);
      return;
    }

    const held = await getPositionInfo(symbol);
    if (held && held.available * held.basis > 1) {
      logTradeAction('skip_held_position', symbol, { held });
      showNotification(`💼 Held: ${symbol} x${held.qty} @ $${held.basis}`);
      console.log(`💼 Skipping ${symbol} - position already held`);
      logTradeAction('buy_attempt_skipped', symbol, { reason: 'position already held', held });
      return;
    }

    logTradeAction('buy_attempt', symbol, { isManual });

    try {
      const priceRes = await fetch(
        `https://min-api.cryptocompare.com/data/price?fsym=${ccSymbol}&tsyms=USD`
      );
      const priceData = await priceRes.json();
      const price = priceData.USD;
      if (!price || isNaN(price)) throw new Error('Invalid price data');

      const accountRes = await fetch(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
      const accountData = await accountRes.json();
      const cash = parseFloat(accountData.cash || 0);
      const cashWithdrawable = parseFloat(accountData.buying_power || 0);
      const portfolioValue = parseFloat(accountData.portfolio_value ?? accountData.equity ?? '0');

      logTradeAction('cash_available', symbol, { cash, cash_withdrawable: cashWithdrawable });

      const SAFETY_MARGIN = 1;
      const SAFETY_FACTOR = 0.99;

      const targetAllocation = portfolioValue * 0.1;

      let allocation = Math.min(
        targetAllocation,
        cash - SAFETY_MARGIN,
        cashWithdrawable - SAFETY_MARGIN
      );

      allocation *= SAFETY_FACTOR;

      if (allocation > cash) allocation = Math.floor(cash * 100) / 100;
      if (allocation > cashWithdrawable) allocation = Math.floor(cashWithdrawable * 100) / 100;

      if (allocation <= 0) {
        logTradeAction('allocation_skipped', symbol, {
          reason: 'safety margin exceeded available cash',
          cash,
          targetAllocation,
          allocation,
        });
        return;
      }

      const rawAllocation = allocation;
      let notional = Math.floor(allocation * 100) / 100;

      logTradeAction('allocation_check', symbol, {
        cash,
        targetAllocation,
        rawAllocation,
        finalNotional: notional,
        safetyMargin: SAFETY_MARGIN,
        safetyFactor: SAFETY_FACTOR,
      });

      logTradeAction('notional_final', symbol, { notional });

      if (notional < 1) {
        logTradeAction('skip_small_order', symbol, {
          reason: 'insufficient cash',
          targetAllocation,
          allocation: rawAllocation,
          cash,
        });
        return;
      }

      if (notional > cash) notional = Math.floor(cash * 100) / 100;
      if (notional > cashWithdrawable) notional = Math.floor(cashWithdrawable * 100) / 100;

      if (notional < 1) {
        logTradeAction('skip_small_order', symbol, {
          reason: 'notional below alpaca minimum after adjustment',
          notional,
          cash,
        });
        return;
      }

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
        setTimeout(() => placeLimitSell(symbol), 5000);
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

    // Update portfolio/changes at the start of every cycle
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
        const [priceRes, histoRes] = await Promise.all([
          fetch(
            `https://min-api.cryptocompare.com/data/price?fsym=${asset.cc || asset.symbol}&tsyms=USD`
          ),
          fetch(
            `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${asset.cc || asset.symbol}&tsym=USD&limit=52&aggregate=15`
          ),
        ]);
        const priceData = await priceRes.json();
        if (typeof priceData.USD === 'number') token.price = priceData.USD;

        const histoData = await histoRes.json();
        const histoBars = Array.isArray(histoData?.Data?.Data) ? histoData.Data.Data : [];
        const closes = histoBars.map((bar) => bar.close).filter((c) => typeof c === 'number');
        if (closes.length >= 20) {
          const r = calcRSI(closes);
          const macdRes = calcMACD(closes);
          token.rsi = r != null ? r.toFixed(1) : null;
          token.macd = macdRes.macd;
          token.signal = macdRes.signal;
          token.signalDiff = token.macd != null && token.signal != null ? token.macd - token.signal : null;
          const prev = calcMACD(closes.slice(0, -1));
          token.entryReady = token.macd != null && token.signal != null && token.macd > token.signal;
          token.watchlist =
            token.macd != null && token.signal != null && prev.macd != null &&
            token.macd > prev.macd && token.macd <= token.signal;
        }
        token.trend = getTrendSymbol(closes);
        token.missingData = token.price == null || closes.length < 20;

        const held = await getPositionInfo(asset.symbol);
        if (held) {
          await placeLimitSell(asset.symbol);
        }

        if (token.entryReady) {
          logTradeAction('entry_ready_confirmed', asset.symbol);
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

  // Start the refresh interval on mount.
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    intervalRef.current = setInterval(loadData, 60000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

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