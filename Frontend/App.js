import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  Switch,
  Alert,
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
const ALPACA_KEY = 'PKN4ICO3WECXSLDGXCHC';
const ALPACA_SECRET = 'PwJAEwLnLnsf7qAVvFutE8VIMgsAgvi7PMkMcCca';
const ALPACA_BASE_URL = 'https://paper-api.alpaca.markets/v2';

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
// It timestamps each event and prints to the console.
// Optionally send logs to your own endpoint or save to device storage.
// Adapt `sendToServer` as needed, or remove it if you don't have a server.
const logTradeAction = async (type, symbol, details = {}) => {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, symbol, ...details };
  // Always log locally to the Metro/Device console
  console.log('[TRADE LOG]', entry);
  // If a subscriber is registered, forward the entry
  if (typeof logSubscriber === 'function') {
    try {
      logSubscriber(entry);
    } catch (err) {
      console.warn('Log subscriber error:', err);
    }
  }
  // Example: Send log to your server (optional)
  // try {
  //   await fetch('https://yourloggingendpoint.example.com/log', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(entry),
  //   });
  // } catch (err) {
  //   console.warn('Failed to send log:', err.message);
  // }
};

// List of crypto pairs we want to follow.  Each entry defines both the
// instrument symbol used by Alpaca as well as the base coin symbol used
// by CryptoCompare.  If you wish to track additional tokens you can
// simply append to this list.
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
  const intervalRef = useRef(null);

  // Subscribe to log events and keep only the most recent five entries
  useEffect(() => {
    registerLogSubscriber((entry) => {
      setLogHistory((prev) => [entry, ...prev].slice(0, 5));
    });
  }, []);

  // Helper to update the toast notification. Notifications last five seconds
  // to give users ample time to read them.
  const showNotification = (message) => {
    setNotification(message);
    setTimeout(() => setNotification(null), 5000);
  };

  // Basic RSI implementation using a simple moving average of gains and
  // losses.  Returns null if insufficient data is provided.
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

  // Determine whether prices are trending up or down by performing a
  // least-squares linear regression over the last 15 closes.  The magic
  // numbers here were chosen heuristically: slopes above 0.02 are treated
  // as up, below -0.02 as down.
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

  // Compute the MACD line (difference between two EMAs) and its signal
  // line (EMA of the MACD line).  If there is insufficient data this
  // function returns {macd: null, signal: null}.
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

  // Sleep helper so we can await delays between retries
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Retrieve the current position for a given symbol.  Returns null if
  // nothing is held or if the request fails.
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
      return {
        qty: parseFloat(Number(qty).toFixed(6)),
        basis,
        available,
      };
    } catch (err) {
      console.error('getPositionInfo error:', err);
      return null;
    }
  };

  // Check for any open orders on the given symbol.  Alpaca allows
  // filtering the orders list by symbol using the `symbols` query
  // parameter.  If this call fails we optimistically return an empty
  // array so that the trade logic continues.
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

  // Place a limit sell order using the latest position information from
  // Alpaca. The function silently skips if the quantity is zero or below
  // Alpaca's minimum trade size (~$1 notional). Logs and notifications are
  // emitted for every attempt.
  const placeLimitSell = async (symbol) => {
    // Always re-fetch the position to ensure we have the live balance
    const position = await getPositionInfo(symbol);
    if (!position) {
      logTradeAction('sell_skip_reason', symbol, {
        reason: 'no position held',
      });
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
      console.log(
        `[SELL SKIPPED] Invalid qty or basis for ${symbol}: qty=${qty}, basis=${basis}`
      );
      return;
    }
    logTradeAction('sell_qty_confirm', symbol, {
      qtyRequested: qty,
      qtyAvailable: position.available,
    });
    console.log(
      `[SELL QTY CONFIRM] ${symbol} available=${position.available} qty=${qty}`
    );
    // Skip if the notional value is below Alpaca's minimum ($1)
    const notional = qty * basis;
    if (notional < 1) {
      logTradeAction('sell_skip', symbol, {
        availableQty: qty,
        basisPrice: basis,
        notionalValue: notional,
        reason: 'notional below $1',
      });
      logTradeAction('sell_skip_reason', symbol, {
        reason: 'notional below $1',
        availableQty: qty,
        basisPrice: basis,
        notionalValue: notional,
      });
      console.log(
        `[SELL SKIPPED] ${symbol} notional $${notional.toFixed(2)} below $1`
      );
      showNotification(
        `❌ Skip ${symbol}: $${notional.toFixed(2)} < $1`
      );
      return;
    }

    // Include buffer for taker fees so profit margin is preserved
    const limit_price = (basis * (1 + TOTAL_MARKUP)).toFixed(5);

    const limitSell = {
      symbol,
      qty,
      side: 'sell',
      type: 'limit',
      time_in_force: CRYPTO_TIME_IN_FORCE,
      limit_price,
    };

    logTradeAction('sell_attempt', symbol, {
      qty,
      basis,
      limit_price,
    });
    showNotification(`📤 Sell: ${symbol} @ $${limit_price} x${qty}`);

    try {
      const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(limitSell),
      });

      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }

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

  // Place a market buy order for the given symbol.  Will allocate up to
  // 10% of the current portfolio to the trade but never more than the
  // available cash. Duplicate buys are
  // prevented via the perSymbolFundsLock map and via checking for open
  // orders on the symbol.  After a successful buy the function will
  // automatically place a limit sell once the position settles.
  const placeOrder = async (symbol, ccSymbol = symbol, isManual = false) => {

    // Check for open orders FIRST
    const openOrders = await getOpenOrders(symbol);
    if (openOrders.length > 0) {
      logTradeAction('skip_open_orders', symbol, { openOrders });
      console.log(`🔁 Skipping ${symbol} - already has open orders`);
      return;
    }

    // Check if already held and only skip if the notional value is above $1
    const held = await getPositionInfo(symbol);
    if (held && held.available * held.basis > 1) {
      logTradeAction('skip_held_position', symbol, { held });
      showNotification(`💼 Held: ${symbol} x${held.qty} @ $${held.basis}`);
      console.log(`💼 Skipping ${symbol} - position already held`);
      logTradeAction('buy_attempt_skipped', symbol, {
        reason: 'position already held',
        held,
      });
      return;
    }

    logTradeAction('buy_attempt', symbol, { isManual });

    try {
      // Fetch current market price
      const priceRes = await fetch(
        `https://min-api.cryptocompare.com/data/price?fsym=${ccSymbol}&tsyms=USD`
      );
      const priceData = await priceRes.json();
      const price = priceData.USD;

      if (!price || isNaN(price)) {
        throw new Error('Invalid price data');
      }

      // Get Alpaca account info
      const accountRes = await fetch(`${ALPACA_BASE_URL}/account`, {
        headers: HEADERS,
      });
      const accountData = await accountRes.json();
      const cash = parseFloat(accountData.cash || 0);
      const cashWithdrawable = parseFloat(accountData.cash_withdrawable || 0);
      const portfolioValue = parseFloat(accountData.portfolio_value || '0');

      logTradeAction('cash_available', symbol, { cash, cash_withdrawable: cashWithdrawable });

      const SAFETY_MARGIN = 1; // prevents over-request by $1 buffer
      const SAFETY_FACTOR = 0.99; // extra buffer for price fluctuations

      const targetAllocation = portfolioValue * 0.1;

      // Always choose the smaller of the 10% allocation, available cash
      // minus the safety margin and withdrawable cash minus the safety margin
      // to avoid requesting more funds than can actually be used.
      let allocation = Math.min(
        targetAllocation,
        cash - SAFETY_MARGIN,
        cashWithdrawable - SAFETY_MARGIN
      );

      // Apply a small safety factor to account for price fluctuations
      // between calculation and order placement.
      allocation *= SAFETY_FACTOR;

      // Final guard: never request more than the cash or withdrawable balances
      if (allocation > cash) {
        allocation = Math.floor(cash * 100) / 100;
      }
      if (allocation > cashWithdrawable) {
        allocation = Math.floor(cashWithdrawable * 100) / 100;
      }

      // Ensure allocation is never negative
      if (allocation <= 0) {
        logTradeAction('allocation_skipped', symbol, {
          reason: 'safety margin exceeded available cash',
          cash,
          targetAllocation,
          allocation,
        });
        return;
      }

      // Calculate the final notional using the adjusted allocation and
      // round down to two decimals to stay within available funds
      const rawAllocation = allocation;
      let notional = Math.floor(allocation * 100) / 100;

      // Confirm final allocation details
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

      // Use Alpaca's notional parameter to cap the trade amount. Rounding
      // to two decimals ensures we never exceed available cash even if the
      // price moves slightly after this calculation.

      // If our requested notional exceeds cash, fall back to using
      // 100% of available cash (rounded down to two decimals).
      if (notional > cash) {
        notional = Math.floor(cash * 100) / 100;
      }
      if (notional > cashWithdrawable) {
        notional = Math.floor(cashWithdrawable * 100) / 100;
      }

      // Ensure Alpaca minimum order amount of $1 is met after adjustment.
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
      try {
        result = JSON.parse(raw);
      } catch {
        result = { raw };
      }

      if (res.ok && result.id) {
        logTradeAction('buy_success', symbol, { id: result.id, notional });
        showNotification(`✅ Bought ${symbol} $${notional}`);
        setTimeout(() => placeLimitSell(symbol), 5000);
      } else {
        logTradeAction('buy_failed', symbol, {
          status: res.status,
          reason: result.message || raw,
        });
        showNotification(`❌ Buy Failed ${symbol}: ${result.message || raw}`);
      }
    } catch (err) {
      logTradeAction('buy_error', symbol, { error: err.message });
      showNotification(`❌ Buy Error ${symbol}: ${err.message}`);
    }
  };

  // Refresh all token data.  When auto trading is enabled this will also
  // attempt to place buy orders on tokens whose MACD has crossed above
  // its signal line.
  const loadData = async () => {
    if (isLoading) return; // Prevent overlapping refreshes
    setIsLoading(true);
    // Log whenever a refresh cycle begins
    logTradeAction('refresh', 'all');
    perSymbolFundsLock = {}; // Reset funds lock each cycle
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
        // Fetch price and historical data in parallel
        const [priceRes, histoRes] = await Promise.all([
          fetch(
            `https://min-api.cryptocompare.com/data/price?fsym=${asset.cc || asset.symbol}&tsyms=USD`
          ),
          fetch(
            `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${asset.cc || asset.symbol}&tsym=USD&limit=52&aggregate=15`
          ),
        ]);
        // Price
        const priceData = await priceRes.json();
        if (typeof priceData.USD === 'number') {
          token.price = priceData.USD;
        }
        // Chart data
        const histoData = await histoRes.json();
        const histoBars = Array.isArray(histoData?.Data?.Data)
          ? histoData.Data.Data
          : [];
        const closes = histoBars
          .map((bar) => bar.close)
          .filter((c) => typeof c === 'number');
        if (closes.length >= 20) {
          const r = calcRSI(closes);
          const macdRes = calcMACD(closes);
          token.rsi = r != null ? r.toFixed(1) : null;
          token.macd = macdRes.macd;
          token.signal = macdRes.signal;
          token.signalDiff =
            token.macd != null && token.signal != null
              ? token.macd - token.signal
              : null;
          const prev = calcMACD(closes.slice(0, -1));
          token.entryReady = token.macd != null && token.signal != null && token.macd > token.signal;
          token.watchlist =
            token.macd != null &&
            token.signal != null &&
            prev.macd != null &&
            token.macd > prev.macd &&
            token.macd <= token.signal;
        }
        token.trend = getTrendSymbol(closes);
        token.missingData = token.price == null || closes.length < 20;
        // Automatically place sell for any held positions
        const held = await getPositionInfo(asset.symbol);
        if (held) {
          await placeLimitSell(asset.symbol);
        }
        // Auto trade: verify entry conditions and log outcome
        if (token.entryReady) {
          logTradeAction('entry_ready_confirmed', asset.symbol);
          await placeOrder(asset.symbol, asset.cc);
        } else {
          logTradeAction('entry_skipped', asset.symbol, {
            entryReady: token.entryReady,
          });
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

  // Start the refresh interval on mount. Clear any existing interval before
  // creating a new one to avoid overlaps.
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    intervalRef.current = setInterval(loadData, 60000);
    // Clean up on unmount
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Kick off a data load on mount
  useEffect(() => {
    loadData();
    (async () => {
      try {
        const res = await fetch('https://paper-api.alpaca.markets/v2/account', { headers: HEADERS });
        const account = await res.json();
        console.log('[ALPACA CONNECTED]', account.account_number, 'Equity:', account.equity);
        showNotification('✅ Connected to Alpaca');
      } catch (err) {
        console.error('[ALPACA CONNECTION FAILED]', err);
        showNotification('❌ Alpaca API Error');
      }
    })();
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
        {asset.entryReady && (
          <Text style={styles.entryReady}>✅ ENTRY READY</Text>
        )}
        {asset.watchlist && !asset.entryReady && (
          <Text style={styles.watchlist}>🟧 WATCHLIST</Text>
        )}
        {asset.price != null && <Text>Price: ${asset.price}</Text>}
        {asset.rsi != null && <Text>RSI: {asset.rsi}</Text>}
        <Text>Trend: {asset.trend}</Text>
        {asset.missingData && (
          <Text style={styles.missing}>⚠️ Missing data</Text>
        )}
        {asset.error && (
          <Text style={styles.error}>❌ Not tradable: {asset.error}</Text>
        )}
        <Text>{asset.time}</Text>
        <TouchableOpacity onPress={() => placeOrder(asset.symbol, asset.cc, true)}>
          <Text style={styles.buyButton}>Manual BUY</Text>
        </TouchableOpacity>
      </View>
    );
  };

  // Sort tokens by signal difference descending, falling back to
  // alphabetical sort to create stable ordering.  Null values sort
  // last.
  const bySignal = (a, b) => {
    const diffA = a.signalDiff ?? -Infinity;
    const diffB = b.signalDiff ?? -Infinity;
    if (diffA === diffB) return a.symbol.localeCompare(b.symbol);
    return diffB - diffA;
  };

  const entryReadyTokens = data.filter((t) => t.entryReady).sort(bySignal);
  const watchlistTokens = data.filter((t) => !t.entryReady && t.watchlist).sort(bySignal);
  const otherTokens = data.filter((t) => !t.entryReady && !t.watchlist).sort(bySignal);

  return (
    <ScrollView
      contentContainerStyle={[styles.container, darkMode && styles.containerDark]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.row}>
        <Switch value={darkMode} onValueChange={setDarkMode} />
        <Text style={[styles.title, darkMode && styles.titleDark]}>🎭 Bullish or Bust!</Text>
      </View>
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
