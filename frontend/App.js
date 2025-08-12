// App.js
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  Switch,
} from 'react-native';

// ⚠️ Keys shown only to match your test case; rotate in real use.
const ALPACA_KEY = 'PKN4ICO3WECXSLDGXCHC';
const ALPACA_SECRET = 'PwJAEwLnLnsf7qAVvFutE8VIMgsAgvi7PMkMcCca';
const ALPACA_BASE_URL = 'https://paper-api.alpaca.markets/v2';

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json',
};

// Guard across a refresh cycle
let insufficientFundsThisCycle = false;

const ORIGINAL_TOKENS = [
  { name: 'BTC/USD', symbol: 'BTCUSD', cc: 'BTC' },
  { name: 'ETH/USD', symbol: 'ETHUSD', cc: 'ETH' },
  { name: 'DOGE/USD', symbol: 'DOGEUSD', cc: 'DOGE' },
  { name: 'SUSHI/USD', symbol: 'SUSHIUSD', cc: 'SUSHI' },
  { name: 'SHIB/USD', symbol: 'SHIBUSD', cc: 'SHIB' },
  { name: 'CRV/USD', symbol: 'CRVUSD', cc: 'CRV' },
  { name: 'AAVE/USD', symbol: 'AAVEUSD', cc: 'AAVE' },
  { name: 'AVAX/USD', symbol: 'AVAXUSD', cc: 'AVAX' },
  { name: 'LINK/USD', symbol: 'LINKUSD', cc: 'LINK' },
  { name: 'LTC/USD', symbol: 'LTCUSD', cc: 'LTC' },
  { name: 'UNI/USD', symbol: 'UNIUSD', cc: 'UNI' },
  { name: 'DOT/USD', symbol: 'DOTUSD', cc: 'DOT' },
  { name: 'BCH/USD', symbol: 'BCHUSD', cc: 'BCH' },
  { name: 'BAT/USD', symbol: 'BATUSD', cc: 'BAT' },
  { name: 'XTZ/USD', symbol: 'XTZUSD', cc: 'XTZ' },
  { name: 'YFI/USD', symbol: 'YFIUSD', cc: 'YFI' },
  { name: 'GRT/USD', symbol: 'GRTUSD', cc: 'GRT' },
  { name: 'MKR/USD', symbol: 'MKRUSD', cc: 'MKR' },
];

export default function App() {
  const [tracked] = useState(ORIGINAL_TOKENS);
  const [data, setData] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [autoTrade, setAutoTrade] = useState(false);
  const [hideOthers, setHideOthers] = useState(false);
  const [notification, setNotification] = useState(null);

  const showNotification = (message) => {
    setNotification(message);
    setTimeout(() => setNotification(null), 2000);
  };

  const calcRSI = (closes, period = 14) => {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      d >= 0 ? (gains += d) : (losses -= d);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  };

  const getTrendSymbol = (closes) => {
    if (closes.length < 15) return '🟰';
    const x = Array.from({ length: 15 }, (_, i) => i);
    const y = closes.slice(-15);
    const sumX = x.reduce((a, b) => a + b);
    const sumY = y.reduce((a, b) => a + b);
    const sumXY = x.reduce((s, xi, i) => s + xi * y[i], 0);
    const sumX2 = x.reduce((s, xi) => s + xi * xi, 0);
    const slope = (15 * sumXY - sumX * sumY) / (15 * sumX2 - sumX * sumX);
    return slope > 0.02 ? '⬆️' : slope < -0.02 ? '⬇️' : '🟰';
  };

  const calcMACD = (closes, short = 12, long = 26, signalPeriod = 9) => {
    if (closes.length < long + signalPeriod) return { macd: null, signal: null };
    const kS = 2 / (short + 1);
    const kL = 2 / (long + 1);
    const kSig = 2 / (signalPeriod + 1);
    let emaS = closes[0];
    let emaL = closes[0];
    const macdLine = [];
    for (const p of closes) {
      emaS = p * kS + emaS * (1 - kS);
      emaL = p * kL + emaL * (1 - kL);
      macdLine.push(emaS - emaL);
    }
    let signal = macdLine[0];
    for (let i = 1; i < macdLine.length; i++) {
      signal = macdLine[i] * kSig + signal * (1 - kSig);
    }
    return { macd: macdLine.at(-1), signal };
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (v) => (v == null ? 0 : Number.parseFloat(String(v)));
  const cents = (usd) => Math.floor(usd * 100) / 100;

  const placeOrder = async (symbol, ccSymbol = symbol, isManual = false) => {
    if (!autoTrade && !isManual) return;
    if (!isManual && insufficientFundsThisCycle) {
      console.log('Skipping order due to insufficient funds this cycle');
      return;
    }

    try {
      // --- Indicators / sanity price ---
      const priceRes = await fetch(
        `https://min-api.cryptocompare.com/data/price?fsym=${ccSymbol}&tsyms=USD`
      );
      const priceData = await priceRes.json();
      const price = typeof priceData.USD === 'number' ? priceData.USD : null;
      if (price == null) return;

      const histoRes = await fetch(
        `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${ccSymbol}&tsym=USD&limit=52&aggregate=15`
      );
      const histoData = await histoRes.json();
      const bars = Array.isArray(histoData?.Data?.Data) ? histoData.Data.Data : [];
      const closes = bars.map((b) => b.close).filter((c) => typeof c === 'number');

      const { macd, signal } = calcMACD(closes);
      const shouldBuy = macd != null && signal != null && macd > signal;
      if (!shouldBuy && !isManual) return;

      // --- Account snapshot: use ONLY non_marginable_buying_power for crypto sizing ---
      const accountRes = await fetch(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
      const account = await accountRes.json();

      const trading_blocked = !!account.trading_blocked;
      const account_blocked = !!account.account_blocked;
      const trade_suspended_by_user = !!account.trade_suspended_by_user;

      const nmbp = num(account.non_marginable_buying_power); // settled cash for crypto
      const available = nmbp;

      console.log('Account snapshot', {
        non_marginable_buying_power: account.non_marginable_buying_power,
        buying_power: account.buying_power,
        cash: account.cash,
        trading_blocked,
        account_blocked,
        trade_suspended_by_user,
        available_for_crypto: available,
      });

      if (
        available < 10 ||
        trading_blocked ||
        account_blocked ||
        trade_suspended_by_user
      ) {
        const reason =
          available < 10
            ? 'Insufficient crypto buying power (non_marginable)'
            : trading_blocked
            ? 'Trading blocked'
            : account_blocked
            ? 'Account blocked'
            : 'Trading suspended by user';
        if (isManual) showNotification(`❌ Order Failed: ${reason}`);
        else insufficientFundsThisCycle = available < 10;
        return;
      }

      // --- Notional sizing with cushion (avoid rejections on price hop) ---
      const rawAlloc = Math.min(Math.max(available * 0.10, 10), available);
      const cushion = 0.998;
      const notionalUSD = cents(rawAlloc * cushion);
      if (notionalUSD < 10) {
        if (isManual) showNotification('❌ Order Failed: < $10 notional');
        else insufficientFundsThisCycle = true;
        return;
      }

      // Alpaca crypto symbols use slash
      const alpacaSymbol = symbol.includes('/') ? symbol : `${ccSymbol}/USD`;

      // --- Market BUY (no extended_hours for crypto) using NOTIONAL ---
      const buyOrder = {
        symbol: alpacaSymbol,
        notional: notionalUSD.toFixed(2),
        side: 'buy',
        type: 'market',
        time_in_force: 'gtc',
        order_class: 'simple',
      };

      const buyRes = await fetch(`${ALPACA_BASE_URL}/orders`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(buyOrder),
      });
      const buyData = await buyRes.json();
      if (!buyRes.ok) {
        console.error('❌ Buy failed:', buyData);
        if (isManual) showNotification(`❌ Buy Failed: ${buyData.message || 'Unknown error'}`);
        return;
      }
      console.log('✅ Market buy placed:', buyData);

      // --- Poll for fill ---
      let filledOrder = null;
      for (let i = 0; i < 20; i++) {
        try {
          const s = await fetch(`${ALPACA_BASE_URL}/orders/${buyData.id}`, { headers: HEADERS });
          const sd = await s.json();
          if (sd.status === 'filled') {
            filledOrder = sd;
            break;
          }
        } catch (e) {
          console.error('❌ Poll error:', e);
          break;
        }
        await sleep(3000);
      }
      if (!filledOrder) return;

      const filledPrice = parseFloat(filledOrder.filled_avg_price);
      const sellBasis = isNaN(filledPrice) ? price : filledPrice;
      showNotification(`✅ Buy Filled: ${alpacaSymbol} at $${sellBasis.toFixed(2)}`);

      // --- Confirm position qty, then sell slightly less to avoid fee/precision over-ask ---
      await sleep(5000);

      let positionQty = parseFloat(filledOrder.filled_qty || '0');
      for (let posAttempt = 1; posAttempt <= 3; posAttempt++) {
        try {
          const posRes = await fetch(
            `${ALPACA_BASE_URL}/positions/${encodeURIComponent(alpacaSymbol)}`,
            { headers: HEADERS }
          );
          if (posRes.ok) {
            const pos = await posRes.json();
            const fullQty = parseFloat(pos.qty);
            if (!isNaN(fullQty)) {
              positionQty = fullQty;
              break;
            }
          } else {
            console.warn(`❌ Position fetch failed (status ${posRes.status}), attempt ${posAttempt}`);
          }
        } catch (err) {
          console.error(`❌ Position fetch error on attempt ${posAttempt}:`, err);
        }
        if (posAttempt < 3) await sleep(1000);
      }

      // Epsilon: sell a hair under to avoid "requested > available" after fees
      const epsilon = 0.001; // 0.1%
      let sellQty = Math.max(0, positionQty * (1 - epsilon));
      sellQty = Math.floor(sellQty * 1e6) / 1e6; // 6 dp
      if (sellQty <= 0) return;

      const limitSell = {
        symbol: alpacaSymbol,
        qty: sellQty.toFixed(6),
        side: 'sell',
        type: 'limit',
        time_in_force: 'gtc',
        order_class: 'simple',
        limit_price: (sellBasis * 1.0025).toFixed(2),
      };

      let sellSuccess = false;
      let lastErrorMsg = '';
      let lastStatus = null;
      for (let attempt = 1; attempt <= 3 && !sellSuccess; attempt++) {
        const ts = new Date().toISOString();
        console.log(`[${ts}] ⏳ Sell attempt ${attempt}:`, limitSell);
        try {
          const sellRes = await fetch(`${ALPACA_BASE_URL}/orders`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify(limitSell),
          });
          const raw = await sellRes.text();
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          if (sellRes.ok) {
            sellSuccess = true;
            console.log(`✅ Limit sell placed for ${alpacaSymbol}`, body);
            showNotification(`✅ Sell placed at $${limitSell.limit_price}`);
          } else {
            lastStatus = sellRes.status;
            lastErrorMsg = body?.message || String(body);
            console.error(`[${ts}] ❌ Sell failed (${sellRes.status}):`, body);
            if (attempt < 3) await sleep(5000);
          }
        } catch (err) {
          lastErrorMsg = err.message;
          console.error(`[${ts}] ❌ Sell error:`, err);
          if (attempt < 3) await sleep(5000);
        }
      }

      if (!sellSuccess) {
        const statusPart = lastStatus ? `Status: ${lastStatus}\n` : '';
        const msgPart = lastErrorMsg ? `Error: ${lastErrorMsg}` : 'Unknown error';
        showNotification(`❌ Sell Failed: ${statusPart}${msgPart}`);
      }
    } catch (err) {
      console.error('❌ Order error:', err);
    }
  };

  const loadData = async () => {
    insufficientFundsThisCycle = false;
    const results = [];
    for (const asset of tracked) {
      const token = {
        ...asset,
        price: null,
        rsi: null,
        macd: null,
        signal: null,
        trend: '🟰',
        entryReady: false,
        watchlist: false,
        missingData: false,
        error: null,
        time: new Date().toLocaleTimeString(),
      };
      try {
        const priceRes = await fetch(
          `https://min-api.cryptocompare.com/data/price?fsym=${asset.cc || asset.symbol}&tsyms=USD`
        );
        const priceData = await priceRes.json();
        if (typeof priceData.USD === 'number') token.price = priceData.USD;

        const histoRes = await fetch(
          `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${asset.cc || asset.symbol}&tsym=USD&limit=52&aggregate=15`
        );
        const histoData = await histoRes.json();
        const bars = Array.isArray(histoData?.Data?.Data) ? histoData.Data.Data : [];
        const closes = bars.map((b) => b.close).filter((c) => typeof c === 'number');

        if (closes.length >= 20) {
          const r = calcRSI(closes);
          const m = calcMACD(closes);
          token.rsi = r != null ? r.toFixed(1) : null;
          token.macd = m.macd;
          token.signal = m.signal;
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

        if (token.entryReady && autoTrade) {
          await placeOrder(asset.symbol, asset.cc);
        }
      } catch (err) {
        console.error(`Failed to load ${asset.symbol}:`, err);
        token.error = err.message;
        token.missingData = true;
      }
      results.push(token);
    }
    setData(results);
    setRefreshing(false);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, [autoTrade]);

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

  const entryReadyTokens = data
    .filter((t) => t.entryReady)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const watchlistTokens = data
    .filter((t) => !t.entryReady && t.watchlist)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const otherTokens = data
    .filter((t) => !t.entryReady && !t.watchlist)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  return (
    <ScrollView
      contentContainerStyle={[styles.container, darkMode && styles.containerDark]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.row}>
        <Switch value={darkMode} onValueChange={setDarkMode} />
        <Text style={[styles.title, darkMode && styles.titleDark]}>🎭 Bullish or Bust!</Text>
        <Switch value={autoTrade} onValueChange={setAutoTrade} />
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
      {notification && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{notification}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, paddingTop: 40, paddingHorizontal: 10, backgroundColor: '#fff' },
  containerDark: { backgroundColor: '#121212' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title: { fontSize: 18, fontWeight: 'bold', color: '#000' },
  titleDark: { color: '#fff' },
  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  card: { width: '48%', backgroundColor: '#f0f0f0', padding: 10, borderRadius: 6, borderLeftWidth: 5, marginBottom: 10 },
  cardWatchlist: { borderColor: '#FFA500', borderWidth: 2 },
  symbol: { fontSize: 15, fontWeight: 'bold', color: '#005eff' },
  error: { color: 'red', fontSize: 12 },
  buyButton: { color: '#0066cc', marginTop: 8, fontWeight: 'bold' },
  noData: { textAlign: 'center', marginTop: 20, fontStyle: 'italic', color: '#777' },
  entryReady: { color: 'green', fontWeight: 'bold' },
  watchlist: { color: '#FFA500', fontWeight: 'bold' },
  sectionHeader: { fontSize: 16, fontWeight: 'bold', marginBottom: 5, marginTop: 10 },
  missing: { color: 'red', fontStyle: 'italic' },
  toast: {
    position: 'absolute', bottom: 40, left: 20, right: 20,
    padding: 12, backgroundColor: '#333', borderRadius: 8, zIndex: 999,
  },
  toastText: { color: '#fff', textAlign: 'center' },
});