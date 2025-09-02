// App.js — Bullish or Bust — v1.7.0-SPEC-LOOP (COSMETIC TWEAKS + MONITORING PANEL)
// Cosmetic-only edits per request (title, safe top margin, toolbar layout, risk row, simpler cards)
// Monitoring-only additions: Portfolio PnL & Fees panel (no strategy changes)

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, SafeAreaView, Platform } from 'react-native';

// ===================== Meta / API =====================
const VERSION = 'v1.7.0-SPEC-LOOP';

const ALPACA_KEY    = 'AKS3TBCTY4CFZ2LBK2GZ';
const ALPACA_SECRET = 'fX1QUAM5x8FGeGcEneIrgTCQXRSwcZnoaxHC6QXM';
const ALPACA_BASE_URL = 'https://api.alpaca.markets/v2';

const DATA_ROOT      = 'https://data.alpaca.markets/v1beta3/crypto';
const DATA_LOCATIONS = ['us', 'global'];

// CryptoCompare (bars/price fallback)
const CC_BARS = (cc, limit=5) =>
  `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${cc}&tsym=USD&limit=${limit}&aggregate=1`;
const CC_PRICE = (cc) =>
  `https://min-api.cryptocompare.com/data/price?fsym=${cc}&tsyms=USD`;

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

/* ===================== MONITORING HELPERS (PnL & Fees) ===================== */
// Portfolio history & activities (monitoring only; no strategy changes)
async function getPortfolioHistory({ period='1M', timeframe='1D' } = {}) {
  const url = `${ALPACA_BASE_URL}/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}&extended_hours=true`;
  const res = await f(url, { headers: HEADERS });
  if (!res.ok) return null;
  return res.json().catch(()=>null);
}

async function getActivities({ afterISO, untilISO, pageToken } = {}) {
  const params = new URLSearchParams({
    activity_types: 'FILL,FEE',
    direction: 'desc',
    page_size: '100',
  });
  if (afterISO) params.set('after', afterISO);
  if (untilISO) params.set('until', untilISO);
  if (pageToken) params.set('page_token', pageToken);

  const url = `${ALPACA_BASE_URL}/account/activities?${params.toString()}`;
  const res = await f(url, { headers: HEADERS });
  let items = [];
  try { items = await res.json(); } catch {}
  const next = res.headers?.get?.('x-next-page-token') || null;
  return { items: Array.isArray(items) ? items : [], next };
}

function isoDaysAgo(n){
  const d = new Date(Date.now() - n*24*60*60*1000);
  return d.toISOString();
}

async function getPnLAndFeesSnapshot() {
  // Equity & daily profit_loss
  const hist1M = await getPortfolioHistory({ period: '1M', timeframe: '1D' });
  let last7Sum = null, last7DownDays = null, last7UpDays = null, last30Sum = null;
  if (hist1M?.profit_loss) {
    const pl = hist1M.profit_loss.map(Number).filter(n=>Number.isFinite(n));
    const last7 = pl.slice(-7);
    const last30 = pl.slice(-30);
    last7Sum = last7.reduce((a,b)=>a+b,0);
    last30Sum = last30.reduce((a,b)=>a+b,0);
    last7UpDays = last7.filter(x=>x>0).length;
    last7DownDays = last7.filter(x=>x<0).length;
  }

  // Fees & fill count over last 30 days
  let fees30 = 0, fillsCount30 = 0;
  const afterISO = isoDaysAgo(30), untilISO = new Date().toISOString();
  let token = null;
  for (let i=0; i<10; i++){
    const { items, next } = await getActivities({ afterISO, untilISO, pageToken: token });
    for (const it of items) {
      const t = (it?.activity_type || it?.activityType || '').toUpperCase();
      if (t === 'FEE') {
        const amt = Number(it.amount ?? it.net_amount ?? it.price ?? 'NaN');
        if (Number.isFinite(amt)) fees30 += amt; // usually negative
      } else if (t === 'FILL') {
        fillsCount30 += 1;
      }
    }
    if (!next) break;
    token = next;
  }

  return { last7Sum, last7UpDays, last7DownDays, last30Sum, fees30, fillsCount30 };
}
/* =================== END MONITORING HELPERS (PnL & Fees) =================== */

// ===================== Strategy Switches (minimal) =====================
const MAKER_ONLY        = true;
const ENABLE_TAKER_FLIP = true; // maker-first, optional last-resort taker

// ===== Fees / microstructure =====
const FEE_BPS_MAKER = 15;   // 0.15%
const FEE_BPS_TAKER = 25;   // 0.25%
const ROUND_TRIP_FEES_BPS = MAKER_ONLY ? (FEE_BPS_MAKER*2) : (FEE_BPS_MAKER + FEE_BPS_TAKER);

// TP must exceed fees by >= 0.01% (1 bp) + a tiny slip cushion
const SLIP_BUFFER_BPS_BY_RISK = [8, 10, 12, 14, 16];   // safe → spicy

// quotes
const ALLOW_SYNTHETIC_QUOTE = true;
const DEFAULT_SYNTH_BPS     = 6; // was 12

// scan cadence
const SCAN_MS = 3000;

// ===================== Caps / Stables =====================
const ABS_MAX_NOTIONAL_USD = 85;
const STABLES = new Set(['USDTUSD','USDCUSD']);

// ===================== Presets / Base CFG =====================
const PRESETS = {
  C: { name: 'Aggressive but Fee-Safe' },
};
const CFG_BASE = {
  risk:  { maxPosPctEquity: 10, minNotionalUSD: 5 },
  exits: { limitReplaceSecs: 10, markRefreshSecs: 5 },
};

// ===================== Universe =====================
const ORIGINAL_TOKENS = [
  { name: 'ETH/USD',  symbol: 'ETHUSD',  cc: 'ETH'  },
  { name: 'AAVE/USD', symbol: 'AAVEUSD', cc: 'AAVE' },
  { name: 'LTC/USD',  symbol: 'LTCUSD',  cc: 'LTC'  },
  { name: 'LINK/USD', symbol: 'LINKUSD', cc: 'LINK' },
  { name: 'UNI/USD',  symbol: 'UNIUSD',  cc: 'UNI'  },
  { name: 'SOL/USD',  symbol: 'SOLUSD',  cc: 'SOL'  },
  { name: 'BTC/USD',  symbol: 'BTCUSD',  cc: 'BTC'  },
  { name: 'AVAX/USD', symbol: 'AVAXUSD', cc: 'AVAX' },
  { name: 'ADA/USD',  symbol: 'ADAUSD',  cc: 'ADA'  },
  { name: 'MATIC/USD',symbol: 'MATICUSD',cc: 'MATIC'},
  { name: 'XRP/USD',  symbol: 'XRPUSD',  cc: 'XRP'  },
  { name: 'SHIB/USD', symbol: 'SHIBUSD', cc: 'SHIB'  },
  { name: 'BCH/USD',  symbol: 'BCHUSD',  cc: 'BCH'  },
  { name: 'ETC/USD',  symbol: 'ETCUSD',  cc: 'ETC'  },
  { name: 'TRX/USD',  symbol: 'TRXUSD',  cc: 'TRX'  },
  { name: 'USDT/USD', symbol: 'USDTUSD', cc: 'USDT' },
  { name: 'USDC/USD', symbol: 'USDCUSD', cc: 'USDC' },
];

// ===================== Utils =====================
const sleep   = (ms) => new Promise(r=>setTimeout(r,ms));
const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fmtUSD  = (n) => Number.isFinite(n) ? `$ ${n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';
const fmtPct  = (n) => Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
function toDataSymbol(sym){ if(!sym)return sym; if(sym.includes('/'))return sym; if(sym.endsWith('USD'))return sym.slice(0,-3)+'/USD'; return sym; }
const ccFromSymbol = (sym) => (sym||'').replace('/','').replace('USD','');
function halfFromBps(price, bps){ return (bps/20000)*price; }

const emaArr = (arr, span) => { if (!arr?.length) return []; const k=2/(span+1); let prev=arr[0]; const out=[prev]; for(let i=1;i<arr.length;i++){ prev=arr[i]*k+prev*(1-k); out.push(prev);} return out; };

// ===================== Logs =====================
let logSubscriber = null; let logBuffer = []; const MAX_LOGS = 200;
export const registerLogSubscriber = (fn) => { logSubscriber = fn; };
const logTradeAction = async (type, symbol, details = {}) => {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, symbol, ...details };
  logBuffer.push(entry); if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  if (typeof logSubscriber === 'function') { try { logSubscriber(entry); } catch {} }
};

const FRIENDLY = {
  quote_ok:            { sev: 'info',    msg: (d)=>`Quote OK (${(d.spreadBps??0).toFixed(1)} bps${d.synthetic? ' • synth':''})` },
  quote_from_trade:    { sev: 'info',    msg: (d)=>`Fallback: trade→synth (${(d.spreadBps??0).toFixed(1)} bps)` },
  quote_from_cc:       { sev: 'info',    msg: ()=>`Fallback: CryptoCompare → synth` },
  quote_from_lastgood: { sev: 'info',    msg: ()=>`Fallback: last-good → synth` },
  quote_empty:         { sev: 'error',   msg: ()=>`Quote empty` },
  quote_exception:     { sev: 'error',   msg: (d)=>`Quote exception: ${d.error}` },
  trade_http_error:    { sev: 'warn',    msg: (d)=>`Alpaca trades ${d.status}` },
  quote_http_error:    { sev: 'warn',    msg: (d)=>`Alpaca quotes ${d.status}` },

  buy_camped:          { sev: 'info',    msg: (d)=>`Camping bid @ ${d.limit}` },
  buy_replaced:        { sev: 'info',    msg: (d)=>`Replaced bid → ${d.limit}` },
  buy_success:         { sev: 'success', msg: (d)=>`BUY filled qty ${d.qty} @≤${d.limit}` },
  buy_unfilled_canceled:{sev: 'warn',    msg: ()=>`BUY unfilled — canceled bid`},
  buy_stale_cleared:   { sev: 'warn',    msg: (d)=>`Cleared stale BUY (${d.ageSec}s)` },

  tp_limit_set:        { sev: 'success', msg: (d)=>`TP limit set @ ${d.limit}` },
  tp_limit_failed:     { sev: 'error',   msg: ()=>`TP set failed` },
  tp_limit_error:      { sev: 'error',   msg: (d)=>`TP set error: ${d.error}` },

  scan_start:          { sev: 'info',    msg: (d)=>`Scan start (batch ${d.batch})` },
  scan_summary:        { sev: 'info',    msg: (d)=>`Scan: ready ${d.readyCount} / attempts ${d.attemptCount} / fills ${d.successCount}` },
  scan_error:          { sev: 'error',   msg: (d)=>`Scan error: ${d.error}` },

  skip_wide_spread:    { sev: 'warn',    msg: (d)=>`Skip: spread ${d.spreadBps} bps > max` },
  skip_small_order:    { sev: 'warn',    msg: ()=>`Skip: below min notional or funding` },
  entry_skipped:       { sev: 'info',    msg: (d)=>`Entry ${d.entryReady ? 'ready' : 'not ready'}` },

  risk_changed:        { sev: 'info',    msg: (d)=>`Risk→${d.level} (spread≤${d.spreadMax}bps)` },
};
function friendlyLog(entry){
  const meta = FRIENDLY[entry.type];
  if (!meta) return { sev:'info', text:`${entry.type}${entry.symbol ? ' '+entry.symbol : ''}`, hint:null };
  const text = (typeof meta.msg === 'function') ? meta.msg(entry) : meta.msg;
  return { sev: meta.sev, text: `${entry.symbol ? entry.symbol+' — ' : ''}${text}`, hint: null };
}

// ===================== Fetch (retry/timeout) =====================
async function f(url, opts={}, timeoutMs=8000, retries=2){
  let lastErr;
  for (let i=0;i<=retries;i++){
    const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),timeoutMs);
    try{
      const res=await fetch(url,{...opts,signal:ac.signal});
      clearTimeout(timer);
      if (res.status===429 || res.status>=500){ if(i===retries) return res; await sleep(500*Math.pow(2,i)); continue; }
      return res;
    }catch(e){
      clearTimeout(timer); lastErr=e;
      if(i===retries) throw e;
      await sleep(350*Math.pow(2,i));
    }
  }
  if (lastErr) throw lastErr;
  return fetch(url,opts);
}

// ===================== Bars / Quotes (cached) =====================
const BAR_TTL_MS_1M = 25000, QUOTE_TTL_MS = 4000, LAST_GOOD_TTL_MS = 15000;
const barsCache1m = new Map(), quoteCache = new Map(), lastGood = new Map();

const getBars1m = async (cc, limit=6) => {
  const sym=ccFromSymbol(cc); const k=`${sym}-${limit}`; const c=barsCache1m.get(k); if(c && (Date.now()-c.ts)<BAR_TTL_MS_1M) return c.data;
  const r=await f(CC_BARS(sym, limit));
  const j=await r.json().catch(()=>({})); const arr=Array.isArray(j?.Data?.Data)?j.Data.Data:[];
  const data=arr.map(b=>({open:b.open,high:b.high,low:b.low,close:b.close,vol:(typeof b.volumefrom==='number'?b.volumefrom:(b.volumeto??0))}));
  barsCache1m.set(k,{ts:Date.now(),data}); return data;
};

const getPriceUSD = async (ccOrSymbol) => {
  const sym=(ccOrSymbol||'').replace('/','').replace('USD','');
  try{
    const r=await f(CC_PRICE(sym));
    const j=await r.json().catch(()=>({}));
    return parseFloat(j?.USD ?? 'NaN');
  }catch{ return NaN; }
};

const buildURL = (loc, what, symbolsCSV) =>
  `${DATA_ROOT}/${loc}/latest/${what}?symbols=${encodeURIComponent(symbolsCSV)}`;

async function alpacaQuotesAny(symbolsCSV){
  for (const loc of DATA_LOCATIONS) {
    const url = buildURL(loc, 'quotes', symbolsCSV);
    const r = await f(url, { headers: HEADERS });
    if (!r.ok){ try{ await r.text(); logTradeAction('quote_http_error','DATA',{status:r.status}); }catch{}; continue; }
    const j = await r.json().catch(()=>null);
    if (j?.quotes) return { quotes: j.quotes, loc };
  }
  return null;
}
async function alpacaTradesAny(symbolsCSV){
  for (const loc of DATA_LOCATIONS) {
    const url = buildURL(loc, 'trades', symbolsCSV);
    const r = await f(url, { headers: HEADERS });
    if (!r.ok){ try{ await r.text(); logTradeAction('trade_http_error','DATA',{status:r.status}); }catch{}; continue; }
    const j = await r.json().catch(()=>null);
    if (j?.trades) return { trades: j.trades, loc };
  }
  return null;
}

async function getQuotesBatch(symbols) {
  const uniq = Array.from(new Set(symbols.map(s=>toDataSymbol(s))));
  if (uniq.length === 0) return new Map();
  const csv = uniq.join(',');
  const out = new Map();

  let resQ = await alpacaQuotesAny(csv);
  const quotes = resQ?.quotes || null;

  if (quotes){
    for (const dsym of uniq) {
      const q = quotes?.[dsym]?.[0];
      const bid = Number(q?.bp), ask = Number(q?.ap), bs = Number(q?.bs), as = Number(q?.as);
      if (bid>0 && ask>0) {
        const sym = dsym.replace('/',''); const qObj = { bid, ask, bs:Number.isFinite(bs)?bs:null, as:Number.isFinite(as)?as:null };
        out.set(sym, qObj); quoteCache.set(sym, { ts: Date.now(), q: qObj }); lastGood.set(sym, { ts: Date.now(), mid: 0.5*(bid+ask) });
      }
    }
  }

  // Fill misses with last trade → synth
  const misses = uniq.filter(dsym => !out.has(dsym.replace('/','')));
  if (misses.length>0) {
    let resT = await alpacaTradesAny(misses.join(','));
    const trades = resT?.trades || null;
    if (trades){
      for (const dsym of misses) {
        const p = Number(trades?.[dsym]?.[0]?.p);
        const sym = dsym.replace('/','');
        if (Number.isFinite(p)&&p>0) {
          const half = halfFromBps(p, DEFAULT_SYNTH_BPS);
          const q2 = { bid: p - half, ask: p + half };
          const mid = 0.5*(q2.bid+q2.ask); const spreadBps=((q2.ask-q2.bid)/mid)*10000;
          logTradeAction('quote_from_trade', sym, { spreadBps:+spreadBps.toFixed(1) });
          out.set(sym, { ...q2, bs:null, as:null });
          quoteCache.set(sym, { ts: Date.now(), q: { ...q2, bs:null, as:null } });
          lastGood.set(sym, { ts: Date.now(), mid });
        }
      }
    }
  }
  return out;
}
async function getQuoteSmart(symbol, preloadedMap=null) {
  try{
    if (preloadedMap && preloadedMap.has(symbol)) return preloadedMap.get(symbol);
    const c = quoteCache.get(symbol); if (c && (Date.now()-c.ts) < QUOTE_TTL_MS) return c.q;
    const lg = lastGood.get(symbol);
    if (lg && (Date.now()-lg.ts) < LAST_GOOD_TTL_MS && ALLOW_SYNTHETIC_QUOTE) {
      const mid=lg.mid, half=halfFromBps(mid, DEFAULT_SYNTH_BPS);
      const q={bid:mid-half,ask:mid+half}; logTradeAction('quote_from_lastgood', symbol, {}); 
      return { ...q, bs:null, as:null, synthetic:true };
    }

    const dataSym = toDataSymbol(symbol);
    const resQ = await alpacaQuotesAny(dataSym);
    if (resQ?.quotes?.[dataSym]?.[0]) {
      const q = resQ.quotes[dataSym][0];
      const bid=Number(q?.bp), ask=Number(q?.ap), bs=Number(q?.bs), as=Number(q?.as);
      if (bid>0 && ask>0) { const qObj={bid,ask,bs:Number.isFinite(bs)?bs:null,as:Number.isFinite(as)?as:null}; quoteCache.set(symbol,{ts:Date.now(),q:qObj}); lastGood.set(symbol,{ts:Date.now(),mid:0.5*(bid+ask)}); return qObj; }
    }

    const px = await getPriceUSD(ccFromSymbol(symbol));
    if (Number.isFinite(px) && px>0 && ALLOW_SYNTHETIC_QUOTE) {
      const half=halfFromBps(px, DEFAULT_SYNTH_BPS);
      return { bid:px-half, ask:px+half, bs:null, as:null, synthetic:true };
    }

    const bars1 = await getBars1m(ccFromSymbol(symbol), 2);
    const close = bars1?.[bars1.length-1]?.close;
    if (Number.isFinite(close) && close>0 && ALLOW_SYNTHETIC_QUOTE) {
      const half=halfFromBps(close, DEFAULT_SYNTH_BPS);
      logTradeAction('quote_from_cc', symbol, {}); 
      return { bid:close-half, ask:close+half, bs:null, as:null, synthetic:true };
    }

    logTradeAction('quote_empty', symbol, {});
    return null;
  }catch(e){
    logTradeAction('quote_exception', symbol, { error: e.message });
    return null;
  }
}

// ===================== Tiny Momentum & TP Math =====================
const SPREAD_MAX_BPS_BASE = 26;
const SPREAD_EPS_BPS = 0.30;

function requiredProfitBps(riskLevel){
  const slip = SLIP_BUFFER_BPS_BY_RISK[riskLevel] ?? SLIP_BUFFER_BPS_BY_RISK[0];
  return ROUND_TRIP_FEES_BPS + 1 + slip; // fees + 0.01% + slip cushion
}

function threeUp(bars){
  if (!Array.isArray(bars) || bars.length < 4) return false;
  const a = bars.slice(-4).map(b=>b.close ?? b.c ?? b);
  return (a[1] < a[2]) && (a[2] < a[3]);
}

// ===================== Risk dials (spread only) =====================
function riskToDials(level){
  const addSpread  = [0,2,4,6,8][level] || 0;
  return { spreadMax: clamp(SPREAD_MAX_BPS_BASE + addSpread, 12, 30) };
}
function currentDials(overrides){
  const spreadMax = clamp((overrides?.spreadMax ?? SPREAD_MAX_BPS_BASE), 12, 30);
  return { spreadMax, level:0 };
}

// ===================== Positions / Orders =====================
const getPositionInfo = async (symbol) => {
  try {
    const res = await f(`${ALPACA_BASE_URL}/positions/${symbol}`, { headers: HEADERS });
    if (!res.ok) return null;
    const info = await res.json();
    const qty = parseFloat(info.qty ?? '0');
    const available = parseFloat(info.qty_available ?? info.available ?? info.qty ?? '0');
    const marketValue = parseFloat(info.market_value ?? info.marketValue ?? 'NaN');
    const markFromMV = Number.isFinite(marketValue) && qty > 0 ? marketValue / qty : NaN;
    const markFallback = parseFloat(info.current_price ?? info.asset_current_price ?? 'NaN');
    const mark = Number.isFinite(markFromMV) ? markFromMV : (Number.isFinite(markFallback) ? markFallback : NaN);
    const basis = parseFloat(info.avg_entry_price ?? 'NaN');
    return { qty:+(qty||0), available:+(available||0), basis:Number.isFinite(basis)?basis:null, mark:Number.isFinite(mark)?mark:null, marketValue:Number.isFinite(marketValue)?marketValue:0 };
  } catch { return null; }
};
const getAllPositions = async () => { try { const res=await f(`${ALPACA_BASE_URL}/positions`, { headers: HEADERS }); if(!res.ok) return []; const arr=await res.json(); return Array.isArray(arr)?arr:[]; } catch { return []; } };
const getOpenOrders = async () => { try { const res = await f(`${ALPACA_BASE_URL}/orders?status=open&nested=true&limit=100`, { headers: HEADERS }); if (!res.ok) return []; const data = await res.json(); return Array.isArray(data)?data:[]; } catch { return []; } };

const cancelOpenOrdersForSymbol = async (symbol, side=null) => {
  try {
    const open = await getOpenOrders();
    const targets = open.filter(o => o.symbol===symbol && (!side || (o.side||'').toLowerCase()===side));
    await Promise.all(targets.map(o => f(`${ALPACA_BASE_URL}/orders/${o.id}`,{method:'DELETE',headers:HEADERS}).catch(()=>null)));
  } catch {}
};
const cancelAllOrders = async () => {
  try { const orders = await getOpenOrders(); await Promise.all((orders||[]).map(o => f(`${ALPACA_BASE_URL}/orders/${o.id}`, { method:'DELETE', headers:HEADERS }).catch(()=>null))); }
  catch {}
};

// dynamic cap: min(ABS, % equity)
function capNotional(symbol, proposed, equity){
  const hardCap = ABS_MAX_NOTIONAL_USD;
  const perSymbolDynCap = (CFG_BASE.risk.maxPosPctEquity / 100) * equity;
  return Math.max(0, Math.min(proposed, hardCap, perSymbolDynCap));
}

// ---------- Stale BUY watchdog (kept) ----------
async function cleanupStaleBuyOrders(maxAgeSec = 30) {
  try {
    const [open, positions] = await Promise.all([getOpenOrders(), getAllPositions()]);
    const held = new Set((positions||[]).map(p => p.symbol));
    const now = Date.now();

    const tooOld = (o) => {
      const t = Date.parse(o.submitted_at || o.created_at || o.updated_at || '');
      if (!Number.isFinite(t)) return false;
      return ((now - t) / 1000) > maxAgeSec;
    };

    const stale = (open||[]).filter(o =>
      (o.side||'').toLowerCase()==='buy' &&
      !held.has(o.symbol) &&
      tooOld(o)
    );

    await Promise.all(stale.map(async (o) => {
      await f(`${ALPACA_BASE_URL}/orders/${o.id}`, { method:'DELETE', headers:HEADERS }).catch(()=>null);
      logTradeAction('buy_stale_cleared', o.symbol, { ageSec: Math.round((now - Date.parse(o.submitted_at || o.created_at || o.updated_at || now))/1000) });
    }));
  } catch {/* noop */}
}

// ===================== Account / PnL tiny =====================
async function getAccountSummaryRaw() {
  const res = await f(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Account ${res.status}`);
  const a = await res.json();
  const equity = parseFloat(a.equity ?? a.portfolio_value ?? 'NaN');
  const ref1 = parseFloat(a.last_equity ?? 'NaN');
  const ref2 = parseFloat(a.equity_previous_close ?? 'NaN');
  const ref = Number.isFinite(ref1) ? ref1 : (Number.isFinite(ref2) ? ref2 : NaN);
  const changeUsd = Number.isFinite(equity)&&Number.isFinite(ref)?(equity-ref):NaN;
  const changePct = Number.isFinite(changeUsd)&&ref>0?(changeUsd/ref)*100:NaN;
  const nmbp = parseFloat(a.non_marginable_buying_power ?? 'NaN'); const bp = parseFloat(a.buying_power ?? 'NaN'); const cash = parseFloat(a.cash ?? 'NaN');
  const buyingPower = Number.isFinite(nmbp) ? nmbp : (Number.isFinite(bp) ? bp : (Number.isFinite(cash) ? cash : NaN));
  return { equity, buyingPower, changeUsd, changePct };
}

// ===================== React App =====================
export default function App() {
  const [tracked] = useState(ORIGINAL_TOKENS);
  const [data, setData] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode] = useState(true);
  const autoTrade = true;

  const [notification, setNotification] = useState(null);
  const [logHistory, setLogHistory] = useState([]);

  const [isUpdatingAcct, setIsUpdatingAcct] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [acctSummary, setAcctSummary] = useState({ portfolioValue:null, buyingPower:null, dailyChangeUsd:null, dailyChangePct:null, updatedAt:null });

  // === PnL / Fees panel state (monitoring only) ===
  const [pnlSnap, setPnlSnap] = useState({
    last7Sum: null, last7UpDays: null, last7DownDays: null,
    last30Sum: null, fees30: null, fillsCount30: null, updatedAt: null, error: null
  });

  // risk + minimal dials
  const [riskLevel, setRiskLevel] = useState(4); // default HOT
  const [dialsOverride, setDialsOverride] = useState({ spreadMax:null });

  const [lastScanAt, setLastScanAt] = useState(null);
  const [openMeta, setOpenMeta] = useState({ positions: 0, orders: 0, allowed: tracked.length });

  // stability guards
  const scanningRef = useRef(false);

  // per-trade state
  const tradeStateRef = useRef({}); // { [symbol]: { entry, tp, entryTs, lastLimitPostTs } }

  // logs → UI
  useEffect(() => {
    registerLogSubscriber((entry)=>{
      const f = friendlyLog(entry);
      setLogHistory((prev)=>[{ ts: entry.timestamp, sev: f.sev, text: f.text, hint: null }, ...prev].slice(0, 22));
    });
    const seed = logBuffer.slice(-14).reverse().map(e => { const f = friendlyLog(e); return { ts: e.timestamp, sev: f.sev, text: f.text, hint: null }; });
    if (seed.length) setLogHistory(seed);
  }, []);
  const showNotification = (message) => { setNotification(message); setTimeout(()=>setNotification(null), 5000); };

  // account summary
  const getAccountSummary = async () => {
    setIsUpdatingAcct(true);
    try {
      const a = await getAccountSummaryRaw();
      setAcctSummary({ portfolioValue:a.equity, buyingPower:a.buyingPower, dailyChangeUsd:a.changeUsd, dailyChangePct:a.changePct, updatedAt:new Date().toISOString() });
    } catch (e) { logTradeAction('quote_exception', 'ACCOUNT', { error: e.message }); } finally { setIsUpdatingAcct(false); }
  };

  // ===== Simple entry signal (ONLY spread + tiny momentum) =====
  async function computeEntrySignal(asset, d, preQuoteMap=null){
    // Bars (for tiny momentum)
    const bars1 = await getBars1m(asset.cc || asset.symbol, 6);

    let q = await getQuoteSmart(asset.symbol, preQuoteMap);
    if (!q || !(q.bid>0 && q.ask>0)) {
      // synth via bars/cc
      const last = bars1?.[bars1.length-1]?.close;
      if (ALLOW_SYNTHETIC_QUOTE && Number.isFinite(last) && last>0) { 
        const half = halfFromBps(last, DEFAULT_SYNTH_BPS);
        q = { bid:last-half, ask:last+half, synthetic:true }; 
        logTradeAction('quote_from_cc', asset.symbol, {}); 
      }
    }
    if (!q) return { entryReady:false, why:'noquote' };

    const mid = 0.5*(q.bid+q.ask);
    const spreadBps = ((q.ask - q.bid) / mid) * 10000;
    logTradeAction('quote_ok', asset.symbol, { spreadBps:+spreadBps.toFixed(1), synthetic:q.synthetic===true });
    if (spreadBps > (d.spreadMax + SPREAD_EPS_BPS)) { logTradeAction('skip_wide_spread', asset.symbol, { spreadBps:+spreadBps.toFixed(1) }); return { entryReady:false, why:'spread' }; }

    // momentum: last 3 one-minute closes rising OR 5-EMA slope up
    const closes = bars1.map(b=>b.close);
    const ema5 = emaArr(closes.slice(-6), 5);
    const slopeUp = ema5.length>=2 ? (ema5[ema5.length-1] > ema5[ema5.length-2]) : false;
    const momo = threeUp(bars1) || slopeUp;

    if (!momo) return { entryReady:false, why:'nomomo' };

    // compute TP from required bps (fees + 1bp + slip)
    const needBps = requiredProfitBps(riskLevel);
    const tp = q.bid * (1 + needBps/10000);

    return { entryReady:true, spreadBps, quote:q, tpBps:needBps, tp };
  }

  // ===== Maker-first entry (short camp) =====
  async function placeMakerThenMaybeTakerBuy(symbol, qty, preQuoteMap=null){
    await cancelOpenOrdersForSymbol(symbol, 'buy');
    let lastOrderId=null, placedLimit=null;
    const t0=Date.now(); const CAMP_SEC = 15; // was 8

    while ((Date.now()-t0)/1000 < CAMP_SEC){
      let q=await getQuoteSmart(symbol, preQuoteMap);
      if(!q){ await sleep(500); continue; }
      const bidNow=q?.bid, askNow=q?.ask;
      if(!Number.isFinite(bidNow)||bidNow<=0){ await sleep(250); continue; }

      // Join the inside without crossing: become top-of-book
      const TICK = 1e-5;
      const join = Number.isFinite(askNow) && askNow>0
        ? Math.min(askNow - TICK, bidNow + TICK)
        : (bidNow + TICK);

      if(!lastOrderId || Math.abs(join-placedLimit)/join > 0.0001){
        if(lastOrderId){ try{ await f(`${ALPACA_BASE_URL}/orders/${lastOrderId}`,{method:'DELETE',headers:HEADERS}); }catch{} }
        const order = { symbol, qty, side:'buy', type:'limit', time_in_force:'gtc', limit_price:join.toFixed(5) };
        try{
          const res=await f(`${ALPACA_BASE_URL}/orders`, { method:'POST', headers:HEADERS, body:JSON.stringify(order) });
          const raw=await res.text(); let data; try{data=JSON.parse(raw);}catch{data={raw};}
          if(res.ok && data.id){
            lastOrderId=data.id; placedLimit=join;
            logTradeAction(placedLimit?'buy_replaced':'buy_camped', symbol, { limit: order.limit_price });
          }
        }catch(e){ logTradeAction('quote_exception', symbol, { error:e.message }); }
      }

      // detect fill via position
      const pos=await getPositionInfo(symbol);
      if(pos && pos.qty>0){
        if(lastOrderId){ try{ await f(`${ALPACA_BASE_URL}/orders/${lastOrderId}`,{method:'DELETE',headers:HEADERS}); }catch{} }
        logTradeAction('buy_success', symbol, { qty:pos.qty, limit: placedLimit?.toFixed ? placedLimit.toFixed(5) : placedLimit });
        return { filled:true, entry: pos.basis ?? placedLimit, qty:pos.qty };
      }
      await sleep(1200);
    }

    // camping ended without fill
    if (lastOrderId) {
      try { await f(`${ALPACA_BASE_URL}/orders/${lastOrderId}`, { method:'DELETE', headers:HEADERS }); }
      catch {}
      logTradeAction('buy_unfilled_canceled', symbol, {});
    }

    if (ENABLE_TAKER_FLIP){
      // Optional: last-resort taker buy at ask
      const q=await getQuoteSmart(symbol, preQuoteMap);
      if(q && q.ask>0){
        const order = { symbol, qty, side:'buy', type:'market', time_in_force:'gtc' };
        try{
          const res=await f(`${ALPACA_BASE_URL}/orders`, { method:'POST', headers:HEADERS, body:JSON.stringify(order) });
          const raw=await res.text(); let data; try{data=JSON.parse(raw);}catch{data={raw};}
          if(res.ok && data.id){ logTradeAction('buy_success', symbol, { qty, limit:'mkt' }); return { filled:true, entry: q.ask, qty }; }
        }catch{}
      }
    }
    return { filled:false };
  }

  const ensureLimitTP = async (symbol, limitPrice) => {
    const pos = await getPositionInfo(symbol);
    if (!pos || pos.available <= 0) return;
    const open = await getOpenOrders();
    const existing = open.find((o) => (o.side||'').toLowerCase()==='sell' && (o.type||'').toLowerCase()==='limit' && o.symbol===symbol);
    const now = Date.now();
    const lastTs = tradeStateRef.current[symbol]?.lastLimitPostTs || 0;
    const needsPost = !existing ||
      Math.abs(parseFloat(existing.limit_price)-limitPrice)/limitPrice > 0.001 ||
      now - lastTs > CFG_BASE.exits.limitReplaceSecs*1000;
    if (!needsPost) return;
    try {
      if (existing) { await f(`${ALPACA_BASE_URL}/orders/${existing.id}`, { method:'DELETE', headers:HEADERS }).catch(()=>null); }
      const order = { symbol, qty: pos.available, side:'sell', type:'limit', time_in_force:'gtc', limit_price: limitPrice.toFixed(5) };
      const res = await f(`${ALPACA_BASE_URL}/orders`, { method:'POST', headers:HEADERS, body:JSON.stringify(order) });
      const raw = await res.text(); let data; try{ data=JSON.parse(raw);}catch{ data={raw}; }
      if (res.ok && data.id) { tradeStateRef.current[symbol]={...(tradeStateRef.current[symbol]||{}), lastLimitPostTs: now}; logTradeAction('tp_limit_set', symbol, { id:data.id, limit:order.limit_price }); }
      else { logTradeAction('tp_limit_failed', symbol, {}); }
    } catch(e){ logTradeAction('tp_limit_error', symbol, { error: e.message }); }
  };

  async function hasOpenBuyForSymbol(symbol){
    try {
      const open = await getOpenOrders();
      return (open||[]).some(o => (o.symbol===symbol) && ((o.side||'').toLowerCase()==='buy'));
    } catch { return false; }
  }

  // ===== placeOrder (per your spec sizing) =====
  const placeOrder = async (symbol, ccSymbol=symbol, d, sigPre=null, preQuoteMap=null) => {
    if (STABLES.has(symbol)) return false; // never trade stables
    await cleanupStaleBuyOrders(30);

    // Removed "skip if open BUY" blocker; we cancel/replace inside camping.
    const held = await getPositionInfo(symbol); if (held && Number(held.qty) > 0) { logTradeAction('entry_skipped', symbol, { entryReady:false }); return false; }

    const sig = sigPre || await computeEntrySignal({ symbol, cc: ccSymbol }, d, preQuoteMap);
    if (!sig.entryReady) return false;

    // equity + BP snapshot
    let equity = acctSummary.portfolioValue, buyingPower = acctSummary.buyingPower;
    if (!Number.isFinite(equity) || !Number.isFinite(buyingPower)) {
      try { const a=await getAccountSummaryRaw(); equity=a.equity; buyingPower=a.buyingPower; } catch {}
    }
    if (!Number.isFinite(equity) || equity<=0) equity = 1000;
    if (!Number.isFinite(buyingPower) || buyingPower<=0) return false;

    // per your spec: spend = min(BP, 10% * equity), then cap by ABS
    const desired = Math.min(buyingPower, (CFG_BASE.risk.maxPosPctEquity/100) * equity);
    const notional = capNotional(symbol, desired, equity);
    if (!isFinite(notional) || notional < CFG_BASE.risk.minNotionalUSD) { logTradeAction('skip_small_order', symbol); return false; }

    const entryPx = sig.quote.bid;
    const qty = +(notional/entryPx).toFixed(6);
    if (!Number.isFinite(qty) || qty<=0) { logTradeAction('skip_small_order', symbol); return false; }

    const result = await placeMakerThenMaybeTakerBuy(symbol, qty, preQuoteMap);
    if (!result.filled) return false;

    const needBps = requiredProfitBps(riskLevel);
    const tp = (result.entry ?? entryPx) * (1 + needBps/10000);

    tradeStateRef.current[symbol] = { entry: result.entry ?? entryPx, tp, entryTs: Date.now(), lastLimitPostTs: 0 };
    await ensureLimitTP(symbol, tp);
    return true;
  };

  // ===== TP maintenance loop only (no stops/time stops) =====
  useEffect(() => {
    let timer = null;
    const run = async () => {
      try {
        for (const asset of tracked) {
          const symbol = asset.symbol;
          const pos = await getPositionInfo(symbol);
          if (!pos || Number(pos.qty) <= 0) continue;

          const s = tradeStateRef.current[symbol] || { entry: pos.basis, entryTs: Date.now(), lastLimitPostTs: 0 };
          tradeStateRef.current[symbol] = s;

          // Refresh TP from spec math (fees + 1bp + slip)
          const needBps = requiredProfitBps(riskLevel);
          const tp = (s.entry ?? pos.basis ?? pos.mark ?? 0) * (1 + needBps/10000);
          s.tp = tp;

          await ensureLimitTP(symbol, tp);
        }
      } finally {
        const ms = CFG_BASE.exits.markRefreshSecs*1000;
        timer = setTimeout(run, ms);
      }
    };
    run();
    return () => { if (timer) clearTimeout(timer); };
  }, [tracked, riskLevel]);

  // ===== Scanner (ALL symbols, constant cadence) =====
  const loadData = async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setIsLoading(true);

    setData(prev => (prev && prev.length ? prev :
      ORIGINAL_TOKENS.map(t => ({ ...t, price:null, entryReady:false, error:null, time:new Date().toLocaleTimeString(), spreadBps:null, tpBps:null }))
    ));

    let results = [];
    try {
      await getAccountSummary();

      const positions = await getAllPositions();
      const allOpenOrders = await getOpenOrders();

      let openCount = (positions||[]).filter(p => {
        const sym = p.symbol;
        if (STABLES.has(sym)) return false;
        const mv = parseFloat(p.market_value ?? p.marketValue ?? '0');
        const qty = parseFloat(p.qty ?? '0');
        return Number.isFinite(mv) && mv > 1 && Number.isFinite(qty) && qty > 0;
      }).length;
      setOpenMeta({ positions: openCount, orders: (allOpenOrders||[]).length, allowed: tracked.length });

      const scanList = tracked.slice(); // ALL symbols
      logTradeAction('scan_start','ALL',{batch: scanList.length});

      const batchMap = await getQuotesBatch(scanList.map(t => t.symbol));

      let readyCount=0, attemptCount=0, successCount=0;

      const baseOverrides = riskToDials(riskLevel);
      const d = currentDials(baseOverrides);

      for (const asset of scanList) {
        const token = { ...asset, price:null, entryReady:false, error:null, time:new Date().toLocaleTimeString(), spreadBps:null, tpBps:null };
        if (STABLES.has(asset.symbol)) { results.push(token); continue; }

        try {
          const price = await getPriceUSD(asset.cc || asset.symbol);
          if (Number.isFinite(price)) token.price = price;

          const sig = await computeEntrySignal(asset, d, batchMap);
          token.entryReady = sig.entryReady;
          if (sig.entryReady) {
            token.spreadBps = sig.spreadBps ?? null;
            token.tpBps = sig.tpBps ?? null;
          }

          if (autoTrade && token.entryReady) {
            readyCount++; attemptCount++;
            const ok = await placeOrder(asset.symbol, asset.cc, d, sig, batchMap);
            if (ok) { successCount++; openCount++; }
          } else {
            if (sig.entryReady) readyCount++;
            logTradeAction('entry_skipped', asset.symbol, { entryReady: token.entryReady });
          }
        } catch (err) {
          token.error = err?.message || String(err);
          logTradeAction('scan_error', asset.symbol, { error: token.error });
        }
        results.push(token);
      }

      logTradeAction('scan_summary', 'ALL', { readyCount, attemptCount, successCount });
    } catch (e) {
      logTradeAction('scan_error','ALL',{error:e.message||String(e)});
    } finally {
      if (!Array.isArray(results) || results.length===0) {
        results = tracked.map(t => ({ ...t, price:null, entryReady:false, error:'no-data', time:new Date().toLocaleTimeString(), spreadBps:null, tpBps:null }));
      }
      setData(results.sort((a,b)=>a.symbol.localeCompare(b.symbol)));
      setLastScanAt(Date.now());
      setRefreshing(false); setIsLoading(false);
      scanningRef.current = false;
    }
  };

  // periodic scan
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (!stopped) await loadData();
      if (!stopped) setTimeout(tick, SCAN_MS);
    };

    (async () => {
      await getAccountSummary();
      try {
        const res = await f(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
        const account = await res.json();
        console.log('[ALPACA CONNECTED]', account.account_number, 'Equity:', account.equity);
        showNotification('✅ Connected to Alpaca');
      } catch (err) {
        console.error('[ALPACA CONNECTION FAILED]', err);
        showNotification('❌ Alpaca API Error');
      }
      await loadData();
      setTimeout(tick, SCAN_MS);
    })();

    return () => { stopped = true; };
  }, []);

  // risk → dials; force immediate rescan on change
  useEffect(() => {
    const overrides = riskToDials(riskLevel);
    setDialsOverride(overrides);
    const eff = currentDials(overrides);
    logTradeAction('risk_changed','ALL',{level:riskLevel, ...eff});
    if (lastScanAt !== null) { setRefreshing(true); loadData(); }
  }, [riskLevel]); // eslint-disable-line react-hooks/exhaustive-deps

  // === Refresh PnL panel on boot and every ~15 minutes (monitoring only)
  useEffect(() => {
    let timer = null, stopped = false;
    const run = async () => {
      try {
        const s = await getPnLAndFeesSnapshot();
        if (!stopped) setPnlSnap({ ...s, updatedAt: new Date().toISOString(), error: null });
      } catch (e) {
        if (!stopped) setPnlSnap(p => ({ ...p, error: e?.message || String(e) }));
      } finally {
        if (!stopped) timer = setTimeout(run, 15*60*1000);
      }
    };
    run();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  const onRefresh = () => { setRefreshing(true); loadData(); };

  // ===== Derived display =====
  const bySymbol = (a,b) => a.symbol.localeCompare(b.symbol);
  const entryReadyTokens = (data||[]).filter((t)=>t.entryReady).sort(bySymbol);
  const watchlistTokens  = (data||[]).filter((t)=>!t.entryReady).sort(bySymbol);

  const bp = acctSummary.buyingPower, chPct = acctSummary.dailyChangePct;
  const statusColor = !lastScanAt ? '#666' : (Date.now() - lastScanAt < (SCAN_MS * 1.5) ? '#57e389' : '#ffd166');

  // ===== UI =====
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={[styles.container, darkMode && styles.containerDark]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header (added safe top margin, title simplified) */}
        <View style={styles.header}>
          <View style={styles.headerTopRow}>
            <View style={[styles.statusDot,{backgroundColor:statusColor}]} />
            <Text style={[styles.appTitle, darkMode && styles.titleDark]}>Bullish or Bust</Text>
            <Text style={styles.versionTag}>{VERSION}</Text>
          </View>
          <Text style={styles.subTitle}>Open {openMeta.positions}/{openMeta.allowed} • Orders {openMeta.orders}</Text>
          {notification && (<View style={styles.topBanner}><Text style={styles.topBannerText}>{notification}</Text></View>)}
        </View>

        {/* Controls + Buying Power on one line */}
        <View style={[styles.toolbar, darkMode && styles.toolbarDark]}>
          <View style={styles.topControlRow}>
            <TouchableOpacity onPress={onRefresh} style={[styles.pillToggle, styles.pillNeutral]}>
              <Text style={styles.pillText}>Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={cancelAllOrders} style={[styles.pillToggle, styles.btnWarn]}>
              <Text style={styles.pillText}>Cancel Orders</Text>
            </TouchableOpacity>

            <View style={styles.inlineBP}>
              <Text style={[styles.bpLabel, darkMode && styles.titleDark]}>Buying Power</Text>
              <Text style={[styles.bpValue, darkMode && styles.titleDark]}>
                {fmtUSD(bp)} {isUpdatingAcct && <Text style={styles.badgeUpdating}>↻</Text>}
                <Text style={styles.dot}> • </Text><Text style={styles.dayBadge}>Day {fmtPct(chPct)}</Text>
              </Text>
            </View>
          </View>
        </View>

        {/* Risk bar on its own line */}
        <View style={[styles.toolbar, darkMode && styles.toolbarDark, { marginTop: -6 }]}>
          <View style={styles.pillRow}>
            <Text style={styles.pillText}>Risk</Text>
            <RiskChooser value={riskLevel} onChange={setRiskLevel} />
          </View>
        </View>

        {/* ================= PnL & Fees panel (monitoring only) ================= */}
        <View style={[styles.toolbar, darkMode && styles.toolbarDark]}>
          <Text style={styles.sectionHeader}>📉 PnL & Fees</Text>
          {pnlSnap.error ? (
            <Text style={styles.noData}>Error: {pnlSnap.error}</Text>
          ) : (
            <View style={styles.pnlRow}>
              <View style={styles.pnlBox}>
                <Text style={styles.pnlLabel}>Last 7d P/L</Text>
                <Text style={styles.pnlValue}>
                  {Number.isFinite(pnlSnap.last7Sum) ? fmtUSD(pnlSnap.last7Sum) : '—'}
                </Text>
                <Text style={styles.pnlTiny}>
                  {Number.isFinite(pnlSnap.last7UpDays) ? `${pnlSnap.last7UpDays} up` : '—'} • {Number.isFinite(pnlSnap.last7DownDays) ? `${pnlSnap.last7DownDays} down` : '—'}
                </Text>
              </View>

              <View style={styles.pnlBox}>
                <Text style={styles.pnlLabel}>Last 30d P/L</Text>
                <Text style={styles.pnlValue}>
                  {Number.isFinite(pnlSnap.last30Sum) ? fmtUSD(pnlSnap.last30Sum) : '—'}
                </Text>
                <Text style={styles.pnlTiny}>
                  {Number.isFinite(pnlSnap.fillsCount30) ? `${pnlSnap.fillsCount30} fills` : '—'}
                </Text>
              </View>

              <View style={styles.pnlBox}>
                <Text style={styles.pnlLabel}>Fees (30d)</Text>
                <Text style={styles.pnlValue}>
                  {Number.isFinite(pnlSnap.fees30) ? fmtUSD(pnlSnap.fees30) : '—'}
                </Text>
                <Text style={styles.pnlTiny}>
                  {pnlSnap.updatedAt ? new Date(pnlSnap.updatedAt).toLocaleString() : ''}
                </Text>
              </View>
            </View>
          )}
        </View>
        {/* ================= END PnL & Fees panel ================= */}

        {/* Entry Ready / Watch */}
        <Text style={styles.sectionHeader}>✅ Entry Ready</Text>
        {entryReadyTokens.length>0 ? (<View style={styles.cardGrid}>{entryReadyTokens.map(renderCard)}</View>) : (<Text style={styles.noData}>No Entry Ready tokens</Text>)}

        <Text style={styles.sectionHeader}>🟧 Watchlist</Text>
        {watchlistTokens.length>0 ? (<View style={styles.cardGrid}>{watchlistTokens.map(renderCard)}</View>) : (<Text style={styles.noData}>No Watchlist tokens</Text>)}

        {/* Log */}
        <View style={[styles.logPanelTop, darkMode && { backgroundColor: '#1e1e1e' }]}>
          <Text style={styles.logTitle}>Running Log</Text>
          {logHistory.length===0 ? (
            <Text style={styles.logTextMuted}>No recent events yet…</Text>
          ) : (
            logHistory.map((l, i) => (
              <View key={i} style={styles.logRow}>
                <Text style={[styles.sevBadge, l.sev==='success'&&styles.sevSuccess, l.sev==='warn'&&styles.sevWarn, l.sev==='error'&&styles.sevError]}>{l.sev.toUpperCase()}</Text>
                <Text style={styles.logText} numberOfLines={2}>{l.text}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ===================== Small UI bits =====================
function renderCard(asset) {
  const borderColor = asset.entryReady ? '#1fa41f' : '#FFA500';
  const cardStyle = [ styles.card, { borderLeftColor: borderColor }, !asset.entryReady && styles.cardWatchlist ];
  // show symbol + price + compact metrics (no READY/WATCH labels)
  const spreadTxt = asset.spreadBps != null ? `${asset.spreadBps.toFixed(1)} bps` : '—';
  const tpTxt = asset.tpBps != null ? `TP +${asset.tpBps} bps` : '';
  return (
    <View key={asset.symbol} style={cardStyle}>
      <Text style={styles.symbol} numberOfLines={1}>{asset.symbol}</Text>
      {asset.price != null && <Text style={styles.smallText}>${asset.price.toFixed(5)}</Text>}
      <Text style={styles.miniMeta} numberOfLines={1}>{spreadTxt}{tpTxt ? ` • ${tpTxt}` : ''}</Text>
    </View>
  );
}

function RiskChooser({ value, onChange }) {
  const steps = [0,1,2,3,4];
  return (
    <View style={styles.riskRow}>
      {steps.map((s) => (
        <TouchableOpacity key={s} onPress={()=>onChange(s)} activeOpacity={0.7} style={[styles.riskDot, value===s && styles.riskDotActive]}>
          <Text style={styles.riskDotText}>{s===0?'🙂':s===4?'🔥':'•'}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ===================== Styles =====================
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#121212' }, // Safe area wrapper (prevents notch overlap)
  container: { flexGrow: 1, paddingTop: 8, paddingHorizontal: 10, backgroundColor: '#fff' }, // reduced top padding; SafeAreaView adds the rest
  containerDark: { backgroundColor: '#121212' },

  header: { alignItems: 'center', justifyContent: 'center', marginBottom: 6, marginTop: 6 },
  headerTopRow: { flexDirection:'row', alignItems:'center', gap:6 },
  statusDot: { width:8, height:8, borderRadius:4, marginRight:6 },
  appTitle: { fontSize: 16, fontWeight: '800', color: '#000' },
  versionTag: { marginLeft:8, color:'#90caf9', fontWeight:'800', fontSize:10 },
  subTitle: { marginTop:2, fontSize:11, color:'#9aa0a6' },
  titleDark: { color: '#fff' },
  topBanner: { marginTop:6, paddingVertical:6, paddingHorizontal:10, backgroundColor:'#243b55', borderRadius:8, width:'100%' },
  topBannerText:{ color:'#fff', textAlign:'center', fontWeight:'700', fontSize:12 },

  // Toolbar rows
  toolbar: { backgroundColor:'#f2f2f2', padding:6, borderRadius:8, marginBottom:8 },
  toolbarDark: { backgroundColor:'#1b1b1b' },

  topControlRow: { flexDirection:'row', alignItems:'center', flexWrap:'wrap', gap:8, justifyContent:'space-between' },
  pillRow: { flexDirection:'row', alignItems:'center', flexWrap:'wrap', gap:8 },

  pillToggle: { backgroundColor:'#2b2b2b', paddingVertical:6, paddingHorizontal:8, borderRadius:8 },
  pillNeutral:{ backgroundColor:'#3a3a3a' },
  btnWarn: { backgroundColor:'#6b5e23' },
  pillText:{ color:'#fff', fontSize:11, fontWeight:'800' },

  inlineBP: { flexDirection:'row', alignItems:'center', gap:8, marginLeft:'auto' },
  bpLabel: { fontSize:11, fontWeight:'600', color: '#bbb' },
  bpValue: { fontSize:13, fontWeight:'800', color:'#e6f0ff' },
  dot: { color: '#999', fontWeight:'800' },
  dayBadge: { fontWeight:'800' },
  badgeUpdating: { fontSize:10, color:'#bbb', fontWeight:'600' },

  // --- PnL Panel ---
  pnlRow: { flexDirection:'row', gap:8, justifyContent:'space-between' },
  pnlBox: { flex:1, backgroundColor:'#141414', borderRadius:8, padding:10, borderWidth:1, borderColor:'#2a2a2a' },
  pnlLabel: { fontSize:11, color:'#aaa', fontWeight:'700', marginBottom:2 },
  pnlValue: { fontSize:15, color:'#e6f0ff', fontWeight:'800' },
  pnlTiny: { fontSize:10, color:'#9aa0a6', marginTop:2 },

  // Cards & lists
  cardGrid: { flexDirection:'row', flexWrap:'wrap', justifyContent:'space-between' },
  card: { width:'24%', backgroundColor:'#181818', padding:8, borderRadius:6, borderLeftWidth:4, marginBottom:8 },
  cardWatchlist: { borderColor:'#FFA500', borderWidth:1 },
  symbol: { fontSize:12, fontWeight:'800', color:'#e0f2ff' },
  smallText: { fontSize:11, color:'#ddd' },
  miniMeta: { fontSize:10, color:'#c7c7c7', marginTop:2 },

  noData: { textAlign:'center', marginTop:8, fontStyle:'italic', color:'#777' },

  sectionHeader: { fontSize:14, fontWeight:'bold', marginBottom:6, marginTop:8, color:'#cfd8dc' },

  logPanelTop: { backgroundColor:'#222', padding:10, borderRadius:8, marginBottom:8 },
  logTitle: { color:'#fff', fontSize:13, fontWeight:'700', marginBottom:6 },
  logRow: { flexDirection:'row', alignItems:'center', marginBottom:4, flexWrap:'wrap' },
  sevBadge: { fontSize:10, color:'#111', backgroundColor:'#9e9e9e', paddingHorizontal:6, paddingVertical:2, borderRadius:6, marginRight:6, fontWeight:'800' },
  sevSuccess:{ backgroundColor:'#8be78b' },
  sevWarn:   { backgroundColor:'#ffd166' },
  sevError:  { backgroundColor:'#ff6b6b' },
  logText: { color:'#fff', fontSize:12, flexShrink:1, maxWidth:'82%' },

  // risk chooser
  riskRow: { flexDirection:'row', alignItems:'center', gap:6 },
  riskDot: { width:24, height:24, borderRadius:12, borderWidth:1, borderColor:'#666', backgroundColor:'#1b1b1b', alignItems:'center', justifyContent:'center' },
  riskDotActive: { borderColor:'#57e389', backgroundColor:'#122d12' },
  riskDotText: { fontSize:12, color:'#bbb' },
});
