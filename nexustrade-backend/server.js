/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║       NEXUSTRADE PRO — Backend Server v2.0               ║
 * ║  Binance REST + WebSocket + Bot Engine + Harmonik Motor  ║
 * ╚══════════════════════════════════════════════════════════╝
 */

'use strict';

const express   = require('express');
const http      = require('http');
const https     = require('https');
const crypto    = require('crypto');
const WebSocket = require('ws');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');

// ── Config ──────────────────────────────────────────────────
const CONFIG = {
  PORT:         process.env.PORT         || 3000,
  BINANCE_REST: 'https://api.binance.com',
  BINANCE_WS:   'wss://stream.binance.com:9443',
  RECV_WINDOW:  5000,
};

// ── Logger ───────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log ('\x1b[36m[INFO]\x1b[0m',  ...a),
  warn:  (...a) => console.warn ('\x1b[33m[WARN]\x1b[0m',  ...a),
  error: (...a) => console.error('\x1b[31m[ERROR]\x1b[0m', ...a),
  trade: (...a) => console.log ('\x1b[32m[TRADE]\x1b[0m', ...a),
  bot:   (...a) => console.log ('\x1b[35m[BOT]\x1b[0m',   ...a),
};

// ── In-memory stores ─────────────────────────────────────────
const sessions = new Map();
const bots     = new Map();
const clients  = new Set();

// ════════════════════════════════════════════════════════════
//  BINANCE API ENGINE
// ════════════════════════════════════════════════════════════
class BinanceAPI {
  constructor(apiKey, apiSecret) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
  }

  _sign(queryString) {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  _signedParams(params = {}) {
    const timestamp  = Date.now();
    const recvWindow = CONFIG.RECV_WINDOW;
    const merged     = { ...params, timestamp, recvWindow };
    const qs         = Object.entries(merged).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return `${qs}&signature=${this._sign(qs)}`;
  }

  async _request(method, endpoint, params = {}, signed = false) {
    return new Promise((resolve, reject) => {
      const query   = signed
        ? this._signedParams(params)
        : Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
      const urlPath = query ? `${endpoint}?${query}` : endpoint;
      const options = {
        hostname: 'api.binance.com',
        path:     urlPath,
        method,
        headers:  { 'X-MBX-APIKEY': this.apiKey, 'Content-Type': 'application/json' },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.code && parsed.code < 0) reject(new BinanceError(parsed.msg, parsed.code));
            else resolve(parsed);
          } catch (e) { reject(new Error('JSON parse error: ' + data)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  ping()                              { return this._request('GET', '/api/v3/ping'); }
  serverTime()                        { return this._request('GET', '/api/v3/time'); }
  ticker24h(symbol)                   { return this._request('GET', '/api/v3/ticker/24hr', symbol ? { symbol } : {}); }
  orderBook(symbol, limit = 20)       { return this._request('GET', '/api/v3/depth', { symbol, limit }); }
  recentTrades(symbol, limit = 50)    { return this._request('GET', '/api/v3/trades', { symbol, limit }); }
  klines(symbol, interval, limit=200) { return this._request('GET', '/api/v3/klines', { symbol, interval, limit }); }
  price(symbol)                       { return this._request('GET', '/api/v3/ticker/price', { symbol }); }
  accountInfo()                       { return this._request('GET', '/api/v3/account', {}, true); }
  openOrders(symbol)                  { return this._request('GET', '/api/v3/openOrders', symbol ? { symbol } : {}, true); }
  allOrders(symbol, limit = 50)       { return this._request('GET', '/api/v3/allOrders', { symbol, limit }, true); }
  myTrades(symbol, limit = 50)        { return this._request('GET', '/api/v3/myTrades', { symbol, limit }, true); }
  newOrder(params)                    { return this._request('POST', '/api/v3/order', params, true); }
  cancelOrder(symbol, orderId)        { return this._request('DELETE', '/api/v3/order', { symbol, orderId }, true); }
  cancelAllOrders(symbol)             { return this._request('DELETE', '/api/v3/openOrders', { symbol }, true); }
  newOCO(params)                      { return this._request('POST', '/api/v3/order/oco', params, true); }
  createListenKey()                   { return this._request('POST', '/api/v3/userDataStream', {}, false); }

  // Geçmiş veri çekme (sayfalama ile)
  async fetchHistorical(symbol, interval, days) {
    const tfMins = {
      '1m':1,'3m':3,'5m':5,'15m':15,'30m':30,
      '1h':60,'2h':120,'4h':240,'6h':360,'12h':720,'1d':1440
    };
    const mins        = tfMins[interval] || 60;
    const totalMs     = days * 24 * 60 * 60 * 1000;
    const batchSize   = 1000;
    let   since       = Date.now() - totalMs;
    const allCandles  = [];

    while (true) {
      const raw = await this._request('GET', '/api/v3/klines', {
        symbol, interval, startTime: since, limit: batchSize
      });
      if (!raw || !raw.length) break;
      allCandles.push(...raw);
      const lastTs = raw[raw.length - 1][0];
      since = lastTs + 1;
      if (raw.length < batchSize) break;
      await new Promise(r => setTimeout(r, 300)); // rate limit
    }

    return allCandles.map(k => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
    }));
  }
}

class BinanceError extends Error {
  constructor(message, code) { super(message); this.code = code; this.name = 'BinanceError'; }
}

// ════════════════════════════════════════════════════════════
//  TEKNİK İNDİKATÖRLER
// ════════════════════════════════════════════════════════════
function calcSMA(data, period) {
  const n = data.length;
  if (n < period) return 0;
  return data.slice(n - period).reduce((a, b) => a + b, 0) / period;
}

function calcEMAArr(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  let ema = null;
  data.forEach((v, i) => {
    if (i < period - 1) { result.push(null); return; }
    if (ema === null) ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else ema = v * k + ema * (1 - k);
    result.push(ema);
  });
  return result;
}

function calcEMA(data, period) { return calcEMAArr(data, period).slice(-1)[0] || 0; }

function calcRSI(data, period = 14) {
  if (data.length < period + 1) return 50;
  const slice   = data.slice(-period - 1);
  const changes = slice.slice(1).map((v, i) => v - slice[i]);
  const gains   = changes.map(c => c > 0 ? c : 0);
  const losses  = changes.map(c => c < 0 ? Math.abs(c) : 0);
  const avgG    = gains.reduce((a, b) => a + b, 0) / period;
  const avgL    = losses.reduce((a, b) => a + b, 0) / period;
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

function calcBB(data, period = 20, std = 2) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const sd    = Math.sqrt(slice.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / period) * std;
  return { upper: mean + sd, mid: mean, lower: mean - sd };
}

function calcMACD(data, fast = 12, slow = 26, signal = 9) {
  const emaFast  = calcEMAArr(data, fast);
  const emaSlow  = calcEMAArr(data, slow);
  const macdLine = emaFast.map((v, i) => v !== null && emaSlow[i] !== null ? v - emaSlow[i] : null);
  const valid    = macdLine.filter(v => v !== null);
  const sigArr   = calcEMAArr(valid, signal);
  const lastM    = valid[valid.length - 1] || 0;
  const lastS    = sigArr[sigArr.length - 1] || 0;
  return { macdLine: lastM, signalLine: lastS, histogram: lastM - lastS };
}

function calcATR(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prev = candles[i - 1];
    return Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
  });
  return calcSMA(trs, period);
}

// ════════════════════════════════════════════════════════════
//  HARMONİK FORMASYON MOTORU
//  Python backtester.py ve harmonic_patterns.py ile BİREBİR AYNI
// ════════════════════════════════════════════════════════════
const TOLERANCE = 0.05; // ±%5 — Python'daki TOLERANCE ile aynı

function inRange(val, lo, hi) {
  return lo * (1 - TOLERANCE) <= val && val <= hi * (1 + TOLERANCE);
}
function inTarget(val, target) {
  return inRange(val, target, target);
}

function calcHarmonicRatios(X, A, B, C, D) {
  const XA = Math.abs(A.c - X.c);
  const AB = Math.abs(B.c - A.c);
  const BC = Math.abs(C.c - B.c);
  const CD = Math.abs(D.c - C.c);
  const XD = Math.abs(D.c - X.c);
  return {
    AB_XA: XA > 0 ? AB / XA : 0,
    BC_AB: AB > 0 ? BC / AB : 0,
    CD_BC: BC > 0 ? CD / BC : 0,
    XD_XA: XA > 0 ? XD / XA : 0,
    XA, AB, BC, CD, XD,
  };
}

// Kalite puanı — Python'daki _quality_score ile aynı mantık
function qualityScore(ratios, targets) {
  const scores = [];
  for (const [key, [lo, hi]] of Object.entries(targets)) {
    if (!(key in ratios)) continue;
    const val = ratios[key];
    const mid = (lo + hi) / 2;
    const span = (hi - lo) / 2 + 0.001;
    const deviation = Math.abs(val - mid) / span;
    scores.push(Math.max(0, 100 - deviation * 100));
  }
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
}

// PRZ ve hedef fiyatlar — Python'daki _prz_and_targets ile aynı
function calcTargets(X, A, D, direction) {
  const prz    = D.c;
  const xaRange = Math.abs(A.c - X.c);
  let sl, tp1, tp2, tp3;
  if (direction === 'bullish') {
    sl  = D.c - xaRange * 0.10;
    tp1 = D.c + (A.c - D.c) * 0.382;
    tp2 = D.c + (A.c - D.c) * 0.618;
    tp3 = A.c;
  } else {
    sl  = D.c + xaRange * 0.10;
    tp1 = D.c - (D.c - A.c) * 0.382;
    tp2 = D.c - (D.c - A.c) * 0.618;
    tp3 = A.c;
  }
  return { prz, sl, tp1, tp2, tp3 };
}

// 13 formasyon — Python harmonic_patterns.py ile birebir aynı oranlar
const PATTERN_CHECKERS = [
  {
    name: 'Gartley',
    check: r => inTarget(r.AB_XA, 0.618) && inTarget(r.XD_XA, 0.786) &&
                inRange(r.BC_AB, 0.382, 0.886) && inRange(r.CD_BC, 1.272, 1.618),
    targets: { AB_XA:[0.618,0.618], XD_XA:[0.786,0.786], BC_AB:[0.382,0.886], CD_BC:[1.272,1.618] },
  },
  {
    name: 'Yengeç',
    check: r => inRange(r.AB_XA, 0.382, 0.618) && inTarget(r.XD_XA, 1.618) &&
                inRange(r.BC_AB, 0.382, 0.886) && inRange(r.CD_BC, 2.618, 3.618),
    targets: { AB_XA:[0.382,0.618], XD_XA:[1.618,1.618], BC_AB:[0.382,0.886], CD_BC:[2.618,3.618] },
  },
  {
    name: 'Derin Yengeç',
    check: r => inTarget(r.AB_XA, 0.886) && inTarget(r.XD_XA, 1.618) &&
                inRange(r.BC_AB, 0.382, 0.886) && inRange(r.CD_BC, 2.0, 3.618),
    targets: { AB_XA:[0.886,0.886], XD_XA:[1.618,1.618], BC_AB:[0.382,0.886], CD_BC:[2.0,3.618] },
  },
  {
    name: 'Yarasa',
    check: r => inRange(r.AB_XA, 0.382, 0.500) && inTarget(r.XD_XA, 0.886) &&
                inRange(r.BC_AB, 0.382, 0.886) && inRange(r.CD_BC, 1.618, 2.618),
    targets: { AB_XA:[0.382,0.500], XD_XA:[0.886,0.886], BC_AB:[0.382,0.886], CD_BC:[1.618,2.618] },
  },
  {
    name: 'Alt Yarasa',
    check: r => inTarget(r.AB_XA, 0.382) && inTarget(r.XD_XA, 1.13) &&
                inRange(r.BC_AB, 0.382, 0.886) && inRange(r.CD_BC, 2.0, 3.618),
    targets: { AB_XA:[0.382,0.382], XD_XA:[1.13,1.13], BC_AB:[0.382,0.886], CD_BC:[2.0,3.618] },
  },
  {
    name: 'Kelebek',
    check: r => inTarget(r.AB_XA, 0.786) && inRange(r.XD_XA, 1.27, 1.618) &&
                inRange(r.BC_AB, 0.382, 0.886) && inRange(r.CD_BC, 1.618, 2.618),
    targets: { AB_XA:[0.786,0.786], XD_XA:[1.27,1.618], BC_AB:[0.382,0.886], CD_BC:[1.618,2.618] },
  },
  {
    name: 'Shark',
    check: r => inRange(r.AB_XA, 1.13, 1.618) && inRange(r.BC_AB, 1.618, 2.24) &&
                inRange(r.XD_XA, 0.886, 1.13),
    targets: { AB_XA:[1.13,1.618], BC_AB:[1.618,2.24], XD_XA:[0.886,1.13] },
  },
  {
    name: 'Cypher',
    check: r => inRange(r.AB_XA, 0.382, 0.618) && inRange(r.BC_AB, 1.13, 1.414) &&
                inTarget(r.XD_XA, 0.786),
    targets: { AB_XA:[0.382,0.618], BC_AB:[1.13,1.414], XD_XA:[0.786,0.786] },
  },
  {
    name: 'Nenstar',
    check: r => inTarget(r.AB_XA, 0.618) && inRange(r.BC_AB, 1.272, 2.0) &&
                inRange(r.XD_XA, 1.272, 2.0),
    targets: { AB_XA:[0.618,0.618], BC_AB:[1.272,2.0], XD_XA:[1.272,2.0] },
  },
  {
    name: 'Black Swan',
    check: r => inRange(r.AB_XA, 1.382, 2.618) && inRange(r.BC_AB, 0.382, 0.618) &&
                inRange(r.XD_XA, 1.382, 2.618),
    targets: { AB_XA:[1.382,2.618], BC_AB:[0.382,0.618], XD_XA:[1.382,2.618] },
  },
  {
    name: 'White Swan',
    check: r => inRange(r.AB_XA, 0.382, 0.618) && inRange(r.BC_AB, 1.382, 2.618) &&
                inRange(r.XD_XA, 0.382, 0.618),
    targets: { AB_XA:[0.382,0.618], BC_AB:[1.382,2.618], XD_XA:[0.382,0.618] },
  },
  {
    name: '3 Basamak',
    check: r => inRange(r.AB_XA, 0.618, 0.786) && inRange(r.BC_AB, 1.27, 1.618) &&
                inRange(r.CD_BC, 0.618, 0.786),
    targets: { AB_XA:[0.618,0.786], BC_AB:[1.27,1.618], CD_BC:[0.618,0.786] },
  },
  {
    name: '5-0',
    check: r => inRange(r.AB_XA, 1.13, 1.618) && inRange(r.BC_AB, 1.618, 2.24) &&
                inTarget(r.CD_BC, 0.50),
    targets: { AB_XA:[1.13,1.618], BC_AB:[1.618,2.24], CD_BC:[0.50,0.50] },
  },
];

// Swing nokta tespiti — Python swing_detector.py ile birebir aynı
function findSwingPoints(candles, leftBars = 3, rightBars = 3, minPctMove = 0.005) {
  const n      = candles.length;
  const swings = [];

  for (let i = leftBars; i < n - rightBars; i++) {
    const win    = candles.slice(i - leftBars, i + rightBars + 1);
    const maxH   = Math.max(...win.map(c => c.h));
    const minL   = Math.min(...win.map(c => c.l));
    if (candles[i].h === maxH) swings.push({ i, t: candles[i].t, c: candles[i].h, type: 'H' });
    if (candles[i].l === minL) swings.push({ i, t: candles[i].t, c: candles[i].l, type: 'L' });
  }

  swings.sort((a, b) => a.i - b.i);

  // Temizle — Python _clean_swings ile aynı
  const cleaned = [];
  for (const s of swings) {
    if (!cleaned.length) { cleaned.push(s); continue; }
    const last = cleaned[cleaned.length - 1];
    if (s.type === last.type) {
      if (s.type === 'H' && s.c > last.c) cleaned[cleaned.length - 1] = s;
      else if (s.type === 'L' && s.c < last.c) cleaned[cleaned.length - 1] = s;
    } else {
      const move = Math.abs(s.c - last.c) / last.c;
      if (move >= minPctMove) cleaned.push(s);
    }
  }
  return cleaned;
}

// Formasyon tarama — Python scan_patterns ile aynı mantık
function scanPatterns(candles, minQuality = 40, leftBars = 3, rightBars = 3) {
  const swings = findSwingPoints(candles, leftBars, rightBars);
  if (swings.length < 5) return [];

  const results = [];
  const seen    = new Set();

  for (let di = 4; di < swings.length; di++) {
    const window = swings.slice(Math.max(0, di - 29), di + 1);
    if (window.length < 5) continue;

    for (let i = 0; i <= window.length - 5; i++) {
      const [X, A, B, C, D] = window.slice(i, i + 5);
      const key = `${X.i}-${A.i}-${B.i}-${C.i}-${D.i}`;
      if (seen.has(key)) continue;

      const direction = A.c > X.c ? 'bullish' : 'bearish';
      const ratios    = calcHarmonicRatios(X, A, B, C, D);
      const XA        = Math.abs(A.c - X.c);
      const AB        = Math.abs(B.c - A.c);
      if (AB > XA * 2.5 || AB < XA * 0.1) continue;

      for (const pc of PATTERN_CHECKERS) {
        if (!pc.check(ratios)) continue;
        const quality = qualityScore(ratios, pc.targets);
        if (quality < minQuality) continue;
        seen.add(key);
        const { prz, sl, tp1, tp2, tp3 } = calcTargets(X, A, D, direction);
        results.push({ name: pc.name, direction, quality, X, A, B, C, D, ratios, prz, sl, tp1, tp2, tp3 });
        break;
      }
    }
  }

  return results.sort((a, b) => b.quality - a.quality);
}

// ════════════════════════════════════════════════════════════
//  BACKTEST MOTORU
//  Python backtester.py ile birebir aynı mantık
// ════════════════════════════════════════════════════════════
function runBacktest(candles, { minQuality = 40, tpMode = 'TP2', leftBars = 3, rightBars = 3 } = {}) {
  const swings = findSwingPoints(candles, leftBars, rightBars);
  if (swings.length < 5) return {};

  const allTrades = [];
  const seen      = new Set();

  for (let di = 4; di < swings.length; di++) {
    const window = swings.slice(Math.max(0, di - 29), di + 1);
    if (window.length < 5) continue;

    for (let i = 0; i <= window.length - 5; i++) {
      const [X, A, B, C, D] = window.slice(i, i + 5);
      const key = `${X.i}-${A.i}-${B.i}-${C.i}-${D.i}`;
      if (seen.has(key)) continue;

      const direction = A.c > X.c ? 'bullish' : 'bearish';
      const ratios    = calcHarmonicRatios(X, A, B, C, D);
      const XA        = Math.abs(A.c - X.c);
      const AB        = Math.abs(B.c - A.c);
      if (AB > XA * 2.5 || AB < XA * 0.1) continue;

      for (const pc of PATTERN_CHECKERS) {
        if (!pc.check(ratios)) continue;
        const quality = qualityScore(ratios, pc.targets);
        if (quality < minQuality) continue;
        seen.add(key);

        const { prz, sl, tp1, tp2, tp3 } = calcTargets(X, A, D, direction);
        const target = tpMode === 'TP1' ? tp1 : tpMode === 'TP3' ? tp3 : tp2;

        // Simülasyon — Python _simulate_trade ile aynı
        const future = candles.slice(D.i + 1, D.i + 101);
        let exitPrice = null, exitReason = 'TIMEOUT';

        for (const bar of future) {
          if (direction === 'bullish') {
            if (bar.l <= sl) { exitPrice = sl; exitReason = 'SL'; break; }
            if (bar.h >= target) { exitPrice = target; exitReason = tpMode; break; }
          } else {
            if (bar.h >= sl) { exitPrice = sl; exitReason = 'SL'; break; }
            if (bar.l <= target) { exitPrice = target; exitReason = tpMode; break; }
          }
        }

        if (exitPrice === null) exitPrice = future.length ? future[future.length - 1].c : prz;

        const pnlPct = direction === 'bullish'
          ? (exitPrice - prz) / prz * 100
          : (prz - exitPrice) / prz * 100;

        const risk = Math.abs(prz - sl);
        const rr   = risk > 0 ? Math.abs(exitPrice - prz) / risk : 0;

        allTrades.push({
          pattern: pc.name, direction, quality,
          entryPrice: prz, exitPrice, sl, tp1, tp2, tp3,
          exitReason, pnlPct: parseFloat(pnlPct.toFixed(4)),
          rr: parseFloat(rr.toFixed(2)),
          entryTime: new Date(D.t).toISOString(),
        });
        break;
      }
    }
  }

  // İstatistik hesapla — Python _calculate_stats ile aynı
  const byPattern = {};
  for (const t of allTrades) {
    if (!byPattern[t.pattern]) byPattern[t.pattern] = [];
    byPattern[t.pattern].push(t);
  }

  const stats = {};
  for (const [name, trades] of Object.entries(byPattern)) {
    const wins   = trades.filter(t => t.pnlPct > 0);
    const losses = trades.filter(t => t.pnlPct <= 0);
    const gProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
    const gLoss   = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
    const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);

    // Max drawdown
    let peak = 0, maxDD = 0, cum = 0;
    for (const t of trades) {
      cum += t.pnlPct;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }

    stats[name] = {
      pattern:      name,
      trades:       trades.length,
      wins:         wins.length,
      losses:       losses.length,
      winRate:      parseFloat((wins.length / trades.length * 100).toFixed(1)),
      profitFactor: gLoss > 0 ? parseFloat((gProfit / gLoss).toFixed(2)) : 99,
      totalPnl:     parseFloat(totalPnl.toFixed(2)),
      avgWin:       wins.length ? parseFloat((gProfit / wins.length).toFixed(2)) : 0,
      avgLoss:      losses.length ? parseFloat((gLoss / losses.length * -1).toFixed(2)) : 0,
      maxDrawdown:  parseFloat(maxDD.toFixed(2)),
      bullish:      trades.filter(t => t.direction === 'bullish').length,
      bearish:      trades.filter(t => t.direction === 'bearish').length,
      trades_list:  trades.slice(-30),
    };
  }

  return stats;
}

// ════════════════════════════════════════════════════════════
//  BOT ENGINE
// ════════════════════════════════════════════════════════════
class BotRunner {
  constructor(id, config, api) {
    this.id       = id;
    this.config   = config;
    this.api      = api;
    this.running  = false;
    this.trades   = [];
    this.pnl      = 0;
    this.wins     = 0;
    this.losses   = 0;
    this.interval = null;
    this.wsConn   = null;
    this.candles  = [];
    this.position = null;
    this.log      = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.bot(`Bot [${this.id}] başlatıldı: ${this.config.symbol} ${this.config.interval}`);
    this._addLog(`Bot başlatıldı — ${this.config.symbol} ${this.config.interval}`);
    this._loadCandles().then(() => this._connectStream());
  }

  stop() {
    this.running = false;
    if (this.wsConn) { this.wsConn.terminate(); this.wsConn = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    log.bot(`Bot [${this.id}] durduruldu`);
    this._addLog('Bot durduruldu');
  }

  async _loadCandles() {
    try {
      const raw = await this.api.klines(this.config.symbol, this.config.interval, 300);
      this.candles = raw.map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
      this._addLog(`${this.candles.length} mum yüklendi`);
    } catch (e) {
      this._addLog(`Mum yükleme hatası: ${e.message}`);
    }
  }

  _connectStream() {
    const sym   = this.config.symbol.toLowerCase();
    const tf    = this.config.interval;
    const wsUrl = `${CONFIG.BINANCE_WS}/ws/${sym}@kline_${tf}`;

    try {
      this.wsConn = new WebSocket(wsUrl);

      this.wsConn.on('open', () => this._addLog(`WebSocket bağlandı: ${sym}@kline_${tf}`));

      this.wsConn.on('message', data => {
        try {
          const msg    = JSON.parse(data.toString());
          if (!msg.k) return;
          const k      = msg.k;
          const candle = { t:k.t, o:+k.o, h:+k.h, l:+k.l, c:+k.c, v:+k.v };
          const last   = this.candles[this.candles.length - 1];

          if (last && last.t === candle.t) this.candles[this.candles.length - 1] = candle;
          else if (k.x) { this.candles.push(candle); if (this.candles.length > 500) this.candles.shift(); }

          if (this.running) this._checkSLTP(candle.c);
          if (k.x && this.running) this._runStrategy(candle);

          broadcast({ type:'bot_tick', botId:this.id, candle, position:this.position });
        } catch (e) {}
      });

      this.wsConn.on('error', e => {
        this._addLog(`WS hata: ${e.message}`);
        setTimeout(() => { if (this.running) this._connectStream(); }, 5000);
      });

      this.wsConn.on('close', () => {
        if (this.running) {
          this._addLog('WS kapandı — 5s sonra yeniden bağlanıyor');
          setTimeout(() => this._connectStream(), 5000);
        }
      });
    } catch (e) {
      this._addLog(`WS bağlantı hatası: ${e.message}`);
    }
  }

  _runStrategy(candle) {
    const closes = this.candles.map(c => c.c);
    const indicators = {
      rsi:  (p=14)        => calcRSI(closes, p),
      sma:  (p=20)        => calcSMA(closes, p),
      ema:  (p=20)        => calcEMA(closes, p),
      bb:   (p=20, std=2) => calcBB(closes, p, std),
      macd: (f=12, s=26, sig=9) => calcMACD(closes, f, s, sig),
      atr:  (p=14)        => calcATR(this.candles, p),
    };

    let signal = 'hold';
    let slPct  = this.config.stopLoss  || 2;
    let tpPct  = this.config.takeProfit || 4;

    try {
      signal = this._evalStrategy(candle, indicators, slPct, tpPct);
    } catch (e) {
      this._addLog(`Strateji hatası: ${e.message}`);
      return;
    }

    this._executeSignal(signal, candle, slPct, tpPct);
  }

  _evalStrategy(candle, indicators, slPct, tpPct) {
    const strat = this.config.strategy || 'rsi';

    // ── Yerleşik stratejiler ──────────────────────────────
    if (strat === 'rsi') {
      const rsi = indicators.rsi(14);
      if (rsi < 30 && !this.position) return 'buy';
      if (rsi > 70 && this.position)  return 'sell';
      return 'hold';
    }

    if (strat === 'ma') {
      const ema9  = indicators.ema(9);
      const ema21 = indicators.ema(21);
      const closes = this.candles.slice(-3).map(c => c.c);
      const prevEma9  = calcEMAArr(closes.slice(0, -1), 9).slice(-1)[0];
      const prevEma21 = calcEMAArr(closes.slice(0, -1), 21).slice(-1)[0];
      if (ema9 > ema21 && prevEma9 <= prevEma21 && !this.position) return 'buy';
      if (ema9 < ema21 && prevEma9 >= prevEma21 && this.position)  return 'sell';
      return 'hold';
    }

    if (strat === 'bb') {
      const bb = indicators.bb(20, 2);
      if (!bb) return 'hold';
      if (candle.c <= bb.lower && !this.position) return 'buy';
      if (candle.c >= bb.upper && this.position)  return 'sell';
      return 'hold';
    }

    if (strat === 'macd') {
      const { macdLine, signalLine } = indicators.macd(12, 26, 9);
      if (macdLine > signalLine && !this.position) return 'buy';
      if (macdLine < signalLine && this.position)  return 'sell';
      return 'hold';
    }

    // ── Harmonik Formasyon Stratejisi ─────────────────────
    if (strat === 'harmonic') {
      return this._evalHarmonic(candle);
    }

    // ── Özel kod ──────────────────────────────────────────
    if (strat === 'custom' && this.config.code) {
      return this._runCustomCode(candle, indicators);
    }

    return 'hold';
  }

  _evalHarmonic(candle) {
    if (this.candles.length < 30) return 'hold';

    // Mevcut pozisyon — RSI ile çıkış
    if (this.position) {
      const rsi = calcRSI(this.candles.map(c => c.c), 14);
      if (rsi > 75) {
        this._addLog(`📉 Harmonik çıkış: RSI=${rsi.toFixed(1)} aşırı alım`);
        return 'sell';
      }
      return 'hold';
    }

    // Formasyon tara
    const patterns = scanPatterns(this.candles, 60, 3, 3);
    if (!patterns.length) return 'hold';

    const p = patterns[0]; // En kaliteli formasyon
    if (p.direction !== 'bullish') return 'hold';

    const xaRange = Math.abs(p.A.c - p.X.c);
    const slPct   = (xaRange * 0.10 / p.D.c) * 100;
    const tpPct   = (Math.abs(p.A.c - p.D.c) * 0.618 / p.D.c) * 100;
    this.config.stopLoss   = slPct;
    this.config.takeProfit = tpPct;

    this._addLog(`🔺 ${p.name} (${p.quality}/100) | SL:${slPct.toFixed(1)}% TP:${tpPct.toFixed(1)}%`);
    broadcast({
      type: 'harmonic_signal', botId: this.id,
      pattern: p.name, direction: p.direction, quality: p.quality,
      prz: p.prz, sl: p.sl, tp1: p.tp1, tp2: p.tp2,
    });
    return 'buy';
  }

  _runCustomCode(candle, indicators) {
    const context = {
      candle,
      indicators: {
        rsi:  (p=14)        => indicators.rsi(p),
        ema:  (p=20)        => indicators.ema(p),
        sma:  (p=20)        => indicators.sma(p),
        bb:   (p=20, std=2) => indicators.bb(p, std),
        macd: (f=12,s=26,sig=9) => indicators.macd(f,s,sig),
        atr:  (p=14)        => indicators.atr(p),
      },
      portfolio: { usdt: this.config.capital || 1000, has_position: !!this.position, pnl: this.pnl },
    };
    let result = 'hold';
    const setResult = v => { result = v; };
    try {
      const fn = new Function(
        'candle','indicators','portfolio','buy','sell','hold',
        `"use strict";\n${this._transformCode(this.config.code)}`
      );
      fn(context.candle, context.indicators, context.portfolio,
        () => setResult('buy'), () => setResult('sell'), () => setResult('hold'));
    } catch (e) {
      this._addLog(`Özel kod hatası: ${e.message}`);
    }
    return result;
  }

  _transformCode(code) {
    return code
      .replace(/def \w+\([^)]*\):/g, '')
      .replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null')
      .replace(/elif /g, 'else if (').replace(/if /g, 'if (')
      .replace(/and /g, ' && ').replace(/or /g, ' || ').replace(/not /g, '!')
      .replace(/#[^\n]*/g, '');
  }

  async _executeSignal(signal, candle, slPct, tpPct) {
    if (signal === 'hold') return;
    const capital    = this.config.capital   || 1000;
    const posSizePct = this.config.maxPosPct || 25;
    const symbol     = this.config.symbol;

    if (signal === 'buy' && !this.position) {
      const usdt    = capital * (posSizePct / 100);
      const qty     = parseFloat((usdt / candle.c).toFixed(6));
      const slPrice = parseFloat((candle.c * (1 - slPct / 100)).toFixed(2));
      const tpPrice = parseFloat((candle.c * (1 + tpPct / 100)).toFixed(2));
      try {
        if (this.config.live) {
          await this._placeRealOrder(symbol, 'BUY', qty, candle.c, slPrice, tpPrice);
        } else {
          this.position = { side:'BUY', qty, entryPrice:candle.c, sl:slPrice, tp:tpPrice };
          this._addLog(`📈 ALIŞ (Paper): ${qty} ${symbol} @ $${candle.c.toFixed(2)} | SL:${slPrice} TP:${tpPrice}`);
        }
        this.trades.push({ type:'buy', price:candle.c, qty, ts:candle.t, sl:slPrice, tp:tpPrice });
        broadcast({ type:'bot_trade', botId:this.id, signal:'buy', candle, qty, sl:slPrice, tp:tpPrice });
        log.trade(`Bot [${this.id}] BUY: ${qty} @ ${candle.c}`);
      } catch (e) { this._addLog(`Alım hatası: ${e.message}`); }
    }

    if (signal === 'sell' && this.position) {
      const qty = this.position.qty;
      const pnl = (candle.c - this.position.entryPrice) * qty;
      this.pnl += pnl;
      if (pnl > 0) this.wins++; else this.losses++;
      try {
        if (this.config.live) {
          await this._placeRealOrder(symbol, 'SELL', qty, candle.c);
        } else {
          this._addLog(`📉 SATIŞ (Paper): ${qty} @ $${candle.c.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
        }
        this.trades.push({ type:'sell', price:candle.c, qty, ts:candle.t, pnl });
        this.position = null;
        broadcast({ type:'bot_trade', botId:this.id, signal:'sell', candle, qty, pnl });
        log.trade(`Bot [${this.id}] SELL @ ${candle.c} | PnL: ${pnl.toFixed(2)}`);
      } catch (e) { this._addLog(`Satış hatası: ${e.message}`); }
    }
  }

  async _placeRealOrder(symbol, side, qty, price, sl, tp) {
    const order = await this.api.newOrder({
      symbol, side, type:'LIMIT', timeInForce:'GTC',
      quantity: qty, price: price.toFixed(2),
    });
    this._addLog(`Gerçek emir: ${order.orderId} — ${side} ${qty} @ ${price}`);
    if (sl && tp && side === 'BUY') {
      this.position = { side:'BUY', qty, entryPrice:price, sl, tp, orderId:order.orderId };
    }
    return order;
  }

  _checkSLTP(currentPrice) {
    if (!this.position) return;
    const { sl, tp, side } = this.position;
    if (!sl && !tp) return;
    if (side === 'BUY') {
      if (sl && currentPrice <= sl) {
        this._addLog(`🛑 Stop Loss: $${currentPrice} ≤ SL $${sl}`);
        this._forceClose(currentPrice, 'stop_loss');
      } else if (tp && currentPrice >= tp) {
        this._addLog(`🎯 Take Profit: $${currentPrice} ≥ TP $${tp}`);
        this._forceClose(currentPrice, 'take_profit');
      }
    }
  }

  async _forceClose(price, reason) {
    if (!this.position) return;
    const qty = this.position.qty;
    const pnl = (price - this.position.entryPrice) * qty;
    this.pnl += pnl;
    if (pnl > 0) this.wins++; else this.losses++;
    this.trades.push({ type:'close', price, qty, reason, pnl });
    this.position = null;
    broadcast({ type:'bot_close', botId:this.id, reason, price, pnl });
    if (this.config.live && this.api) {
      try { await this.api.newOrder({ symbol:this.config.symbol, side:'SELL', type:'MARKET', quantity:qty }); }
      catch (e) { this._addLog(`Force close hatası: ${e.message}`); }
    }
  }

  getStats() {
    const total = this.wins + this.losses;
    return {
      id: this.id, name: this.config.name, symbol: this.config.symbol,
      interval: this.config.interval, strategy: this.config.strategy,
      running: this.running, trades: this.trades.length,
      wins: this.wins, losses: this.losses,
      winRate: total > 0 ? ((this.wins / total) * 100).toFixed(1) : 0,
      pnl: this.pnl.toFixed(2), position: this.position,
      log: this.log.slice(-50),
    };
  }

  _addLog(msg) {
    const entry = { ts: new Date().toISOString(), msg };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    broadcast({ type:'bot_log', botId:this.id, entry });
  }
}

// ════════════════════════════════════════════════════════════
//  EXPRESS APP
// ════════════════════════════════════════════════════════════
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'PUT'] }));
app.use(express.json({ limit: '2mb' }));

const limiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ───────────────────────────────────────
function getAPI(req, res) {
  const sessionId = req.headers['x-session-id'] || req.body?.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(401).json({ error: 'Oturum gerekli' });
    return null;
  }
  const s = sessions.get(sessionId);
  return new BinanceAPI(s.apiKey, s.apiSecret);
}

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status:'ok', uptime: process.uptime(), bots: bots.size, version:'2.0' });
});

// ── Auth ──────────────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'apiKey ve apiSecret gerekli' });
  try {
    const api = new BinanceAPI(apiKey, apiSecret);
    await api.ping();
    const sessionId = crypto.randomBytes(16).toString('hex');
    sessions.set(sessionId, { apiKey, apiSecret, ts: Date.now() });
    res.json({ success:true, sessionId });
  } catch (e) {
    res.status(401).json({ error: 'Geçersiz API anahtarları', message: e.message });
  }
});

app.delete('/api/auth', (req, res) => {
  const sid = req.headers['x-session-id'];
  if (sid) sessions.delete(sid);
  res.json({ success:true });
});

// ── Account ───────────────────────────────────────────────
app.get('/api/account', async (req, res) => {
  const api = getAPI(req, res); if (!api) return;
  try { res.json(await api.accountInfo()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Market Data ───────────────────────────────────────────
app.get('/api/ticker/:symbol', async (req, res) => {
  try { res.json(await new BinanceAPI('','').ticker24h(req.params.symbol)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/klines/:symbol', async (req, res) => {
  const { interval = '1h', limit = 200 } = req.query;
  try { res.json(await new BinanceAPI('','').klines(req.params.symbol, interval, +limit)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orderbook/:symbol', async (req, res) => {
  try { res.json(await new BinanceAPI('','').orderBook(req.params.symbol, 20)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trades/:symbol', async (req, res) => {
  try { res.json(await new BinanceAPI('','').recentTrades(req.params.symbol, 50)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Orders ────────────────────────────────────────────────
app.post('/api/order', async (req, res) => {
  const api = getAPI(req, res); if (!api) return;
  try { res.json(await api.newOrder(req.body)); }
  catch (e) { res.status(500).json({ error: e.message, code: e.code }); }
});

app.delete('/api/order/:symbol/:orderId', async (req, res) => {
  const api = getAPI(req, res); if (!api) return;
  try { res.json(await api.cancelOrder(req.params.symbol, req.params.orderId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:symbol', async (req, res) => {
  const api = getAPI(req, res); if (!api) return;
  try { res.json(await api.openOrders(req.params.symbol)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/:symbol', async (req, res) => {
  const api = getAPI(req, res); if (!api) return;
  try { res.json(await api.allOrders(req.params.symbol, 50)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bots ─────────────────────────────────────────────────
app.get('/api/bots', (req, res) => {
  res.json(Array.from(bots.values()).map(b => b.getStats()));
});

app.post('/api/bots', (req, res) => {
  const api    = getAPI(req, res); if (!api) return;
  const config = req.body;
  if (!config.symbol || !config.strategy)
    return res.status(400).json({ error: 'symbol ve strategy gerekli' });
  const botId = `bot_${Date.now()}`;
  const bot   = new BotRunner(botId, config, api);
  bots.set(botId, bot);
  bot.start();
  log.bot(`Yeni bot: ${botId}`);
  res.json({ success:true, botId, stats: bot.getStats() });
});

app.put('/api/bots/:id/stop',  (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot bulunamadı' });
  bot.stop(); res.json({ success:true, stats: bot.getStats() });
});

app.put('/api/bots/:id/start', (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot bulunamadı' });
  bot.start(); res.json({ success:true, stats: bot.getStats() });
});

app.delete('/api/bots/:id', (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot bulunamadı' });
  bot.stop(); bots.delete(req.params.id); res.json({ success:true });
});

app.get('/api/bots/:id', (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot bulunamadı' });
  res.json(bot.getStats());
});

// ── BACKTEST — Gerçek Binance verisiyle ───────────────────
app.post('/api/backtest', async (req, res) => {
  const {
    symbol    = 'BTCUSDT',
    interval  = '4h',
    days      = 90,
    minQuality = 40,
    tpMode    = 'TP2',
    leftBars  = 3,
    rightBars = 3,
  } = req.body;

  log.bot(`Backtest: ${symbol} ${interval} ${days}g`);

  try {
    // Binance'den gerçek veri çek (API key gerektirmez)
    const pubApi  = new BinanceAPI('', '');
    const candles = await pubApi.fetchHistorical(symbol, interval, days);

    if (!candles || candles.length < 50)
      return res.json({ success:false, error: 'Yeterli veri yüklenemedi' });

    log.bot(`${candles.length} mum yüklendi, backtest başlıyor...`);

    // Harmonik backtest
    const stats = runBacktest(candles, { minQuality, tpMode, leftBars, rightBars });

    // Özet istatistikler
    const allStats   = Object.values(stats);
    const totalTrades = allStats.reduce((s, x) => s + x.trades, 0);
    const totalWins   = allStats.reduce((s, x) => s + x.wins, 0);
    const totalPnl    = parseFloat(allStats.reduce((s, x) => s + x.totalPnl, 0).toFixed(2));
    const maxDD       = Math.max(...allStats.map(x => x.maxDrawdown), 0);
    const winRate     = totalTrades > 0 ? parseFloat((totalWins / totalTrades * 100).toFixed(1)) : 0;
    const sharpe      = parseFloat((totalPnl / Math.max(Math.abs(totalPnl * 0.3), 1)).toFixed(2));
    const best        = allStats.sort((a, b) => b.profitFactor - a.profitFactor)[0];

    // Equity curve
    const allTrades = allStats.flatMap(s => s.trades_list || []);
    allTrades.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));
    let cum = 0;
    const equity = allTrades.map(t => { cum += t.pnlPct; return parseFloat(cum.toFixed(3)); });

    res.json({
      success: true, symbol, interval, days,
      totalTrades, totalWins, winRate, totalPnl, maxDrawdown: maxDD, sharpe,
      bestPattern:  best?.pattern || '—',
      bestWinRate:  best?.winRate || 0,
      bestPF:       best?.profitFactor || 0,
      patterns:     allStats.filter(s => s.trades > 0),
      equity:       equity.slice(-100),
    });

  } catch (e) {
    log.error('Backtest hatası:', e.message);
    res.status(500).json({ success:false, error: e.message });
  }
});

// ── Harmonik Tarama (canlı grafik için) ───────────────────
app.get('/api/harmonics/:symbol', async (req, res) => {
  const { interval = '4h', limit = 300, minQuality = 50 } = req.query;
  try {
    const raw     = await new BinanceAPI('','').klines(req.params.symbol, interval, +limit);
    const candles = raw.map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
    const patterns = scanPatterns(candles, +minQuality);
    res.json({ success:true, count: patterns.length, patterns: patterns.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ success:false, error: e.message });
  }
});

// ── Indicators ────────────────────────────────────────────
app.post('/api/indicators', (req, res) => {
  const { candles: c, indicators: inds } = req.body;
  if (!c || !inds) return res.status(400).json({ error: 'candles ve indicators gerekli' });
  const closes = c.map(x => x.c);
  const result = {};
  if (inds.rsi)  result.rsi  = calcRSI(closes, inds.rsi.period || 14);
  if (inds.sma)  result.sma  = calcSMA(closes, inds.sma.period || 20);
  if (inds.ema)  result.ema  = calcEMA(closes, inds.ema.period || 20);
  if (inds.bb)   result.bb   = calcBB(closes, inds.bb.period || 20, inds.bb.std || 2);
  if (inds.macd) result.macd = calcMACD(closes, 12, 26, 9);
  if (inds.atr)  result.atr  = calcATR(c, inds.atr.period || 14);
  res.json(result);
});

// ── 404 & Error ───────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Endpoint bulunamadı' }));
app.use((err, req, res, next) => {
  log.error('Unhandled:', err.message);
  res.status(500).json({ error: 'Sunucu hatası', message: err.message });
});

// ════════════════════════════════════════════════════════════
//  WEBSOCKET SERVER
// ════════════════════════════════════════════════════════════
const httpServer = http.createServer(app);
const wss        = new WebSocket.Server({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  clients.add(ws);
  log.info(`WS client bağlandı: ${req.socket.remoteAddress} (toplam: ${clients.size})`);
  ws.send(JSON.stringify({
    type: 'connected', message: 'NexusTrade WS bağlandı',
    bots: Array.from(bots.values()).map(b => b.getStats()),
  }));

  ws.on('message', async data => {
    try { await handleWSMessage(ws, JSON.parse(data.toString())); }
    catch (e) { ws.send(JSON.stringify({ type:'error', message: e.message })); }
  });

  ws.on('close', () => { clients.delete(ws); log.info(`WS ayrıldı (kalan: ${clients.size})`); });
  ws.on('error', e => { clients.delete(ws); });

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 30_000);
});

async function handleWSMessage(ws, msg) {
  const send = data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const { type, sessionId, payload } = msg;

  switch (type) {
    case 'ping': send({ type:'pong', ts: Date.now() }); break;

    case 'subscribe_ticker': {
      const sym = (payload?.symbol || 'BTCUSDT').toLowerCase();
      startBinanceProxy(ws, `${sym}@miniTicker`);
      break;
    }
    case 'subscribe_kline': {
      const sym = (payload?.symbol || 'BTCUSDT').toLowerCase();
      const tf  = payload?.interval || '1m';
      startBinanceProxy(ws, `${sym}@kline_${tf}`);
      break;
    }
    case 'subscribe_depth': {
      const sym = (payload?.symbol || 'BTCUSDT').toLowerCase();
      startBinanceProxy(ws, `${sym}@depth20@100ms`);
      break;
    }
    case 'subscribe_trades': {
      const sym = (payload?.symbol || 'BTCUSDT').toLowerCase();
      startBinanceProxy(ws, `${sym}@trade`);
      break;
    }
    case 'get_bots':
      send({ type:'bots', data: Array.from(bots.values()).map(b => b.getStats()) });
      break;

    case 'place_order': {
      if (!sessionId || !sessions.has(sessionId)) { send({ type:'error', message:'Oturum gerekli' }); break; }
      const s   = sessions.get(sessionId);
      const api = new BinanceAPI(s.apiKey, s.apiSecret);
      try {
        const order = await api.newOrder(payload);
        send({ type:'order_placed', order });
      } catch (e) {
        send({ type:'order_error', error: e.message, code: e.code });
      }
      break;
    }

    default:
      send({ type:'error', message: `Bilinmeyen: ${type}` });
  }
}

const proxyConnections = new Map();
function startBinanceProxy(clientWS, stream) {
  const url = `${CONFIG.BINANCE_WS}/ws/${stream}`;
  const key = `${clientWS._socket?.remoteAddress}:${stream}`;
  if (proxyConnections.has(key)) proxyConnections.get(key).terminate();
  try {
    const binWS = new WebSocket(url);
    binWS.on('message', data => {
      if (clientWS.readyState === WebSocket.OPEN)
        clientWS.send(JSON.stringify({ type:'stream', stream, data: JSON.parse(data.toString()) }));
      else binWS.terminate();
    });
    binWS.on('error', () => proxyConnections.delete(key));
    binWS.on('close', () => proxyConnections.delete(key));
    proxyConnections.set(key, binWS);
  } catch (e) { log.error('Proxy hatası:', e.message); }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
httpServer.listen(CONFIG.PORT, () => {
  log.info(`╔══════════════════════════════════════╗`);
  log.info(`║   NexusTrade PRO Backend v2.0        ║`);
  log.info(`╠══════════════════════════════════════╣`);
  log.info(`║  REST API : http://localhost:${CONFIG.PORT}     ║`);
  log.info(`║  WebSocket: ws://localhost:${CONFIG.PORT}/ws   ║`);
  log.info(`║  Harmonik : 13 formasyon dahil        ║`);
  log.info(`╚══════════════════════════════════════╝`);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
function shutdown() {
  log.info('Kapatılıyor...');
  for (const bot of bots.values()) bot.stop();
  httpServer.close(() => { log.info('Kapatıldı.'); process.exit(0); });
}
