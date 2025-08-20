import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';

/*
* Bullish or Bust! — Presets + smarter risk/flow control
* A (Crash-Safe), B (Neutral), C (Aggressive default)
*
* Adds:
* - Regime gates (BTC & ETH trend up on 15m+1h) + Anchored VWAP gate (price>VWAP, slope up)
* - Crashometer kill-switch (BTC 1m z<-2.5 OR ATR15m > 1.5× median TR) → flatten + cooldown
* - Relative Strength gate (symbol ROC15m - BTC ROC15m > +0.10%)
* - Anti-chase: if +0.35% in last 2m, halve buy slippage cap
* - Fast-wrong exit within 2m (≤ -0.35% or 1m close < entry - 0.4×ATR_1m)
* - Partial take-profit then runner with ATR trail; immediate BE+fees after partial
* - Faster TP decay; tighter BE/trail thresholds per preset
* - VWAP exit: 2 consecutive 1m closes below Anchored VWAP (loss capped ≈ one-side fees+slip)
* - Portfolio brakes: day kill (-0.8% equity), 3-loss sequence kill (60m), concurrency caps
* - Per-symbol cooldown after exit
*
* NOTE: Keeps your ring buffer logs and UI. No alerts/popups added.
*/

// ==================== API CONFIG ====================
const ALPACA_KEY = 'AKS3TBCTY4CFZ2LBK2GZ';
const ALPACA_SECRET = 'fX1QUAM5x8FGeGcEneIrgTCQXRSwcZnoaxHC6QXM';
const ALPACA_BASE_URL = 'https://api.alpaca.markets/v2';
const DATA_BASE = 'https://data.alpaca.markets/v1beta3/crypto/us';

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json',
};

// ===== Fees, slippage & edge =====
const FEE_PER_SIDE_PCT = 0.0025;                 // 0.25% per side (taker assumption)
const ROUND_TRIP_PCT   = 2 * FEE_PER_SIDE_PCT;   // ~0.50%
const TINY_EDGE_PCT    = 0.0005;                 // +0.05% over costs
const BASE_SLIPPAGE_BPS = 20;                    // 0.20%
const SLIPPAGE_PCT = BASE_SLIPPAGE_BPS / 10000;

// IOC buy controls (base; presets can override effective cap)
const MAX_SPREAD_PCT = 0.0015;   // 0.15%
const BUY_SLIP_CAP_PCT_BASE = 0.0020; // 0.20% (upper ceiling)

// TP cushion
const TP_CUSHION = 1.02;
const CRYPTO_TIME_IN_FORCE = 'gtc';

// ===== Quote fallback & spread soft-override =====
const ALLOW_SYNTHETIC_QUOTE = true;
const SYNTH_SPREAD_PCT = 0.0020;
const RELAX_SPREAD_FACTOR = 2.0;

// ===== Hard caps =====
const ABS_MAX_NOTIONAL_USD = 85;
const PER_SYMBOL_MAX = {
  SHIBUSD: 50, DOGEUSD: 70, XRPUSD: 80, ADAUSD: 70, AVAXUSD: 85, LTCUSD: 85, BCHUSD: 85,
  SOLUSD: 85, ETHUSD: 85, BTCUSD: 85, AAVEUSD: 85, UNIUSD: 85, LINKUSD: 85, MATICUSD: 80,
  ETCUSD: 80, TRXUSD: 70, USDTUSD: 0, USDCUSD: 0,
};

// ===== Presets =====
const PRESETS = {
  A: { // Crash-Safe
    name: 'Crash-Safe',
    buySlipCapPct: 0.0010,               // 0.10%
    decayStartMins: 1.5,
    decayFullMins: 6,
    breakevenAfterKatr: 0.4,
    trailKatr: 0.5,
    partial: { fraction: 0.50, extraGrossPct: 0.0030 }, // +0.30% gross over fees/slip
    maxConcurrentBase: 1,
    maxConcurrentIfCalm: 2,              // when |zBTC| < 1
    cooldownMinutesAfterCrash: 45,
    regime: { requireBTCETHTrend: true, requireVWAP: true, requireVWAPSlopeUp: true },
    rsGateBps: 10,                       // +0.10%
    antiChaseImpulseBps: 35,             // +0.35%/2m
    fastWrong: { tinyLossPct: 0.0035, atr1mK: 0.4, windowMins: 2 },
    reentryCooldownMins: 20,
    vwapExitTwoCloses: true,
    allowFirstReclaim: false,
  },
  B: { // Neutral
    name: 'Neutral',
    buySlipCapPct: 0.0015,               // 0.15%
    decayStartMins: 2,
    decayFullMins: 8,
    breakevenAfterKatr: 0.5,
    trailKatr: 0.6,
    partial: { fraction: 0.40, extraGrossPct: 0.0025 },
    maxConcurrentBase: 2,
    maxConcurrentIfCalm: 2,
    cooldownMinutesAfterCrash: 30,
    regime: { requireBTCETHTrend: true, requireVWAP: true, requireVWAPSlopeUp: true },
    rsGateBps: 10,
    antiChaseImpulseBps: 35,
    fastWrong: { tinyLossPct: 0.0035, atr1mK: 0.4, windowMins: 2 },
    reentryCooldownMins: 15,
    vwapExitTwoCloses: true,
    allowFirstReclaim: false,
  },
  C: { // Aggressive (default)
    name: 'Aggressive',
    buySlipCapPct: 0.0015,               // 0.15% base; halves on anti-chase
    decayStartMins: 1.5,
    decayFullMins: 6,
    breakevenAfterKatr: 0.4,
    trailKatr: 0.5,                      // faster trailing
    partial: { fraction: 0.30, extraGrossPct: 0.0020 }, // +0.20%
    maxConcurrentBase: 3,
    maxConcurrentIfCalm: 3,
    cooldownMinutesAfterCrash: 10,       // 8–12m → choose 10m
    regime: { requireBTCETHTrend: true, requireVWAP: true, requireVWAPSlopeUp: true },
    rsGateBps: 10,
    antiChaseImpulseBps: 35,
    fastWrong: { tinyLossPct: 0.0035, atr1mK: 0.4, windowMins: 2 },
    reentryCooldownMins: 10,
    vwapExitTwoCloses: true,
    allowFirstReclaim: true,             // allow first clean VWAP reclaim
  },
};

// ===== Strategy Config (base math – unchanged where not overridden) =====
const CFG_BASE = {
  vol:   { lookbackBars: 20, minSigma: 0.0008 },
  z:     { lookbackBars: 20, minAbsZ: 0.3 },
  macd:  { fast: 12, slow: 26, signal: 9, minHistSlopeBars: 1 },
  trend: { emaFast: 50, emaSlow: 200, requireUp: false },
  rsi:   { length: 14 },
  micro: {
    breakoutN: 5, volBurstL: 30, volBurstK: 1.2,
    macd: { fast: 8, slow: 17, sig: 5 },
    rsiLen: 7, rsiSurgeDelta: 3,
    impulseBps: 5,
    lookbackLimit: 150,
  },
  weights: { macdSlope: 0.3, trendAlign: 0.3, rsiCtx: 0.4 },
  minScore: 20,
  gating: { minPassCount: 0 },
  risk: {
    riskPerTradePctEquity: 0.25,
    atrLen: 14,
    atrKStop: 1.5,
    maxPosPctEquity: 15,
    minNotionalUSD: 5,
    useNonMarginableBP: true,
    minEdgeBps: 20,
  },
  exits: {
    tpKatr: 0.9,
    tpMinBps: 60,
    trailKatr: 0.6,            // overridden by preset
    breakevenAfterKatr: 0.7,   // overridden by preset
    limitReplaceSecs: 30,
    markRefreshSecs: 5,
    timeStopMins: 30,
    maxHoldMinsAbs: 12,
    decayStartMins: 3,         // overridden by preset
    decayFullMins: 12,         // overridden by preset
    fadeGraceMins: 6,
  },
  scanSecs: 10,
};

let perSymbolFundsLock = {};
let logSubscriber = null;
let logBuffer = [];
const MAX_LOGS = 200;

// ===== Universe =====
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

// ============== Utilities ==============
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmtUSD = (n) => Number.isFinite(n) ? `$ ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
const fmtPct = (n) => Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
const fmtUSDSimple = (n) => Number.isFinite(n) ? `$ ${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
const fmtUSDSigned = (n) => Number.isFinite(n) ? `${n >= 0 ? '+' : '-'}$ ${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
function shuffleArray(arr) { const a = arr.slice(); for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function toDataSymbol(sym){ if(!sym)return sym; if(sym.includes('/'))return sym; if(sym.endsWith('USD'))return sym.slice(0,-3)+'/USD'; return sym; }

export const registerLogSubscriber = (fn) => { logSubscriber = fn; };
const logTradeAction = async (type, symbol, details = {}) => {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, symbol, ...details };
  logBuffer.push(entry); if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  console.log('[TRADE LOG]', entry);
  if (typeof logSubscriber === 'function') { try { logSubscriber(entry); } catch (err) {} }
};

// ============== Math helpers ==============
const emaArr = (arr, span) => { if (!arr?.length) return []; const k = 2/(span+1); let prev=arr[0]; const out=[prev]; for(let i=1;i<arr.length;i++){prev=arr[i]*k+prev*(1-k); out.push(prev);} return out; };
const stdDev = (arr) => { const n=arr.length; if(n<2)return 0; const m=arr.reduce((a,b)=>a+b,0)/n; const v=arr.reduce((s,x)=>s+(x-m)**2,0)/(n-1); return Math.sqrt(v); };
const calcATR = (bars, len=14) => { if (!Array.isArray(bars)||bars.length<len+1) return null; const tr=[]; for (let i=1;i<bars.length;i++){ const h=bars[i].high, l=bars[i].low, cPrev=bars[i-1].close; tr.push(Math.max(h-l, Math.abs(h-cPrev), Math.abs(l-cPrev))); } return emaArr(tr, len).slice(-1)[0]; };
const calcATRSeries = (bars, len=14) => { if (!Array.isArray(bars)||bars.length<len+1) return []; const tr=[]; for (let i=1;i<bars.length;i++){ const h=bars[i].high, l=bars[i].low, cPrev=bars[i-1].close; tr.push(Math.max(h-l, Math.abs(h-cPrev), Math.abs(l-cPrev))); } return emaArr(tr, len); };
const median = (arr) => { const a=arr.slice().sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length? (a.length%2?a[m]:(a[m-1]+a[m])/2) : 0; };

const zScore = (closes, L=20) => { if (!closes || closes.length<L) return 0; const s=closes.slice(-L); const mu=s.reduce((a,b)=>a+b,0)/L; const sd=stdDev(s); return sd===0?0:(s[s.length-1]-mu)/sd; };
const logRetSigma = (closes, L=20) => { if (!closes || closes.length<L+1) return 0; const last=closes.slice(-(L+1)); const rets=[]; for(let i=1;i<last.length;i++) rets.push(Math.log(last[i]/last[i-1])); return stdDev(rets); };

const calcMACDFull = (closes, fast=12, slow=26, sig=9) => {
  if (!closes || closes.length < slow + sig) return null;
  const emaFast = emaArr(closes, fast);
  const emaSlow = emaArr(closes, slow);
  const macdLine = emaFast.map((v,i)=>v-emaSlow[i]);
  const signal = emaArr(macdLine, sig);
  const hist = macdLine.map((v,i)=>v-signal[i]);
  return { macd: macdLine.slice(-1)[0], signal: signal.slice(-1)[0], histArr: hist };
};
const macdHistSlopeIncreasing = (histArr, k=2) => { if (!histArr || histArr.length<k+1) return false; const h=histArr.slice(-(k+1)); for (let i=1;i<h.length;i++) if (!(h[i]>h[i-1])) return false; return true; };
const emaTrendOK = (closes, fast=50, slow=200) => { if (!closes || closes.length<slow) return false; const ef=emaArr(closes, fast).slice(-1)[0]; const es=emaArr(closes, slow).slice(-1)[0]; return ef>es; };
const emaSlopeUp = (closes, fast=50, span=5) => { if(!closes || closes.length<fast+span) return false; const e=emaArr(closes, fast); const last=e.length-1; return e[last]>e[last-span]; };

const calcRSI = (closes, period=14) => {
  if (!Array.isArray(closes) || closes.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=1;i<=period;i++){ const d=closes[i]-closes[i-1]; if (d>0) gains+=d; else losses-=d; }
  const avgGain=gains/period, avgLoss=losses/period;
  if (avgLoss===0) return 100;
  const rs=avgGain/avgLoss;
  return 100-100/(1+rs);
};

const getTrendSymbol = (closes) => {
  if (!Array.isArray(closes) || closes.length < 15) return '🟰';
  const x=Array.from({length:15},(_,i)=>i), y=closes.slice(-15);
  const sumX=x.reduce((a,b)=>a+b,0), sumY=y.reduce((a,b)=>a+b,0);
  const sumXY=x.reduce((s,xi,i)=>s+xi*y[i],0), sumX2=x.reduce((s,xi)=>s+xi*xi,0);
  const slope=(15*sumXY - sumX*sumY)/(15*sumX2 - sumX*sumX);
  return slope>0.02 ? '⬆️' : slope<-0.02 ? '⬇️' : '🟰';
};

const rsiContextScore = (rsi) => { if (rsi==null) return 50; if (rsi<25 || rsi>80) return 20; if (rsi>=45 && rsi<=60) return 100; if (rsi>=35 && rsi<=70) return 70; return 50; };
const compositeScore = ({ macdSlope, trendOK, rsiVal }, w) => {
  const parts = { macdSlope: macdSlope?100:0, trendAlign: trendOK?100:0, rsiCtx: rsiContextScore(rsiVal) };
  const num = parts.macdSlope*w.macdSlope + parts.trendAlign*w.trendAlign + parts.rsiCtx*w.rsiCtx;
  const den = w.macdSlope + w.trendAlign + w.rsiCtx; return (num/den);
};

// ============== Data Fetchers ==============
async function f(url, opts={}, timeoutMs=8000, retries=2){
  for (let i=0;i<=retries;i++){
    const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),timeoutMs);
    try{
      const res=await fetch(url,{...opts,signal:ac.signal}); clearTimeout(timer);
      if (res.status===429 || res.status>=500){ if(i===retries) return res; const wait=500*Math.pow(2,i); await sleep(wait); continue; }
      return res;
    }catch(e){ clearTimeout(timer); if (i===retries) throw e; await sleep(300*Math.pow(2,i)); }
  }
  return fetch(url,opts);
}

const getPriceUSD = async (ccOrSymbol) => { const r=await f(`https://min-api.cryptocompare.com/data/price?fsym=${ccOrSymbol}&tsyms=USD`); const j=await r.json(); return parseFloat(j?.USD ?? 'NaN'); };
const getBars15m = async (cc, limit=220) => { const r=await f(`https://min-api.cryptocompare.com/data/v2/histominute?fsym=${cc}&tsym=USD&limit=${limit}&aggregate=15`); const j=await r.json(); const arr=Array.isArray(j?.Data?.Data)?j.Data.Data:[]; return arr.map(b=>({open:b.open,high:b.high,low:b.low,close:b.close,vol:(typeof b.volumefrom==='number'?b.volumefrom:(b.volumeto??0))})); };
const getBars1m = async (cc, limit=150) => { const r=await f(`https://min-api.cryptocompare.com/data/v2/histominute?fsym=${cc}&tsym=USD&limit=${limit}&aggregate=1`); const j=await r.json(); const arr=Array.isArray(j?.Data?.Data)?j.Data.Data:[]; return arr.map(b=>({open:b.open,high:b.high,low:b.low,close:b.close,vol:(typeof b.volumefrom==='number'?b.volumefrom:(b.volumeto??0))})); };
const getBars60m = async (cc, limit=200) => { const r=await f(`https://min-api.cryptocompare.com/data/v2/histohour?fsym=${cc}&tsym=USD&limit=${limit}&aggregate=1`); const j=await r.json(); const arr=Array.isArray(j?.Data?.Data)?j.Data.Data:[]; return arr.map(b=>({open:b.open,high:b.high,low:b.low,close:b.close,vol:(typeof b.volumefrom==='number'?b.volumefrom:(b.volumeto??0))})); };

function minutesSinceUtcMidnight(){
  const now=new Date(); const utcNow=Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), 0);
  const dayStart=Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0);
  return Math.max(1, Math.floor((utcNow - dayStart)/60000));
}
const VWAP_ANCHOR_MAX_MIN = 900; // cap to 15h to limit payload

const getBars1mSinceUTC0 = async (cc) => {
  const mins=Math.min(1440, Math.min(minutesSinceUtcMidnight(), VWAP_ANCHOR_MAX_MIN));
  const r=await f(`https://min-api.cryptocompare.com/data/v2/histominute?fsym=${cc}&tsym=USD&limit=${mins}&aggregate=1`);
  const j=await r.json(); const arr=Array.isArray(j?.Data?.Data)?j.Data.Data:[];
  return arr.map(b=>({open:b.open,high:b.high,low:b.low,close:b.close,vol:(typeof b.volumefrom==='number'?b.volumefrom:(b.volumeto??0))}));
};

async function getQuote(symbol) {
  try {
    const dataSym = toDataSymbol(symbol);
    const url = `${DATA_BASE}/latest/quotes?symbols=${encodeURIComponent(dataSym)}`;
    const r = await f(url, { headers: HEADERS });
    if (!r.ok) { const body=await r.text(); logTradeAction('quote_http_error', symbol, { status:r.status, body:body?.slice(0,180)}); return null; }
    const j = await r.json(); const q = j?.quotes?.[dataSym]?.[0];
    if (!q) { logTradeAction('quote_empty', symbol, { dataSym }); return null; }
    const bid=Number(q.bp), ask=Number(q.ap);
    if (!(bid>0 && ask>0)) { logTradeAction('quote_invalid', symbol, { bid, ask }); return null; }
    return { bid, ask };
  } catch (e) { logTradeAction('quote_exception', symbol, { error:e.message }); return null; }
}
function makeSyntheticQuote(mid){ if(!Number.isFinite(mid)||mid<=0) return null; const half=(SYNTH_SPREAD_PCT/2)*mid; return { bid: mid-half, ask: mid+half }; }

// ===== Micro helpers =====
function macdCrossUp1m(closes){ const m=calcMACDFull(closes, 8,17,5); if(!m) return false; const mPrev=calcMACDFull(closes.slice(0,-1),8,17,5); return mPrev && mPrev.macd<=mPrev.signal && m.macd>m.signal; }
function macdUpish(m){ if(!m) return false; const cross=m.macd>m.signal; const histUp=m.histArr && m.histArr.length>=3 && m.histArr.slice(-3).every((v,i,a)=>i===0||v>a[i-1]); return cross||histUp; }
function rsiSurgeOK(closes,len=7,delta=3){ const rNow=calcRSI(closes,len); const rPrev3=calcRSI(closes.slice(0,-3),len); if(rNow==null || rPrev3==null) return false; return (rNow - rPrev3) >= delta; }
function impulseOK(closes,bps=5){ const n=closes.length; if(n<3) return false; const p2=closes[n-3], p0=closes[n-1]; const ret=(p0-p2)/p2; return (ret*10000) >= bps; }
function microBreakoutOK(bars1m,N){ if(!Array.isArray(bars1m)||bars1m.length<N+1) return false; const highs=bars1m.map(b=>b.high); const closes=bars1m.map(b=>b.close); const i=bars1m.length-1; const priorHighs=highs.slice(i-N, i); return closes[i] > Math.max(...priorHighs); }
function volBurstOK(bars1m,L,K){ if(!Array.isArray(bars1m)||bars1m.length<L+1) return false; const vols=bars1m.map(b=>b.vol); const last=vols[vols.length-1]; const base=vols.slice(vols.length-1-L, vols.length-1); const avg=base.reduce((a,v)=>a+v,0)/base.length; return avg>0 && last >= K*avg; }
function emaAbove(bars1m,fast=9,slow=21){ const closes=bars1m.map(b=>b.close); if(closes.length<slow) return false; const efast=emaArr(closes,fast).slice(-1)[0]; const eslow=emaArr(closes,slow).slice(-1)[0]; return efast!=null && eslow!=null && efast>eslow; }
function microTriggerOK(bars1m){ if(!Array.isArray(bars1m)||bars1m.length<35) return false; const closes=bars1m.map(b=>b.close);
  const checks=[ microBreakoutOK(bars1m,5), volBurstOK(bars1m,30,1.2), macdCrossUp1m(closes),
                 rsiSurgeOK(closes,7,3), impulseOK(closes,5), emaAbove(bars1m,9,21) ];
  return checks.filter(Boolean).length >= 2;
}

// ============== Trade/Exit State ==============
const tradeState = {}; // { [symbol]: { entry, atrAtEntry, peak, stop, tp, tp0, lastLimitPostTs, entryTs, partialDone, belowVwapCount } }
let globalCooldownUntil = 0;
let dayKillUntil = 0;
const SEQ_LOSS_LOG = []; // timestamps of losing exits
let perSymbolCooldownUntil = {}; // {SYM: ts}

// ===== Account/positions helpers =====
const getPositionInfo = async (symbol) => {
  try {
    const res = await f(`${ALPACA_BASE_URL}/positions/${symbol}`, { headers: HEADERS });
    if (!res.ok) return null;
    const info = await res.json();
    const qty = parseFloat(info.qty ?? '0');
    const basis = parseFloat(info.avg_entry_price ?? 'NaN');
    const available = parseFloat(info.qty_available ?? info.available ?? info.qty ?? '0');
    const marketValue = parseFloat(info.market_value ?? 'NaN');
    const markFromMV = Number.isFinite(marketValue) && qty > 0 ? marketValue / qty : NaN;
    const markFallback = parseFloat(info.current_price ?? info.asset_current_price ?? 'NaN');
    const mark = Number.isFinite(markFromMV) ? markFromMV : (Number.isFinite(markFallback) ? markFallback : NaN);
    return {
      qty: Number.isFinite(qty) ? parseFloat(Number(qty).toFixed(6)) : 0,
      basis: Number.isFinite(basis) ? basis : null,
      available: Number.isFinite(available) ? available : 0,
      mark: Number.isFinite(mark) ? mark : null,
      unrealized_pl: parseFloat(info.unrealized_pl ?? 'NaN'),
    };
  } catch { return null; }
};
const getAllPositions = async () => {
  try {
    const res = await f(`${ALPACA_BASE_URL}/positions`, { headers: HEADERS });
    if (!res.ok) return [];
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
};
const getOpenOrders = async (symbol) => {
  try {
    const res = await f(`${ALPACA_BASE_URL}/orders?status=open&symbols=${symbol}`, { headers: HEADERS });
    if (!res.ok) return []; const data = await res.json(); return Array.isArray(data) ? data : [];
  } catch { return []; }
};
const cancelOpenOrders = async (symbol) => {
  try {
    const open = await getOpenOrders(symbol);
    await Promise.all(open.map((o)=>f(`${ALPACA_BASE_URL}/orders/${o.id}`,{method:'DELETE',headers:HEADERS}).catch(()=>null)));
    logTradeAction('cancel_open_orders', symbol, { count: open.length });
  } catch {}
};
const placeMarketSellAll = async (symbol) => {
  const pos = await getPositionInfo(symbol);
  if (!pos || pos.available <= 0) return;
  await cancelOpenOrders(symbol);
  const order = { symbol, qty: pos.available, side: 'sell', type: 'market', time_in_force: CRYPTO_TIME_IN_FORCE };
  try {
    const res = await f(`${ALPACA_BASE_URL}/orders`, { method:'POST', headers:HEADERS, body:JSON.stringify(order) });
    const raw = await res.text(); let data; try{ data=JSON.parse(raw);}catch{ data={raw}; }
    if (res.ok && data.id) logTradeAction('sell_all_success', symbol, { id:data.id, qty:pos.available });
    else logTradeAction('sell_all_failed', symbol, { status: res.status, raw: data });
  } catch (e) { logTradeAction('sell_all_error', symbol, { error: e.message }); }
};
const placeMarketSellQty = async (symbol, fraction=0.5) => {
  const pos = await getPositionInfo(symbol);
  if (!pos || pos.available <= 0) return false;
  const qty = Math.max(0, +(pos.qty * fraction).toFixed(6));
  if (qty <= 0) return false;
  await cancelOpenOrders(symbol);
  const order = { symbol, qty, side:'sell', type:'market', time_in_force: CRYPTO_TIME_IN_FORCE };
  try {
    const res = await f(`${ALPACA_BASE_URL}/orders`, { method:'POST', headers:HEADERS, body:JSON.stringify(order) });
    const raw = await res.text(); let data; try{ data=JSON.parse(raw);}catch{ data={raw}; }
    if (res.ok && data.id) { logTradeAction('partial_sell_success', symbol, { id:data.id, qty }); return true; }
    logTradeAction('partial_sell_failed', symbol, { status: res.status, raw: data }); return false;
  } catch(e){ logTradeAction('partial_sell_error', symbol, { error:e.message }); return false; }
};

const ensureLimitTP = async (symbol, limitPrice) => {
  const pos = await getPositionInfo(symbol);
  if (!pos || pos.available <= 0) return;
  const open = await getOpenOrders(symbol);
  const existing = open.find((o) => o.side==='sell' && o.type==='limit');
  const now = Date.now();
  const lastTs = tradeState[symbol]?.lastLimitPostTs || 0;
  const needsPost = !existing ||
    Math.abs(parseFloat(existing.limit_price)-limitPrice)/limitPrice > 0.001 ||
    now - lastTs > activeCFG.exits.limitReplaceSecs*1000;
  if (!needsPost) return;
  try {
    if (existing) await cancelOpenOrders(symbol);
    const order = { symbol, qty: pos.available, side:'sell', type:'limit', time_in_force: CRYPTO_TIME_IN_FORCE, limit_price: limitPrice.toFixed(5) };
    const res = await f(`${ALPACA_BASE_URL}/orders`, { method:'POST', headers:HEADERS, body:JSON.stringify(order) });
    const raw = await res.text(); let data; try{ data=JSON.parse(raw);}catch{ data={raw}; }
    if (res.ok && data.id) { tradeState[symbol]={...(tradeState[symbol]||{}), lastLimitPostTs: now}; logTradeAction('tp_limit_set', symbol, { id:data.id, limit:order.limit_price }); }
    else { logTradeAction('tp_limit_failed', symbol, { status: res.status, raw: data }); }
  } catch(e){ logTradeAction('tp_limit_error', symbol, { error:e.message }); }
};

// ===== Activities -> PnL/Fees (today) =====
async function getActivitiesToday() {
  const today=new Date(); const yyyy_mm_dd=today.toISOString().slice(0,10);
  const url = `${ALPACA_BASE_URL}/account/activities?activity_types=FILL,CFEE,FEE&date=${yyyy_mm_dd}`;
  try { const res=await f(url,{headers:HEADERS}); if(!res.ok) return null; const arr=await res.json(); return Array.isArray(arr)?arr:[]; } catch { return null; }
}
function computePnlFromActivities(acts){
  let buyUsd=0,sellUsd=0,feesUsd=0,fillsCount=0,cfeeSeen=false,feeSeen=false;
  for(const a of (acts||[])){
    const t=a.activity_type;
    if(t==='FILL'){ const side=(a.side||'').toLowerCase(); const qty=Math.abs(parseFloat(a.qty??'0')); const px=parseFloat(a.price??'NaN'); if(!Number.isFinite(qty)||!Number.isFinite(px)) continue; const usd=qty*px; if(side==='buy') buyUsd+=usd; else if(side==='sell') sellUsd+=usd; fillsCount++; }
    else if(t==='FEE'){ const n=parseFloat(a.net_amount??a.amount??'0'); if(Number.isFinite(n)){ feesUsd+=Math.abs(n); feeSeen=true;} }
    else if(t==='CFEE'){ const q=Math.abs(parseFloat(a.qty??'0')); const p=parseFloat(a.price??'NaN'); if(Number.isFinite(q)&&Number.isFinite(p)){ feesUsd+=q*p; cfeeSeen=true; } }
  }
  const volumeUsd=buyUsd+sellUsd; const realizedUsd=sellUsd-buyUsd-feesUsd; const effFeeBps=volumeUsd>0?(feesUsd/volumeUsd)*10000:null;
  return { realizedUsd, feesUsd, volumeUsd, effFeeBps, pendingFees:!(cfeeSeen||feeSeen)&&fillsCount>0 };
}
async function refreshPnlToday(setter) {
  const acts = await getActivitiesToday();
  if (!acts) { setter({ realizedUsd:null, feesUsd:null, volumeUsd:null, effFeeBps:null, pendingFees:false }); return; }
  const r = computePnlFromActivities(acts); setter(r);
}

// ============== Market Context (regime & crashometer) ==============
async function buildMarketContext() {
  // BTC and ETH trends (15m + 1h), BTC z-score (1m), BTC ATR15m vs median TR
  const [btc15, btc60, btc1, eth15, eth60] = await Promise.all([
    getBars15m('BTC', 240), getBars60m('BTC', 240), getBars1m('BTC', 90),
    getBars15m('ETH', 240), getBars60m('ETH', 240),
  ]);
  const btc15c = btc15.map(b=>b.close), btc60c=btc60.map(b=>b.close), btc1c=btc1.map(b=>b.close);
  const eth15c = eth15.map(b=>b.close), eth60c=eth60.map(b=>b.close);

  const btcTrend15 = emaTrendOK(btc15c, 50, 200) && emaSlopeUp(btc15c, 50, 5);
  const btcTrend60 = emaTrendOK(btc60c, 50, 200) && emaSlopeUp(btc60c, 50, 5);
  const ethTrend15 = emaTrendOK(eth15c, 50, 200) && emaSlopeUp(eth15c, 50, 5);
  const ethTrend60 = emaTrendOK(eth60c, 50, 200) && emaSlopeUp(eth60c, 50, 5);

  // BTC 1m return z-score over last 60 bars
  let zBTC = 0;
  if (btc1c.length >= 61) {
    const rets=[]; for(let i=1;i<btc1c.length;i++) rets.push(Math.log(btc1c[i]/btc1c[i-1]));
    const last60 = rets.slice(-60);
    const mu = last60.reduce((a,b)=>a+b,0)/last60.length;
    const sd = stdDev(last60);
    zBTC = sd>0 ? (last60[last60.length-1]-mu)/sd : 0;
  }

  // Crashometer: ATR15m now vs median TR (24 samples)
  let crashATR=false;
  if (btc15.length >= 30) {
    const atrSeries = calcATRSeries(btc15, 14);
    const atrNow = atrSeries.slice(-1)[0];
    const trRecent = [];
    for (let i=btc15.length-24;i<btc15.length;i++){
      if(i<=0) continue;
      const h=btc15[i].high, l=btc15[i].low, cp=btc15[i-1].close;
      trRecent.push(Math.max(h-l, Math.abs(h-cp), Math.abs(l-cp)));
    }
    const medTR = median(trRecent);
    if (medTR>0 && atrNow > 1.5*medTR) crashATR = true;
  }

  return {
    btcTrendUp: btcTrend15 && btcTrend60,
    ethTrendUp: ethTrend15 && ethTrend60,
    zBTC,
    crashATR,
    btcROC15m: (btc15c.length>=2) ? (btc15c[btc15c.length-1]/btc15c[btc15c.length-2] - 1) : 0,
  };
}

// ===== Helpers: caps, fees, expected net =====
function capNotional(symbol, proposed) {
  const symCap = PER_SYMBOL_MAX[symbol];
  const perSymbolCap = typeof symCap === 'number' ? symCap : ABS_MAX_NOTIONAL_USD;
  if (perSymbolCap === 0) return 0;
  return Math.max(0, Math.min(proposed, ABS_MAX_NOTIONAL_USD, perSymbolCap));
}
function expectedNetPct(entry, tp) {
  if (!Number.isFinite(entry) || !Number.isFinite(tp) || entry <= 0) return -Infinity;
  const gross = (tp - entry) / entry;
  const slip = SLIPPAGE_PCT;
  const net = gross - ROUND_TRIP_PCT - slip;
  return net;
}

// ==================== UI COMPONENT ====================
let activeCFG = JSON.parse(JSON.stringify(CFG_BASE)); // mutated from preset each tick

export default function App() {
  const [tracked] = useState(ORIGINAL_TOKENS);
  const [data, setData] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [darkMode] = useState(true);
  const autoTrade = true;
  const [notification, setNotification] = useState(null);
  const [logHistory, setLogHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const [acctSummary, setAcctSummary] = useState({ portfolioValue:null, dailyChangeUsd:null, dailyChangePct:null });
  const [pnlToday, setPnlToday] = useState({ realizedUsd:null, feesUsd:null, volumeUsd:null, effFeeBps:null, pendingFees:false });

  const intervalRef = useRef(null);
  const exitIntervalRef = useRef(null);

  const [presetKey, setPresetKey] = useState('C'); // default Aggressive
  const [marketCtx, setMarketCtx] = useState({ btcTrendUp:true, ethTrendUp:true, zBTC:0, crashATR:false, btcROC15m:0 });

  // Subscribe to logs + hydrate ring buffer
  useEffect(() => {
    registerLogSubscriber((entry)=> setLogHistory((prev)=>[entry,...prev].slice(0,12)));
    const seed = logBuffer.slice(-12).reverse(); if (seed.length) setLogHistory(seed);
  }, []);

  const showNotification = (message) => { setNotification(message); setTimeout(()=>setNotification(null), 5000); };

  // Account summary
  const getAccountSummary = async () => {
    try {
      const res = await f(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
      if (!res.ok) throw new Error(`Account ${res.status}`);
      const a = await res.json();
      const equity = parseFloat(a.equity ?? a.portfolio_value ?? 'NaN');
      const ref1 = parseFloat(a.last_equity ?? 'NaN');
      const ref2 = parseFloat(a.equity_previous_close ?? 'NaN');
      const ref = Number.isFinite(ref1) ? ref1 : (Number.isFinite(ref2) ? ref2 : NaN);
      const changeUsd = Number.isFinite(equity)&&Number.isFinite(ref)?(equity-ref):NaN;
      const changePct = Number.isFinite(changeUsd)&&ref>0?(changeUsd/ref)*100:NaN;
      setAcctSummary({ portfolioValue:Number.isFinite(equity)?equity:null, dailyChangeUsd:Number.isFinite(changeUsd)?changeUsd:null, dailyChangePct:Number.isFinite(changePct)?changePct:null });
    } catch { setAcctSummary({ portfolioValue:null, dailyChangeUsd:null, dailyChangePct:null }); }
  };

  // Apply preset → mutate activeCFG
  function applyPreset() {
    const p = PRESETS[presetKey];
    activeCFG = JSON.parse(JSON.stringify(CFG_BASE));
    activeCFG.exits.decayStartMins = p.decayStartMins;
    activeCFG.exits.decayFullMins  = p.decayFullMins;
    activeCFG.exits.breakevenAfterKatr = p.breakevenAfterKatr;
    activeCFG.exits.trailKatr = p.trailKatr;
  }

  // ====== BUY path with regime/RS/VWAP gates + anti-chase slip ======
  const placeOrder = async (symbol, ccSymbol=symbol, isManual=false, effectiveSlipCapPct=BUY_SLIP_CAP_PCT_BASE) => {
    const openOrders = await getOpenOrders(symbol);
    if (openOrders.length > 0) { logTradeAction('skip_open_orders', symbol, { openOrders }); return false; }

    const held = await getPositionInfo(symbol);
    if (held && Number(held.qty) > 0) { logTradeAction('skip_held_position', symbol, { heldQty: held.qty, basis: held.basis }); showNotification(`💼 Holding ${symbol} x${held.qty} — skip rebuy`); return false; }

    logTradeAction('buy_attempt', symbol, { isManual });

    try {
      const [price, bars15, bars1, q] = await Promise.all([
        getPriceUSD(ccSymbol),
        getBars15m(ccSymbol, 220),
        getBars1m(ccSymbol, activeCFG.micro.lookbackLimit),
        getQuote(symbol),
      ]);
      if (!Number.isFinite(price)) throw new Error('Invalid price');

      // Quotes
      let qFinal = q;
      if (!qFinal || !(qFinal.bid>0 && qFinal.ask>0)) {
        if (ALLOW_SYNTHETIC_QUOTE && Number.isFinite(price) && price>0) {
          qFinal = makeSyntheticQuote(price);
          if (qFinal) logTradeAction('quote_fallback_synth', symbol, { mid:price, bid:qFinal.bid, ask:qFinal.ask });
        }
      }
      if (!qFinal) { logTradeAction('skip_no_quote', symbol); return false; }

      // Spread & anti-chase slip
      const mid = 0.5*(qFinal.bid+qFinal.ask);
      let spreadPct = (qFinal.ask - qFinal.bid)/mid;
      logTradeAction('quote_ok', symbol, { bid:qFinal.bid, ask:qFinal.ask, spreadPct:+(spreadPct*100).toFixed(3) });

      const closes1 = bars1.map(b=>b.close);
      let effSlipCap = Math.min(effectiveSlipCapPct, BUY_SLIP_CAP_PCT_BASE);
      if (closes1.length>=3) {
        const p2=closes1[closes1.length-3], p0=closes1[closes1.length-1];
        const impulse2mBps = ((p0/p2)-1)*10000;
        if (impulse2mBps >= PRESETS[presetKey].antiChaseImpulseBps) {
          effSlipCap = Math.max(0.0008, effSlipCap/2); // halve cap
          logTradeAction('anti_chase_halve_slip', symbol, { impulse2mBps: +impulse2mBps.toFixed(1), effSlipCap });
        }
      }

      if (PER_SYMBOL_MAX[symbol] === 0) { logTradeAction('skip_stable', symbol); return false; }

      // Account + sizing
      const accountRes = await f(`${ALPACA_BASE_URL}/account`, { headers: HEADERS });
      const accountData = await accountRes.json();
      const equity = parseFloat(accountData.portfolio_value ?? accountData.equity ?? '0');
      const nonMarginBP = parseFloat(accountData.non_marginable_buying_power ?? 'NaN');
      const buyingPower = parseFloat(accountData.buying_power ?? '0');
      const cash = parseFloat(accountData.cash || 0);

      const atr = calcATR(bars15, CFG_BASE.risk.atrLen);
      if (!atr || !isFinite(atr) || atr <= 0) { logTradeAction('skip_small_order', symbol, { reason:'ATR unavailable for sizing' }); return false; }

      const riskUSD = (CFG_BASE.risk.riskPerTradePctEquity/100)*equity;
      const stopDist = CFG_BASE.risk.atrKStop*atr;
      const qtyFromRisk = Math.max(0, riskUSD/stopDist);
      let notional = qtyFromRisk*price;

      const capNotionalByMaxEquity = (CFG_BASE.risk.maxPosPctEquity/100)*equity;
      const bp = CFG_BASE.risk.useNonMarginableBP && Number.isFinite(nonMarginBP) ? nonMarginBP : buyingPower;
      const softCap = Math.max(0, Math.min(capNotionalByMaxEquity, bp, cash));
      notional = Math.min(notional, softCap);
      notional = capNotional(symbol, notional);
      if (!isFinite(notional) || notional < CFG_BASE.risk.minNotionalUSD) { logTradeAction('skip_small_order', symbol, { reason:'below min notional', notional }); return false; }

      // Targets & edge
      const spreadAdj = Math.max(0, spreadPct) * 0.5;
      const tpAtr = price + (CFG_BASE.exits.tpKatr * atr * TP_CUSHION);
      const tpMicroCandidate = price * (1 + (CFG_BASE.exits.tpMinBps / 10000));
      const tpFloor = price * (1 + (ROUND_TRIP_PCT + SLIPPAGE_PCT + TINY_EDGE_PCT) + spreadAdj);
      const tpFinal = Math.max(tpFloor, Math.min(tpAtr, tpMicroCandidate));
      const expectedNet = expectedNetPct(price, tpFinal);
      if (!(expectedNet >= TINY_EDGE_PCT)) { logTradeAction('skip_fee_unprofitable', symbol, { entry:price, tp:tpFinal, expectedNetPct:+(expectedNet*100).toFixed(3) }); return false; }

      // Spread gate with soft override
      if (spreadPct > MAX_SPREAD_PCT) {
        const MAX_SOFT = MAX_SPREAD_PCT * RELAX_SPREAD_FACTOR;
        const strongEdge = expectedNet >= (TINY_EDGE_PCT + 0.001);
        if (!(spreadPct <= MAX_SOFT && strongEdge)) {
          logTradeAction('skip_wide_spread', symbol, { spreadPct:+(spreadPct*100).toFixed(3), expectedNetPct:+(expectedNet*100).toFixed(2) });
          return false;
        }
        logTradeAction('spread_soft_override', symbol, { spreadPct:+(spreadPct*100).toFixed(3), expectedNetPct:+(expectedNet*100).toFixed(2) });
      }

      notional = Math.floor(notional*100)/100;
      const buyLimit = +(qFinal.ask * (1 + effSlipCap)).toFixed(5);
      let qty = +(notional/buyLimit).toFixed(6);
      if (!Number.isFinite(qty) || qty <= 0) { logTradeAction('skip_bad_qty', symbol, { notional, buyLimit, qty }); return false; }

      const order = { symbol, qty, side:'buy', type:'limit', time_in_force:'ioc', limit_price: buyLimit.toFixed(5), client_order_id:`boab_${symbol}_${Date.now()}_${Math.floor(Math.random()*1e6)}` };
      const res = await f(`${ALPACA_BASE_URL}/orders`, { method:'POST', headers:HEADERS, body:JSON.stringify(order) });
      const raw = await res.text(); let result; try{ result=JSON.parse(raw);}catch{ result={raw}; }

      if (res.ok && result.id) {
        logTradeAction('buy_success', symbol, { id: result.id, qty, limit: order.limit_price });
        const priceSnap = price;
        const prefillTp = tpFinal;
        tradeState[symbol] = { ...(tradeState[symbol]||{}), entry:priceSnap, atrAtEntry:atr, peak:priceSnap, stop: priceSnap - CFG_BASE.risk.atrKStop*atr, tp:prefillTp, tp0:prefillTp, lastLimitPostTs:0, entryTs:Date.now(), partialDone:false, belowVwapCount:0 };
        await reseedFromPosition(symbol, atr);
        return true;
      } else {
        logTradeAction('buy_failed', symbol, { status: res.status, reason: result.message || raw });
        showNotification(`❌ Buy Failed ${symbol}`);
        return false;
      }
    } catch (err) { logTradeAction('buy_error', symbol, { error: err.message }); showNotification(`❌ Buy Error ${symbol}: ${err.message}`); return false; }
  };

  async function reseedFromPosition(symbol, atrNow) {
    const pos = await getPositionInfo(symbol);
    if (!pos || !Number.isFinite(pos.basis)) return;
    const entryBasis = pos.basis;
    let spreadAdj=0; try{ const q=await getQuote(symbol); if(q && q.ask>0 && q.bid>0){ const mid=0.5*(q.bid+q.ask); spreadAdj=Math.max(0,(q.ask-q.bid)/mid)*0.5; } }catch{}
    const tpAtr = entryBasis + (CFG_BASE.exits.tpKatr * atrNow * TP_CUSHION);
    const tpMicroCandidate = entryBasis * (1 + (CFG_BASE.exits.tpMinBps / 10000));
    const tpFloor = entryBasis * (1 + (ROUND_TRIP_PCT + SLIPPAGE_PCT + TINY_EDGE_PCT) + spreadAdj);
    const seededTp = Math.max(tpFloor, Math.min(tpAtr, tpMicroCandidate));
    tradeState[symbol] = { ...(tradeState[symbol]||{}), entry:entryBasis, atrAtEntry:atrNow, peak:entryBasis, stop: entryBasis - CFG_BASE.risk.atrKStop*atrNow, tp:seededTp, tp0:seededTp, lastLimitPostTs:0, entryTs:Date.now(), partialDone:false, belowVwapCount:0 };
    await ensureLimitTP(symbol, tradeState[symbol].tp);
  }

  // ===== PnL + safety rails =====
  async function realizedUnrealizedSnapshot(){
    const acts = await getActivitiesToday(); const pnl = computePnlFromActivities(acts||[]);
    let unreal=0; const positions = await getAllPositions();
    for (const p of (positions||[])){ const u = parseFloat(p.unrealized_pl ?? 'NaN'); if(Number.isFinite(u)) unreal += u; }
    return { realized: pnl.realizedUsd ?? 0, unrealized: unreal, equity: acctSummary.portfolioValue ?? 0 };
  }
  function maybeDayKill(realized, unrealized, equity){
    const dd = (realized + unrealized) / Math.max(1, equity);
    if (dd <= -0.008) { dayKillUntil = Date.now() + 24*60*60*1000; logTradeAction('day_kill_triggered', 'ALL', { ddPct: +(dd*100).toFixed(2) }); }
  }
  function recordLossExitIfAny(symbol, exitMark){
    const s = tradeState[symbol]; if (!s || !Number.isFinite(exitMark) || !Number.isFinite(s.entry)) return;
    const pnl = exitMark - s.entry;
    if (pnl < 0) { const now=Date.now(); SEQ_LOSS_LOG.push(now); // prune >60m
      for (let i=SEQ_LOSS_LOG.length-1;i>=0;i--) { if (now-SEQ_LOSS_LOG[i] > 60*60*1000) SEQ_LOSS_LOG.splice(i,1); }
      if (SEQ_LOSS_LOG.length >= 3) { globalCooldownUntil = Math.max(globalCooldownUntil, now + 120*60*1000); logTradeAction('sequence_kill_triggered','ALL',{count: SEQ_LOSS_LOG.length}); }
    }
    perSymbolCooldownUntil[symbol] = Date.now() + PRESETS[presetKey].reentryCooldownMins*60*1000;
  }

  // ===== Refresh + Entry Scan =====
  const loadData = async () => {
    if (isLoading) { logTradeAction('scan_skip_busy', 'all'); return; }
    setIsLoading(true);
    applyPreset();

    try {
      await getAccountSummary();
      await refreshPnlToday(setPnlToday);

      // Update market context (regime/crashometer)
      const ctx = await buildMarketContext(); setMarketCtx(ctx);

      // Crashometer kill switch
      const pset = PRESETS[presetKey];
      if ((ctx.zBTC < -2.5 || ctx.crashATR) && Date.now() > globalCooldownUntil) {
        logTradeAction('crash_kill_switch', 'ALL', { zBTC:+ctx.zBTC.toFixed(2), crashATR:ctx.crashATR });
        // flatten
        const positions = await getAllPositions();
        for (const p of positions) { await placeMarketSellAll(p.symbol); recordLossExitIfAny(p.symbol, Number.NaN); }
        globalCooldownUntil = Date.now() + pset.cooldownMinutesAfterCrash*60*1000;
      }

      // Day kill check
      const snap = await realizedUnrealizedSnapshot();
      maybeDayKill(snap.realized, snap.unrealized, snap.equity);

      const now = Date.now();
      const results = [];
      const scanList = shuffleArray(tracked);

      // concurrency limit
      const positions = await getAllPositions();
      let openCount = (positions||[]).length;
      const maxAllowed = Math.abs(ctx.zBTC) < 1.0 ? pset.maxConcurrentIfCalm : pset.maxConcurrentBase;

      let readyCount=0, attemptCount=0, successCount=0;

      const regimeOK = (!pset.regime.requireBTCETHTrend) || (ctx.btcTrendUp && ctx.ethTrendUp);

      for (const asset of scanList) {
        const token = { ...asset, price:null, rsi:null, macd:null, signal:null, signalDiff:null, trend:'🟰', entryReady:false, watchlist:false, missingData:false, error:null, time:new Date().toLocaleTimeString() };

        try {
          const [price, bars15, bars1] = await Promise.all([
            getPriceUSD(asset.cc || asset.symbol),
            getBars15m(asset.cc || asset.symbol, 220),
            getBars1m(asset.cc || asset.symbol, CFG_BASE.micro.lookbackLimit),
          ]);
          if (Number.isFinite(price)) token.price = price;

          const closes15 = bars15.map(b=>b.close).filter((c)=>typeof c==='number');
          const closes1  = bars1.map(b=>b.close).filter((c)=>typeof c==='number');

          if (closes15.length >= 30) {
            const r = calcRSI(closes15, CFG_BASE.rsi.length);
            token.rsi = r != null ? r.toFixed(1) : null;

            const macdFull = calcMACDFull(closes15, CFG_BASE.macd.fast, CFG_BASE.macd.slow, CFG_BASE.macd.signal);
            if (macdFull) { token.macd=macdFull.macd; token.signal=macdFull.signal; token.signalDiff=token.macd-token.signal; }

            const sigma = logRetSigma(closes15, CFG_BASE.vol.lookbackBars);
            const z = zScore(closes15, CFG_BASE.z.lookbackBars);
            const slopeOK = macdFull ? macdHistSlopeIncreasing(macdFull.histArr, CFG_BASE.macd.minHistSlopeBars) : false;
            const trendOK = CFG_BASE.trend.requireUp ? emaTrendOK(closes15, CFG_BASE.trend.emaFast, CFG_BASE.trend.emaSlow) : true;

            const score = compositeScore({ macdSlope:slopeOK, trendOK, rsiVal:r }, CFG_BASE.weights);
            const macdUp = macdUpish(macdFull);
            token.trend = getTrendSymbol(closes15);
            token._score=Math.round(score); token._sigma=sigma; token._z=z; token._slopeOK=slopeOK; token._trendOK=trendOK;

            // Legacy micro trigger
            const microOK = microTriggerOK(bars1);

            // === New gates ===
            // Anchored VWAP gate
            let vwapOK = true, vwapDownCount = 0, vwapSlopeUp = true;
            if (pset.regime.requireVWAP) {
              const day1m = await getBars1mSinceUTC0(asset.cc || asset.symbol);
              const pv=[], vv=[], vwap=[]; let pvSum=0, vSum=0;
              for (const b of day1m){ const p=b.close, v=Math.max(0.0000001, b.vol||0.0000001); pvSum += p*v; vSum += v; vwap.push(pvSum/vSum); }
              const lastClose = day1m.length? day1m[day1m.length-1].close : price;
              const lastVwap = vwap.length ? vwap[vwap.length-1] : price;
              vwapDownCount = (day1m.length>=2 && vwap.length>=2)
                ? ((day1m[day1m.length-1].close < vwap[vwap.length-1]) + (day1m[day1m.length-2].close < vwap[vwap.length-2]))
                : 0;
              vwapSlopeUp = vwap.length>10 ? (vwap[vwap.length-1] > vwap[vwap.length-11]) : true;

              const firstReclaimOK = pset.allowFirstReclaim && day1m.length>=4
                ? (day1m.slice(-4,-1).every(b=>b.close < vwap[vwap.length - (day1m.length - day1m.indexOf(b))]) && lastClose > lastVwap)
                : false;

              vwapOK = (lastClose > lastVwap && (pset.regime.requireVWAPSlopeUp ? vwapSlopeUp : true)) || firstReclaimOK;
              if (!vwapOK) logTradeAction('gate_vwap_block', asset.symbol, { lastClose, lastVwap, vwapSlopeUp, firstReclaimOK });
            }

            // Relative Strength vs BTC (15m)
            let rsOK = true;
            if (closes15.length>=2) {
              const rocSym = (closes15[closes15.length-1]/closes15[closes15.length-2]-1);
              const rocBtc = marketCtx.btcROC15m || 0;
              const rs = rocSym - rocBtc;
              rsOK = rs >= (PRESETS[presetKey].rsGateBps/10000);
              if (!rsOK) logTradeAction('gate_rs_block', asset.symbol, { rsBps:+(rs*10000).toFixed(1) });
            }

            const atrNow = calcATR(bars15, CFG_BASE.risk.atrLen);
            const tpEdgeBps = atrNow && token.price ? (CFG_BASE.exits.tpKatr*atrNow/token.price)*10000 : 0;
            const edgeOK = (CFG_BASE.risk.minEdgeBps ?? 0) === 0 || tpEdgeBps >= CFG_BASE.risk.minEdgeBps;

            const classicOK = (macdUp || score >= CFG_BASE.minScore) && edgeOK && microOK;
            const microOverrideOK = microOK && edgeOK;

            const feeRoomOK = (() => {
              if (!(atrNow && token.price)) return false;
              const p=token.price;
              const tpAtr2 = p + (CFG_BASE.exits.tpKatr*atrNow*TP_CUSHION);
              const tpMicro2 = p * (1 + CFG_BASE.exits.tpMinBps/10000);
              const tpFloor2 = p * (1 + (ROUND_TRIP_PCT + SLIPPAGE_PCT + TINY_EDGE_PCT));
              const tpFinal2 = Math.max(tpFloor2, Math.min(tpAtr2, tpMicro2));
              const expectedNet2 = expectedNetPct(p, tpFinal2);
              return expectedNet2 >= TINY_EDGE_PCT;
            })();

            // Global cooldowns & day kill
            const cooldownActive = now < globalCooldownUntil || now < dayKillUntil;

            // Per-symbol cooldown
            const symCooldownActive = now < (perSymbolCooldownUntil[asset.symbol] || 0);

            // Concurrency cap
            const concurrencyOK = openCount < maxAllowed;

            const regimePass = (!pset.regime.requireBTCETHTrend) || regimeOK;

            token.entryReady = (
              !cooldownActive &&
              !symCooldownActive &&
              concurrencyOK &&
              regimePass &&
              vwapOK &&
              rsOK &&
              feeRoomOK &&
              (classicOK || microOverrideOK)
            );

            token.watchlist = !token.entryReady && (macdUp || microOK);

            // Autotrade
            if (autoTrade && token.entryReady) {
              readyCount++;
              const held = await getPositionInfo(asset.symbol);
              if (held && Number(held.qty) > 0) {
                logTradeAction('entry_skip_already_holding', asset.symbol, { qty: held.qty });
              } else {
                logTradeAction('entry_ready_confirmed', asset.symbol, { score: token._score });
                attemptCount++;
                const ok = await placeOrder(asset.symbol, asset.cc, false, PRESETS[presetKey].buySlipCapPct);
                if (ok) { successCount++; openCount++; }
              }
            } else {
              logTradeAction('entry_skipped', asset.symbol, { entryReady: token.entryReady });
            }
          }

          token.missingData = token.price == null || (bars15?.length ?? 0) < 30;
        } catch (err) {
          token.error = err.message; token.missingData = true;
        }
        results.push(token);
      }

      logTradeAction('scan_summary', 'all', { readyCount, attemptCount, successCount });
      setData(results);
    } finally { setRefreshing(false); setIsLoading(false); }
  };

  // Exit Manager
  useEffect(() => {
    if (exitIntervalRef.current) { clearInterval(exitIntervalRef.current); exitIntervalRef.current = null; }
    exitIntervalRef.current = setInterval(async () => {
      applyPreset();
      const pset = PRESETS[presetKey];

      for (const asset of tracked) {
        const symbol = asset.symbol;
        const pos = await getPositionInfo(symbol);
        if (!pos || Number(pos.qty) <= 0) continue;

        try {
          const [mark, bars15, bars1, q, day1m] = await Promise.all([
            getPriceUSD(asset.cc || asset.symbol),
            getBars15m(asset.cc || asset.symbol, 60),
            getBars1m(asset.cc || asset.symbol, 60),
            getQuote(symbol),
            getBars1mSinceUTC0(asset.cc || asset.symbol),
          ]);
          const atrNow = calcATR(bars15, CFG_BASE.risk.atrLen) || tradeState[symbol]?.atrAtEntry;
          if (!Number.isFinite(mark) || !Number.isFinite(atrNow)) continue;

          if (!tradeState[symbol]?.entry) {
            await reseedFromPosition(symbol, atrNow);
          }

          const s = tradeState[symbol];
          s.peak = Math.max(s.peak, mark);

          // Anchored VWAP for exit
          let belowVwap = false;
          if (pset.vwapExitTwoCloses) {
            const pv=[], vv=[], vwap=[]; let pvSum=0, vSum=0;
            for (const b of day1m){ const p=b.close, v=Math.max(0.0000001, b.vol||0.0000001); pvSum += p*v; vSum += v; vwap.push(pvSum/vSum); }
            if (day1m.length>=1 && vwap.length>=1) {
              const lastClose = day1m[day1m.length-1].close, lastVwap=vwap[vwap.length-1];
              belowVwap = lastClose < lastVwap;
              s.belowVwapCount = belowVwap ? (s.belowVwapCount||0)+1 : 0;
            }
          }

          // SpreadAdj for TP floor calc
          let spreadAdj=0; if (q && q.ask>0 && q.bid>0){ const mid=0.5*(q.bid+q.ask); spreadAdj=Math.max(0,(q.ask-q.bid)/mid)*0.5; }

          // Decayed TP
          const ageMins = (Date.now() - (s.entryTs || Date.now())) / 60000;
          const minFeeFloorPct = ROUND_TRIP_PCT + SLIPPAGE_PCT + (TINY_EDGE_PCT/2) + spreadAdj;
          const minTpFloor = s.entry * (1 + minFeeFloorPct);
          const ds = activeCFG.exits.decayStartMins ?? 0;
          const df = activeCFG.exits.decayFullMins ?? ds;
          let decayedTp = s.tp0 ?? s.tp;
          if (df > ds && ageMins > ds) {
            const t = Math.min(1, (ageMins - ds) / (df - ds));
            decayedTp = (s.tp0 ?? s.tp) - ((s.tp0 ?? s.tp) - minTpFloor) * t;
          }
          s.tp = Math.max(minTpFloor, decayedTp);
          await ensureLimitTP(symbol, s.tp);

          // Stops: BE sooner + trail
          const minBEStop = s.entry * (1 + ROUND_TRIP_PCT);
          const movedEnough = (mark - s.entry) >= activeCFG.exits.breakevenAfterKatr * atrNow;
          if (movedEnough) {
            s.stop = Math.max(s.stop, minBEStop);
            const trailStop = Math.max(minBEStop, s.peak - activeCFG.exits.trailKatr * atrNow);
            s.stop = Math.max(s.stop, trailStop);
          } else {
            const preBEtrail = s.peak - activeCFG.exits.trailKatr * atrNow;
            s.stop = Math.max(s.stop, Math.min(preBEtrail, s.entry - 1e-8));
          }

          // Partial take-profit
          if (!s.partialDone) {
            const partialTrigger = s.entry * (1 + (ROUND_TRIP_PCT + SLIPPAGE_PCT + pset.partial.extraGrossPct));
            if (mark >= partialTrigger) {
              const ok = await placeMarketSellQty(symbol, pset.partial.fraction);
              if (ok) {
                s.partialDone = true;
                s.stop = Math.max(s.stop, minBEStop); // lock BE+fees on runner
                logTradeAction('partial_taken', symbol, { fraction: pset.partial.fraction, trigger: +partialTrigger.toFixed(5) });
              }
            }
          }

          // Fast-wrong exit (≤2m)
          if (ageMins <= pset.fastWrong.windowMins) {
            // ATR_1m
            let atr1m = null;
            if (bars1.length >= 15) {
              const tr=[]; for(let i=1;i<bars1.length;i++){ const h=bars1[i].high, l=bars1[i].low, cp=bars1[i-1].close; tr.push(Math.max(h-l, Math.abs(h-cp), Math.abs(l-cp))); }
              atr1m = emaArr(tr, 14).slice(-1)[0];
            }
            const closes1 = bars1.map(b=>b.close);
            const ema9 = emaArr(closes1, 9).slice(-1)[0];
            const ema21 = emaArr(closes1, 21).slice(-1)[0];
            const tinyLossCap = s.entry * (1 - (FEE_PER_SIDE_PCT + SLIPPAGE_PCT + 0.0001)); // ~ -0.35%

            const cond1 = (ema9!=null && ema21!=null && ema9<ema21 && mark < s.entry*(1 - pset.fastWrong.tinyLossPct));
            const cond2 = (atr1m!=null && closes1.length>0 && closes1[closes1.length-1] < (s.entry - pset.fastWrong.atr1mK * atr1m));

            if (cond1 || cond2) {
              logTradeAction('fast_wrong_exit', symbol, { ageMins:+ageMins.toFixed(2), cond1, cond2 });
              recordLossExitIfAny(symbol, mark);
              await placeMarketSellAll(symbol);
              delete tradeState[symbol];
              continue;
            }
          }

          // VWAP 2-close exit (loss capped to tinyLossCap)
          if (pset.vwapExitTwoCloses && (s.belowVwapCount||0) >= 2) {
            const tinyLossCap = s.entry * (1 - (FEE_PER_SIDE_PCT + SLIPPAGE_PCT + 0.0001));
            if (mark >= tinyLossCap) {
              logTradeAction('vwap_exit_two_closes', symbol, { mark, belowVwapCount:s.belowVwapCount });
              recordLossExitIfAny(symbol, mark);
              await placeMarketSellAll(symbol);
              delete tradeState[symbol];
              continue;
            }
          }

          // Absolute time stop
          if (ageMins >= (CFG_BASE.exits.maxHoldMinsAbs ?? 1e9)) {
            logTradeAction('abs_time_stop_exit', symbol, { ageMins: Math.round(ageMins) });
            recordLossExitIfAny(symbol, mark);
            await placeMarketSellAll(symbol);
            delete tradeState[symbol];
            continue;
          }

          // Original time stop (if above BE)
          if (ageMins >= CFG_BASE.exits.timeStopMins && mark >= minBEStop) {
            logTradeAction('time_stop_exit', symbol, { ageMins: Math.round(ageMins), mark });
            recordLossExitIfAny(symbol, mark);
            await placeMarketSellAll(symbol);
            delete tradeState[symbol];
            continue;
          }

          // Stop breach
          if (mark <= s.stop) {
            logTradeAction('stop_hit', symbol, { mark, stop: s.stop });
            recordLossExitIfAny(symbol, mark);
            await placeMarketSellAll(symbol);
            delete tradeState[symbol];
          }

        } catch (e) { logTradeAction('exit_loop_error', symbol, { error:e.message }); }
      }
    }, activeCFG.exits.markRefreshSecs * 1000);

    return () => { if (exitIntervalRef.current) clearInterval(exitIntervalRef.current); };
  }, [tracked, presetKey]);

  // Kick off scan loop
  useEffect(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    intervalRef.current = setInterval(loadData, CFG_BASE.scanSecs * 1000);
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
    })();
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [presetKey]);

  const onRefresh = () => { setRefreshing(true); loadData(); };

  const renderCard = (asset) => {
    const borderColor = asset.entryReady ? 'green' : asset.watchlist ? '#FFA500' : 'red';
    const cardStyle = [ styles.card, { borderLeftColor: borderColor }, asset.watchlist && !asset.entryReady && styles.cardWatchlist ];
    return (
      <View key={asset.symbol} style={cardStyle}>
        <Text style={styles.symbol}>{asset.name} ({asset.symbol})</Text>
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
        <TouchableOpacity onPress={() => placeOrder(asset.symbol, asset.cc, true, PRESETS[presetKey].buySlipCapPct)}>
          <Text style={styles.buyButton}>Manual BUY</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const bySignal = (a,b) => { const diffA=a.signalDiff??-Infinity, diffB=b.signalDiff??-Infinity; return diffA===diffB ? a.symbol.localeCompare(b.symbol) : (diffB-diffA); };
  const entryReadyTokens = data.filter((t)=>t.entryReady).sort(bySignal);
  const watchlistTokens = data.filter((t)=>!t.entryReady && t.watchlist).sort(bySignal);
  const pv = acctSummary.portfolioValue, chPct=acctSummary.dailyChangePct;

  // Preset toggle UI
  const cyclePreset = () => setPresetKey((k)=> (k==='A'?'B':k==='B'?'C':'A'));

  return (
    <ScrollView
      contentContainerStyle={[styles.container, darkMode && styles.containerDark]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.appTitle, darkMode && styles.titleDark]}>Bullish or Bust</Text>
        <View style={styles.presetRow}>
          <Text style={[styles.presetLabel, darkMode && styles.titleDark]}>Preset:</Text>
          <TouchableOpacity style={[styles.presetBtn, presetKey==='A' && styles.presetBtnActive]} onPress={()=>setPresetKey('A')}><Text style={styles.presetBtnText}>A</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.presetBtn, presetKey==='B' && styles.presetBtnActive]} onPress={()=>setPresetKey('B')}><Text style={styles.presetBtnText}>B</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.presetBtn, presetKey==='C' && styles.presetBtnActive]} onPress={()=>setPresetKey('C')}><Text style={styles.presetBtnText}>C</Text></TouchableOpacity>
          <TouchableOpacity style={styles.presetCycle} onPress={cyclePreset}><Text style={styles.presetBtnText}>Cycle</Text></TouchableOpacity>
          <Text style={[styles.presetName, darkMode && styles.titleDark]}>{PRESETS[presetKey].name}</Text>
        </View>
      </View>

      {/* Account Data */}
      <View style={[styles.accountCard, darkMode && styles.accountCardDark]}>
        <View style={styles.accountRow}><Text style={[styles.accountLabel, darkMode && styles.titleDark]}>Total Value</Text><Text style={[styles.accountValue, darkMode && styles.titleDark]}>{fmtUSD(pv)}</Text></View>
        <View style={styles.accountRow}><Text style={[styles.accountLabel, darkMode && styles.titleDark]}>Daily % Change</Text><Text style={[styles.accountValue, darkMode && styles.titleDark]}>{fmtPct(chPct)}</Text></View>
        <View style={styles.accountRow}><Text style={[styles.accountLabel, darkMode && styles.titleDark]}>Realized Profit (Today)</Text><Text style={[styles.accountValue, pnlToday.realizedUsd>=0?styles.positive:styles.negative]}>{fmtUSDSigned(pnlToday.realizedUsd)}</Text></View>
        <View style={styles.accountRow}><Text style={[styles.accountLabel, darkMode && styles.titleDark]}>Fees (Today)</Text><Text style={[styles.accountValue, styles.negative]}>{fmtUSDSimple(pnlToday.feesUsd)}</Text></View>
      </View>

      {/* Running Log */}
      <View style={[styles.logPanelTop, darkMode && { backgroundColor: '#1e1e1e' }]}>
        <Text style={styles.logTitle}>Running Log</Text>
        {logHistory.length===0 ? (<Text style={styles.logTextMuted}>No recent events yet…</Text>) : (
          logHistory.map((log, idx) => (<Text key={idx} style={styles.logText}>{`${log.timestamp.split('T')[1].slice(0,8)} ${log.type}${log.symbol ? ' ' + log.symbol : ''}`}</Text>))
        )}
      </View>

      <Text style={styles.sectionHeader}>✅ Entry Ready</Text>
      {entryReadyTokens.length>0 ? (<View style={styles.cardGrid}>{entryReadyTokens.map(renderCard)}</View>) : (<Text style={styles.noData}>No Entry Ready tokens</Text>)}

      <Text style={styles.sectionHeader}>🟧 Watchlist</Text>
      {watchlistTokens.length>0 ? (<View style={styles.cardGrid}>{watchlistTokens.map(renderCard)}</View>) : (<Text style={styles.noData}>No Watchlist tokens</Text>)}

      {notification && (
        <View style={{ position:'absolute', bottom:40, left:20, right:20, padding:12, backgroundColor:'#333', borderRadius:8, zIndex:999 }}>
          <Text style={{ color:'#fff', textAlign:'center' }}>{notification}</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ==================== Styles ====================
const styles = StyleSheet.create({
  container: { flexGrow: 1, paddingTop: 40, paddingHorizontal: 10, backgroundColor: '#fff' },
  containerDark: { backgroundColor: '#121212' },
  header: { alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  appTitle: { fontSize: 20, fontWeight: '800', color: '#000' },
  titleDark: { color: '#fff' },

  // Preset UI
  presetRow: { flexDirection:'row', alignItems:'center', gap:8, marginTop:8 },
  presetLabel: { fontSize: 12, fontWeight: '600', color:'#333', marginRight:6 },
  presetBtn: { paddingHorizontal:10, paddingVertical:4, borderRadius:6, backgroundColor:'#2b2b2b', marginHorizontal:3 },
  presetBtnActive: { backgroundColor:'#005eff' },
  presetBtnText: { color:'#fff', fontWeight:'700', fontSize:12 },
  presetCycle: { paddingHorizontal:10, paddingVertical:4, borderRadius:6, backgroundColor:'#444', marginLeft:6 },
  presetName: { marginLeft:8, fontSize:12, fontWeight:'700' },

  // Account card
  accountCard: { backgroundColor:'#f7f7f7', borderRadius:10, padding:12, marginBottom:12 },
  accountCardDark: { backgroundColor:'#1e1e1e' },
  accountRow: { flexDirection:'row', justifyContent:'space-between', paddingVertical:4 },
  accountLabel: { fontSize:14, fontWeight:'600', color:'#333' },
  accountValue: { fontSize:16, fontWeight:'700', color:'#111' },
  positive: { color:'#0a8f08' }, negative: { color:'#c62828' },

  // Cards
  cardGrid: { flexDirection:'row', flexWrap:'wrap', justifyContent:'space-between' },
  card: { width:'48%', backgroundColor:'#f0f0f0', padding:10, borderRadius:6, borderLeftWidth:5, marginBottom:10 },
  cardWatchlist: { borderColor:'#FFA500', borderWidth:2 },
  symbol: { fontSize:15, fontWeight:'bold', color:'#005eff' },
  error: { color:'red', fontSize:12 },
  buyButton: { color:'#0066cc', marginTop:8, fontWeight:'bold' },
  noData: { textAlign:'center', marginTop:20, fontStyle:'italic', color:'#777' },
  entryReady: { color:'green', fontWeight:'bold' },
  watchlist: { color:'#FFA500', fontWeight:'bold' },
  sectionHeader: { fontSize:16, fontWeight:'bold', marginBottom:5, marginTop:10 },
  missing: { color:'#c62828', fontStyle:'italic' },

  // Log panel
  logPanelTop: { backgroundColor:'#222', padding:10, borderRadius:8, marginBottom:8 },
  logTitle: { color:'#fff', fontSize:14, fontWeight:'700', marginBottom:6 },
  logText: { color:'#fff', fontSize:12 },
  logTextMuted: { color:'#bbb', fontSize:12, fontStyle:'italic' },
});
