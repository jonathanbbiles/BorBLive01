import React, { useState, useEffect } from 'react';
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

const ALPACA_KEY = 'PKN4ICO3WECXStLDGXCHC';
const ALPACA_SECRET = 'PwJAEwLnLnsf7qAVvFutE8VIMgsAgvi7PMkMcCca';
const ALPACA_BASE_URL = 'https://paper-api.alpaca.markets/v2';

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json',
};

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
  { name: 'USDC/USD', symbol: 'USDCUSD', cc: 'USDC' },
  { name: 'USDT/USD', symbol: 'USDTUSD', cc: 'USDT' },
  { name: 'MKR/USD', symbol: 'MKRUSD', cc: 'MKR' },
];

export default function App() {
  const [tracked] = useState(ORIGINAL_TOKENS);
  const [data, setData] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [autoTrade, setAutoTrade] = useState(false);
  const [hideOthers, setHideOthers] = useState(false);

  const calcRSI = (closes, period = 14) => {
    if (closes.length < period + 1) return null;
    let gains = 0,
      losses = 0;
    for (let i = 1; i <= period; i++) {
      const delta = closes[i] - closes[i - 1];
      delta >= 0 ? (gains += delta) : (losses -= delta);
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
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const slope = (15 * sumXY - sumX * sumY) / (15 * sumX2 - sumX * sumX);
    return slope > 0.02 ? '⬆️' : slope < -0.02 ? '⬇️' : '🟰';
  };

  const calcMACD = (closes, short = 12, long = 26, signalPeriod = 9) => {
    if (closes.length < long + signalPeriod) return { macd: null, signal: null };
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

  const calcEMA = (closes, period = 10) => {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const placeOrder = async (symbol, ccSymbol = symbol, isManual = false) => {
    if (!autoTrade && !isManual) return;
    try {
      const priceRes = await fetch(
        `https://min-api.cryptocompare.com/data/price?fsym=${ccSymbol}&tsyms=USD`
      );
      const priceData = await priceRes.json();
      const price = priceData.USD;

      const histoRes = await fetch(
        `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${ccSymbol}&tsym=USD&limit=52&aggregate=15`
      );
      const histoData = await histoRes.json();
      const histoBars = Array.isArray(histoData?.Data?.Data)
        ? histoData.Data.Data
        : null;
      if (!histoBars) {
        console.warn(`No chart data returned for ${ccSymbol}`);
        return;
      }
      const closes = Array.isArray(histoBars)
        ? histoBars.map((bar) => bar.close)
        : [];

      const rsi = calcRSI(closes);
      const rsiPrev = calcRSI(closes.slice(0, -1));
      const rsiRising =
        rsiPrev != null && rsi != null && rsi > 30 && rsi > rsiPrev;
      const { macd, signal } = calcMACD(closes);

      const trend = getTrendSymbol(closes);

      const ema = calcEMA(closes, 10);
      const emaPrev = calcEMA(closes.slice(0, -1), 10);
      const pricePrev = closes[closes.length - 2];
      const emaBreakout = ema != null && emaPrev != null && price > ema && pricePrev < emaPrev;

      const shouldBuy =
        macd != null &&
        signal != null &&
        macd > signal &&
        (rsiRising || emaBreakout);

      if (!shouldBuy && !isManual) {
        console.log(`Entry conditions not met for ${symbol}`);
        return;
      }

      const accountRes = await fetch(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
      const accountData = await accountRes.json();
      const buyingPower = parseFloat(accountData.buying_power || accountData.cash || '0');
      const qty = parseFloat(((buyingPower * 0.1) / price).toFixed(6));
      if (qty <= 0) {
        console.error('❌ Insufficient buying power');
        return;
      }

      const order = {
        symbol,
        qty,
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
      };

      const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(order),
      });
      const orderData = await res.json();

      if (!res.ok) {
        Alert.alert('❌ Order Failed', orderData.message || 'Unknown error');
        console.error('❌ Order failed:', orderData);
        return;
      }

      console.log('✅ Market buy placed:', orderData);

      // poll for fill status
      let filledOrder = null;
      for (let i = 0; i < 20; i++) {
        try {
          const statusRes = await fetch(`${ALPACA_BASE_URL}/orders/${orderData.id}`, {
            headers: HEADERS,
          });
          const statusData = await statusRes.json();
          if (statusData.status === 'filled') {
            filledOrder = statusData;
            break;
          }
        } catch (pollErr) {
          console.error('❌ Poll error:', pollErr);
          break;
        }
        await sleep(3000);
      }

      if (!filledOrder) {
        console.log('❌ Buy not filled in time, aborting sell');
        return;
      }

      const filledPrice = parseFloat(filledOrder.filled_avg_price);
      const sellBasis = isNaN(filledPrice) ? price : filledPrice;

      Alert.alert('✅ Buy Filled', `Bought ${symbol} at $${sellBasis.toFixed(2)}`);

      await sleep(10000);

      const limitSell = {
        symbol,
        qty: filledOrder.filled_qty,
        side: 'sell',
        type: 'limit',
        time_in_force: 'day',
        limit_price: (sellBasis * 1.0025).toFixed(2),
      };

      try {
        const sellRes = await fetch(`${ALPACA_BASE_URL}/orders`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(limitSell),
        });
        const sellData = await sellRes.json();
        if (sellRes.ok) {
          console.log('✅ Limit sell placed:', sellData);
          Alert.alert('✅ Trade Executed', `Sell order placed at $${limitSell.limit_price}`);
        } else {
          Alert.alert('❌ Sell Failed', sellData.message || 'Unknown error');
          console.error('❌ Sell failed:', sellData);
        }
      } catch (sellErr) {
        Alert.alert('❌ Sell Failed', sellErr.message);
        console.error('❌ Sell error:', sellErr);
      }
    } catch (err) {
      console.error('❌ Order error:', err);
    }
  };

  const loadData = async () => {
    const results = await Promise.all(
      tracked.map(async (asset) => {
        try {
          const priceRes = await fetch(
            `https://min-api.cryptocompare.com/data/price?fsym=${asset.cc || asset.symbol}&tsyms=USD`
          );
          const priceData = await priceRes.json();
          const price = priceData.USD;

          const histoRes = await fetch(
            `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${asset.cc || asset.symbol}&tsym=USD&limit=52&aggregate=15`
          );
          const histoData = await histoRes.json();
          const histoBars = Array.isArray(histoData?.Data?.Data)
            ? histoData.Data.Data
            : null;
          if (!histoBars) {
            console.warn(`No chart data returned for ${asset.symbol}`);
            return null;
          }
          const closes = Array.isArray(histoBars)
            ? histoBars.map((bar) => bar.close)
            : [];

          const rsi = calcRSI(closes);
          const rsiPrev = calcRSI(closes.slice(0, -1));
          const rsiRising =
            rsiPrev != null && rsi != null && rsi > 30 && rsi > rsiPrev;
          const { macd, signal } = calcMACD(closes);

          const trend = getTrendSymbol(closes);

          const entryReady =
            macd != null &&
            signal != null &&
            macd > signal &&
            rsiRising &&
            (trend === '⬆️' || trend === '🟰');

          const watchlist = macd != null && signal != null && macd > signal && !entryReady;

          if (entryReady && autoTrade) {
            await placeOrder(asset.symbol, asset.cc);
          }

          return {
            ...asset,
            price,
            rsi: rsi?.toFixed(1),
            rsiRising,
            trend,
            entryReady,
            watchlist,
            time: new Date().toLocaleTimeString(),
          };
        } catch (err) {
          return { ...asset, error: err.message };
        }
      })
    );
    // Filter out null/undefined entries to avoid crashing renderCard
    setData(results.filter(Boolean));
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
        {asset.error ? (
          <Text style={styles.error}>Error: {asset.error}</Text>
        ) : (
          <>
            {asset.entryReady && (
              <Text style={styles.entryReady}>✅ ENTRY READY</Text>
            )}
            {asset.watchlist && !asset.entryReady && (
              <Text style={styles.watchlist}>🟧 WATCHLIST</Text>
            )}
            <Text>Price: ${asset.price}</Text>
            <Text>RSI: {asset.rsi}</Text>
            <Text>Trend: {asset.trend}</Text>
            <Text>{asset.time}</Text>
            <TouchableOpacity onPress={() => placeOrder(asset.symbol, asset.cc, true)}>
              <Text style={styles.buyButton}>Manual BUY</Text>
            </TouchableOpacity>
          </>
        )}
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
});