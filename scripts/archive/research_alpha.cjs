const fs = require('node:fs');
const path = require('node:path');

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FEE_BPS = Number(process.env.FEE_BPS || 10);
const SLIP_BPS = Number(process.env.SLIP_BPS || 2);
const LEVERAGE = Number(process.env.LEVERAGE || 2.1);
const NO_JSON = process.argv.includes('--no-json') || process.env.NO_JSON === '1';
const WALK_FORWARD = process.argv.includes('--walk-forward');
const WINDOW_DAYS = Number((process.argv.find((arg) => arg.startsWith('--window-days=')) || '').split('=')[1] || 30);
const TOP_COUNT = Number((process.argv.find((arg) => arg.startsWith('--top=')) || '').split('=')[1] || 0);
const OUTPUT_NAME = String(
  (process.argv.find((arg) => arg.startsWith('--out=')) || '').split('=')[1]
  || 'research_alpha_walk_forward_latest',
).replace(/[^a-zA-Z0-9_-]/g, '_');

async function fetchCandles(symbol, interval, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit: 1000 }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} ${interval} Binance ${res.status}: ${await res.text()}`);
    const raw = await res.json();
    if (!raw.length) break;
    for (const k of raw) all.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    const next = +raw.at(-1)[6] + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(35);
  }
  return [...new Map(all.map((candle) => [candle.t, candle])).values()].sort((a, b) => a.t - b.t);
}

async function fetchTopUsdtSymbols(limit = 20) {
  const stableOrFiat = new Set([
    'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1',
    'RLUSD', 'XUSD', 'EUR', 'TRY', 'BRL', 'ARS', 'AEUR', 'PAXG', 'XAUT',
  ]);
  const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
  if (!res.ok) throw new Error(`Binance ticker ${res.status}: ${await res.text()}`);
  const tickers = await res.json();
  return tickers
    .filter((item) => {
      const symbol = String(item.symbol || '');
      if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
      const base = symbol.slice(0, -4);
      if (stableOrFiat.has(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
      return Number(item.quoteVolume || 0) > 0;
    })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((item) => item.symbol);
}

function ema(values, period) {
  const out = [];
  const alpha = 2 / (period + 1);
  let prev = null;
  for (const value of values) {
    prev = prev == null ? value : value * alpha + prev * (1 - alpha);
    out.push(prev);
  }
  return out;
}

function dema(values, period) {
  const first = ema(values, period);
  const second = ema(first, period);
  return first.map((value, index) => 2 * value - second[index]);
}

function sma(values, period) {
  const out = [];
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += values[i];
    if (i >= period) total -= values[i - period];
    out.push(total / Math.min(period, i + 1));
  }
  return out;
}

function std(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    const w = values.slice(start, i + 1);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    out.push(Math.sqrt(w.reduce((sum, value) => sum + (value - mean) ** 2, 0) / w.length));
  }
  return out;
}

function rma(values, period) {
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (prev == null) prev = value;
    else if (i <= period) prev = (prev * (i - 1) + value) / i;
    else prev = (prev * (period - 1) + value) / period;
    out.push(prev);
  }
  return out;
}

function trueRange(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1].c : c.c;
    out.push(Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev)));
  }
  return out;
}

function rsi(closes, period = 14) {
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }
  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);
  return closes.map((_, i) => {
    if (avgLoss[i] === 0) return avgGain[i] > 0 ? 100 : 50;
    const rs = avgGain[i] / avgLoss[i];
    return 100 - 100 / (1 + rs);
  });
}

function stochastic(candles, period = 14) {
  return candles.map((candle, index) => {
    const start = Math.max(0, index - period + 1);
    let low = Infinity;
    let high = -Infinity;
    for (let i = start; i <= index; i += 1) {
      low = Math.min(low, candles[i].l);
      high = Math.max(high, candles[i].h);
    }
    return high === low ? 50 : (candle.c - low) / (high - low) * 100;
  });
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = f.map((value, i) => value - s[i]);
  const sig = ema(line, signal);
  return line.map((value, i) => value - sig[i]);
}

function adx(candles, period = 14) {
  const tr = trueRange(candles);
  const plusDm = [0];
  const minusDm = [0];
  for (let i = 1; i < candles.length; i += 1) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const atr = rma(tr, period);
  const plus = rma(plusDm, period).map((value, i) => atr[i] > 0 ? (100 * value) / atr[i] : 0);
  const minus = rma(minusDm, period).map((value, i) => atr[i] > 0 ? (100 * value) / atr[i] : 0);
  const dx = plus.map((value, i) => {
    const sum = value + minus[i];
    return sum > 0 ? (100 * Math.abs(value - minus[i])) / sum : 0;
  });
  return rma(dx, period);
}

function supertrend(candles, atr, mult) {
  const dir = [];
  const line = [];
  let finalUpper = 0;
  let finalLower = 0;
  let trend = 1;
  for (let i = 0; i < candles.length; i += 1) {
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const upper = hl2 + mult * atr[i];
    const lower = hl2 - mult * atr[i];
    if (i === 0) {
      finalUpper = upper;
      finalLower = lower;
    } else {
      finalUpper = upper < finalUpper || candles[i - 1].c > finalUpper ? upper : finalUpper;
      finalLower = lower > finalLower || candles[i - 1].c < finalLower ? lower : finalLower;
      if (trend < 0 && candles[i].c > finalUpper) trend = 1;
      else if (trend > 0 && candles[i].c < finalLower) trend = -1;
    }
    dir.push(trend);
    line.push(trend > 0 ? finalLower : finalUpper);
  }
  return { dir, line };
}

function highest(values, period, i, excludeCurrent = true) {
  const end = excludeCurrent ? i : i + 1;
  const start = Math.max(0, end - period);
  return Math.max(...values.slice(start, end));
}

function lowest(values, period, i, excludeCurrent = true) {
  const end = excludeCurrent ? i : i + 1;
  const start = Math.max(0, end - period);
  return Math.min(...values.slice(start, end));
}

function buildContext(candles) {
  const close = candles.map((c) => c.c);
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const volume = candles.map((c) => c.v);
  const tr = trueRange(candles);
  const atr14 = rma(tr, 14);
  const bbBasis = sma(close, 20);
  const bbDev = std(close, 20);
  const kcBasis = ema(close, 20);
  return {
    candles,
    close,
    high,
    low,
    volume,
    atr14,
    adx14: adx(candles, 14),
    rsi14: rsi(close, 14),
    stoch14: stochastic(candles, 14),
    macdHist: macd(close),
    volSma20: sma(volume, 20),
    ema8: ema(close, 8),
    ema13: ema(close, 13),
    ema20: ema(close, 20),
    ema21: ema(close, 21),
    ema34: ema(close, 34),
    ema50: ema(close, 50),
    ema55: ema(close, 55),
    ema89: ema(close, 89),
    ema100: ema(close, 100),
    ema144: ema(close, 144),
    ema200: ema(close, 200),
    dema20: dema(close, 20),
    dema30: dema(close, 30),
    dema50: dema(close, 50),
    bbUpper: bbBasis.map((value, i) => value + 2 * bbDev[i]),
    bbLower: bbBasis.map((value, i) => value - 2 * bbDev[i]),
    bbBasis,
    kcUpper15: kcBasis.map((value, i) => value + 1.5 * atr14[i]),
    kcLower15: kcBasis.map((value, i) => value - 1.5 * atr14[i]),
    kcUpper20: kcBasis.map((value, i) => value + 2.0 * atr14[i]),
    kcLower20: kcBasis.map((value, i) => value - 2.0 * atr14[i]),
    st2: supertrend(candles, atr14, 2.0),
    st3: supertrend(candles, atr14, 3.0),
    st4: supertrend(candles, atr14, 4.0),
  };
}

function openPosition(side, candle, equity, stopDistance, targetDistance, meta) {
  const feeRate = FEE_BPS / 10000;
  const slipRate = SLIP_BPS / 10000;
  const notional = Math.max(0, equity * LEVERAGE);
  const entry = candle.o * (side === 'long' ? 1 + slipRate : 1 - slipRate);
  return {
    side,
    entry,
    qty: notional / entry,
    notional,
    entryFee: notional * feeRate,
    stop: side === 'long' ? entry - stopDistance : entry + stopDistance,
    target: targetDistance == null ? null : side === 'long' ? entry + targetDistance : entry - targetDistance,
    meta,
  };
}

function closePosition(pos, rawPrice, t, reason, equity, trades) {
  const feeRate = FEE_BPS / 10000;
  const slipRate = SLIP_BPS / 10000;
  const exit = rawPrice * (pos.side === 'long' ? 1 - slipRate : 1 + slipRate);
  const gross = pos.side === 'long' ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
  const exitFee = Math.abs(exit * pos.qty) * feeRate;
  const netPnl = gross - pos.entryFee - exitFee;
  trades.push({ side: pos.side, entry: pos.entry, exit, pnl: netPnl, reason, t, meta: pos.meta });
  // The entry fee was already removed when the position opened.
  return equity + gross - exitFee;
}

function stopOrTarget(pos, candle) {
  if (pos.side === 'long') {
    if (pos.stop != null && candle.l <= pos.stop) return [pos.stop, 'sl'];
    if (pos.target != null && candle.h >= pos.target) return [pos.target, 'tp'];
  } else {
    if (pos.stop != null && candle.h >= pos.stop) return [pos.stop, 'sl'];
    if (pos.target != null && candle.l <= pos.target) return [pos.target, 'tp'];
  }
  return [null, null];
}

function backtest(ctx, strategy, options = {}) {
  const start = Math.max(1, Number(options.start ?? 1));
  const end = Math.min(ctx.candles.length - 1, Number(options.end ?? ctx.candles.length - 1));
  const periodDays = Math.max(1, Number(options.days ?? strategy.days));
  let equity = 1000;
  let pos = null;
  let pending = null;
  let peak = 1000;
  let maxDd = 0;
  const trades = [];
  for (let i = start; i <= end; i += 1) {
    const candle = ctx.candles[i];
    if (pending && !pos) {
      pos = openPosition(pending.side, candle, equity, pending.stopDistance, pending.targetDistance, pending.meta);
      equity -= pos.entryFee;
    }
    pending = null;

    if (pos) {
      const [exit, reason] = stopOrTarget(pos, candle);
      if (exit != null) {
        equity = closePosition(pos, exit, candle.t, reason, equity, trades);
        pos = null;
      }
    }

    if (pos && strategy.trailAtr) {
      const atr = ctx.atr14[i] * strategy.trailAtr;
      if (pos.side === 'long') pos.stop = Math.max(pos.stop ?? -Infinity, ctx.close[i] - atr);
      else pos.stop = Math.min(pos.stop ?? Infinity, ctx.close[i] + atr);
    }

    const mark = pos
      ? equity + (pos.side === 'long' ? (ctx.close[i] - pos.entry) * pos.qty : (pos.entry - ctx.close[i]) * pos.qty)
      : equity;
    peak = Math.max(peak, mark);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - mark) / peak) * 100 : 0);

    const signal = i < end ? strategySignal(ctx, strategy, i, pos) : null;
    if (signal === 'close' && pos) {
      equity = closePosition(pos, candle.c, candle.t, 'signal', equity, trades);
      pos = null;
    } else if (signal && (!pos || pos.side !== signal)) {
      if (pos) {
        equity = closePosition(pos, candle.c, candle.t, 'reverse', equity, trades);
        pos = null;
      }
      const stopDist = Math.max(ctx.atr14[i] * strategy.stopAtr, ctx.close[i] * strategy.minStopPct / 100);
      const targetDist = stopDist * strategy.rr;
      pending = {
        side: signal,
        stopDistance: stopDist,
        targetDistance: strategy.noTp ? null : targetDist,
        meta: { name: strategy.name },
      };
    }
  }
  if (pos) equity = closePosition(pos, ctx.candles[end].c, ctx.candles[end].t, 'end', equity, trades);
  const wins = trades.filter((trade) => trade.pnl > 0);
  const profit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const loss = -trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const ret = (equity / 1000 - 1) * 100;
  return {
    ret,
    daily: ret <= -100 ? -100 : ((equity / 1000) ** (1 / periodDays) - 1) * 100,
    dd: maxDd,
    trades: trades.length,
    win: trades.length ? (wins.length / trades.length) * 100 : 0,
    pf: loss > 0 ? profit / loss : profit > 0 ? 99 : 0,
  };
}

function _ratingScore(ctx, i) {
  let score = 0;
  score += ctx.close[i] > ctx.ema20[i] ? 1 : -1;
  score += ctx.close[i] > ctx.ema50[i] ? 1 : -1;
  score += ctx.close[i] > ctx.ema100[i] ? 1 : -1;
  score += ctx.close[i] > ctx.ema200[i] ? 1 : -1;
  score += ctx.ema20[i] > ctx.ema50[i] ? 1 : -1;
  score += ctx.ema50[i] > ctx.ema100[i] ? 1 : -1;
  score += ctx.ema100[i] > ctx.ema200[i] ? 1 : -1;
  score += ctx.rsi14[i] > 55 ? 1 : ctx.rsi14[i] < 45 ? -1 : 0;
  score += ctx.macdHist[i] > 0 ? 1 : -1;
  score += ctx.close[i] > ctx.bbBasis[i] ? 0.5 : -0.5;
  score += ctx.st2.dir[i] > 0 ? 1 : -1;
  score += ctx.st3.dir[i] > 0 ? 1 : -1;
  score += ctx.st4.dir[i] > 0 ? 1 : -1;
  return score;
}

function strategySignal(ctx, s, i, pos = null) {
  if (i < 220) return null;
  const c = ctx.close[i];
  const prev = ctx.close[i - 1];
  const volOk = ctx.volume[i] >= ctx.volSma20[i] * s.volMult;
  const adxOk = ctx.adx14[i] >= s.minAdx;
  const trendLong = c > ctx[`ema${s.emaSlow}`][i] && ctx[`ema${s.emaFast}`][i] > ctx[`ema${s.emaSlow}`][i];
  const trendShort = c < ctx[`ema${s.emaSlow}`][i] && ctx[`ema${s.emaFast}`][i] < ctx[`ema${s.emaSlow}`][i];

  if (s.type === 'rating') {
    if (!adxOk || !volOk) return null;
    const score = _ratingScore(ctx, i);
    const prevScore = _ratingScore(ctx, i - 1);
    if (pos?.side === 'long' && score < s.exitScore) return 'close';
    if (pos?.side === 'short' && score > -s.exitScore) return 'close';
    if (score >= s.entryScore && prevScore < s.entryScore) return 'long';
    if (s.short && score <= -s.entryScore && prevScore > -s.entryScore) return 'short';
    return null;
  }

  if (s.type === 'emaCross') {
    const fast = ctx[`ema${s.crossFast}`];
    const slow = ctx[`ema${s.crossSlow}`];
    const longCross = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
    const shortCross = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
    const longRegime = !s.trend200 || c > ctx.ema200[i];
    const shortRegime = !s.trend200 || c < ctx.ema200[i];
    if (longCross && longRegime && adxOk && volOk && ctx.rsi14[i] >= s.rsiLong) return 'long';
    if (s.short && shortCross && shortRegime && adxOk && volOk && ctx.rsi14[i] <= s.rsiShort) return 'short';
    return null;
  }

  if (s.type === 'demaCross') {
    const fast = ctx[`dema${s.crossFast}`];
    const slow = ctx[`dema${s.crossSlow}`];
    const longCross = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
    const shortCross = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
    if (longCross && (!s.trend200 || c > ctx.ema200[i]) && adxOk && volOk) return 'long';
    if (s.short && shortCross && (!s.trend200 || c < ctx.ema200[i]) && adxOk && volOk) return 'short';
    return null;
  }

  if (s.type === 'macdCross') {
    const longCross = ctx.macdHist[i] > 0 && ctx.macdHist[i - 1] <= 0;
    const shortCross = ctx.macdHist[i] < 0 && ctx.macdHist[i - 1] >= 0;
    if (longCross && (!s.trend200 || c > ctx.ema200[i]) && adxOk && volOk && ctx.rsi14[i] >= s.rsiLong) return 'long';
    if (s.short && shortCross && (!s.trend200 || c < ctx.ema200[i]) && adxOk && volOk && ctx.rsi14[i] <= s.rsiShort) return 'short';
    return null;
  }

  if (s.type === 'meanReversion') {
    const reclaimedLong = ctx.close[i - 1] < ctx.bbLower[i - 1] && c >= ctx.bbLower[i];
    const reclaimedShort = ctx.close[i - 1] > ctx.bbUpper[i - 1] && c <= ctx.bbUpper[i];
    const longRegime = !s.trend200 || c >= ctx.ema200[i];
    const shortRegime = !s.trend200 || c <= ctx.ema200[i];
    if (reclaimedLong && longRegime && ctx.rsi14[i - 1] <= s.oversold && ctx.stoch14[i] > ctx.stoch14[i - 1] && volOk) return 'long';
    if (s.short && reclaimedShort && shortRegime && ctx.rsi14[i - 1] >= s.overbought && ctx.stoch14[i] < ctx.stoch14[i - 1] && volOk) return 'short';
    return null;
  }

  if (s.type === 'rsiReversal') {
    const longCross = ctx.rsi14[i] > s.oversold && ctx.rsi14[i - 1] <= s.oversold;
    const shortCross = ctx.rsi14[i] < s.overbought && ctx.rsi14[i - 1] >= s.overbought;
    const longRegime = !s.trend200 || c >= ctx.ema200[i];
    const shortRegime = !s.trend200 || c <= ctx.ema200[i];
    if (longCross && longRegime && ctx.stoch14[i] <= s.stochLong && volOk) return 'long';
    if (s.short && shortCross && shortRegime && ctx.stoch14[i] >= s.stochShort && volOk) return 'short';
    return null;
  }

  if (s.type === 'bbBreakout') {
    const longBreak = prev <= ctx.bbUpper[i - 1] && c > ctx.bbUpper[i];
    const shortBreak = prev >= ctx.bbLower[i - 1] && c < ctx.bbLower[i];
    if (longBreak && trendLong && adxOk && volOk && ctx.rsi14[i] >= s.rsiLong) return 'long';
    if (s.short && shortBreak && trendShort && adxOk && volOk && ctx.rsi14[i] <= s.rsiShort) return 'short';
    return null;
  }

  if (s.type === 'keltnerBreakout') {
    const upper = s.kc === 2 ? ctx.kcUpper20 : ctx.kcUpper15;
    const lower = s.kc === 2 ? ctx.kcLower20 : ctx.kcLower15;
    const longBreak = prev <= upper[i - 1] && c > upper[i];
    const shortBreak = prev >= lower[i - 1] && c < lower[i];
    if (longBreak && trendLong && adxOk && volOk && ctx.rsi14[i] >= s.rsiLong) return 'long';
    if (s.short && shortBreak && trendShort && adxOk && volOk && ctx.rsi14[i] <= s.rsiShort) return 'short';
    return null;
  }

  if (s.type === 'impulse') {
    const candle = ctx.candles[i];
    const body = Math.abs(candle.c - candle.o);
    if (body < ctx.atr14[i] * s.bodyAtr || !volOk || !adxOk) return null;
    if (candle.c > candle.o && trendLong && ctx.rsi14[i] >= s.rsiLong && ctx.rsi14[i] <= s.rsiMaxLong) return 'long';
    if (s.short && candle.c < candle.o && trendShort && ctx.rsi14[i] <= s.rsiShort && ctx.rsi14[i] >= s.rsiMinShort) return 'short';
    return null;
  }

  if (s.type === 'donchian') {
    const hi = highest(ctx.high, s.breakout, i);
    const lo = lowest(ctx.low, s.breakout, i);
    if (trendLong && adxOk && volOk && c > hi && ctx.rsi14[i] >= s.rsiLong) return 'long';
    if (s.short && trendShort && adxOk && volOk && c < lo && ctx.rsi14[i] <= s.rsiShort) return 'short';
    return null;
  }

  if (s.type === 'squeeze') {
    const upperKc = s.kc === 2 ? ctx.kcUpper20[i] : ctx.kcUpper15[i];
    const lowerKc = s.kc === 2 ? ctx.kcLower20[i] : ctx.kcLower15[i];
    const wasSqueeze = ctx.bbUpper[i - 1] < upperKc && ctx.bbLower[i - 1] > lowerKc;
    const longBreak = prev <= ctx.bbUpper[i - 1] && c > ctx.bbUpper[i] && ctx.macdHist[i] > 0;
    const shortBreak = prev >= ctx.bbLower[i - 1] && c < ctx.bbLower[i] && ctx.macdHist[i] < 0;
    if (wasSqueeze && trendLong && adxOk && volOk && longBreak && ctx.rsi14[i] >= s.rsiLong) return 'long';
    if (s.short && wasSqueeze && trendShort && adxOk && volOk && shortBreak && ctx.rsi14[i] <= s.rsiShort) return 'short';
    return null;
  }

  if (s.type === 'supertrend') {
    const st = ctx[`st${s.stMult}`];
    const flipLong = st.dir[i] > 0 && st.dir[i - 1] < 0;
    const flipShort = st.dir[i] < 0 && st.dir[i - 1] > 0;
    if (flipLong && trendLong && adxOk && volOk && ctx.rsi14[i] >= s.rsiLong) return 'long';
    if (s.short && flipShort && trendShort && adxOk && volOk && ctx.rsi14[i] <= s.rsiShort) return 'short';
    return null;
  }

  if (s.type === 'pullback') {
    const emaMid = ctx[`ema${s.emaMid}`];
    const reclaimLong = ctx.low[i] <= emaMid[i] && c > emaMid[i] && ctx.rsi14[i] >= s.rsiLong && ctx.macdHist[i] > ctx.macdHist[i - 1];
    const reclaimShort = ctx.high[i] >= emaMid[i] && c < emaMid[i] && ctx.rsi14[i] <= s.rsiShort && ctx.macdHist[i] < ctx.macdHist[i - 1];
    if (trendLong && adxOk && volOk && reclaimLong) return 'long';
    if (s.short && trendShort && adxOk && volOk && reclaimShort) return 'short';
  }
  return null;
}

function makeCases(days) {
  const cases = [];
  const common = { days, minStopPct: 0.18 };
  const add = (strategy) => {
    cases.push(strategy);
    cases.push({ ...strategy, name: `${strategy.name} long`, short: false });
  };
  for (const [crossFast, crossSlow] of [[8, 34], [13, 55], [21, 89], [34, 144]]) {
    for (const trend200 of [false, true]) {
      for (const minAdx of [10, 20]) {
        for (const rr of [2, 4]) {
          add({ ...common, type: 'emaCross', name: `ema cross ${crossFast}/${crossSlow} t${Number(trend200)} adx${minAdx} rr${rr}`, crossFast, crossSlow, trend200, minAdx, rr, stopAtr: 1.4, trailAtr: 2.4, emaFast: 50, emaSlow: 200, rsiLong: 50, rsiShort: 50, volMult: 0.7, short: true });
        }
      }
    }
  }
  for (const [crossFast, crossSlow] of [[20, 30], [20, 50], [30, 50]]) {
    for (const trend200 of [false, true]) {
      for (const rr of [1.8, 3]) {
        add({ ...common, type: 'demaCross', name: `dema cross ${crossFast}/${crossSlow} t${Number(trend200)} rr${rr}`, crossFast, crossSlow, trend200, minAdx: 10, rr, stopAtr: 1.3, trailAtr: 2.2, emaFast: 50, emaSlow: 200, rsiLong: 50, rsiShort: 50, volMult: 0.7, short: true });
      }
    }
  }
  for (const trend200 of [false, true]) {
    for (const minAdx of [8, 18]) {
      for (const rr of [1.8, 3]) {
        add({ ...common, type: 'macdCross', name: `macd cross t${Number(trend200)} adx${minAdx} rr${rr}`, trend200, minAdx, rr, stopAtr: 1.3, trailAtr: 2.2, emaFast: 50, emaSlow: 200, rsiLong: 50, rsiShort: 50, volMult: 0.7, short: true });
      }
    }
  }
  for (const oversold of [25, 30, 35]) {
    for (const trend200 of [false, true]) {
      for (const rr of [1.2, 1.8, 2.5]) {
        for (const stopAtr of [1, 1.5]) {
          add({ ...common, type: 'meanReversion', name: `bb mean rev os${oversold} t${Number(trend200)} rr${rr} sl${stopAtr}`, oversold, overbought: 100 - oversold, trend200, minAdx: 0, rr, stopAtr, trailAtr: null, emaFast: 50, emaSlow: 200, rsiLong: 50, rsiShort: 50, volMult: 0.45, short: true });
        }
      }
    }
  }
  for (const oversold of [25, 30, 35]) {
    for (const trend200 of [false, true]) {
      for (const rr of [1.4, 2.2]) {
        add({ ...common, type: 'rsiReversal', name: `rsi reversal os${oversold} t${Number(trend200)} rr${rr}`, oversold, overbought: 100 - oversold, stochLong: 35, stochShort: 65, trend200, minAdx: 0, rr, stopAtr: 1.2, trailAtr: null, emaFast: 50, emaSlow: 200, rsiLong: 50, rsiShort: 50, volMult: 0.45, short: true });
      }
    }
  }
  for (const minAdx of [10, 20]) {
    for (const rr of [2, 4]) {
      for (const stopAtr of [1.2, 1.8]) {
        add({ ...common, type: 'bbBreakout', name: `bb breakout adx${minAdx} rr${rr} sl${stopAtr}`, minAdx, rr, stopAtr, trailAtr: 2.4, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.8, short: true });
      }
    }
  }
  for (const kc of [1.5, 2]) {
    for (const minAdx of [10, 20]) {
      for (const rr of [2, 4]) {
        for (const stopAtr of [1.2, 1.8]) {
          add({ ...common, type: 'keltnerBreakout', name: `kc breakout ${kc} adx${minAdx} rr${rr} sl${stopAtr}`, kc, minAdx, rr, stopAtr, trailAtr: 2.4, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.8, short: true });
        }
      }
    }
  }
  for (const bodyAtr of [0.6, 1]) {
    for (const volMult of [1, 1.5]) {
      for (const rr of [1.5, 2.5]) {
        add({ ...common, type: 'impulse', name: `impulse body${bodyAtr} vol${volMult} rr${rr}`, bodyAtr, minAdx: 12, rr, stopAtr: 1.2, trailAtr: 2.0, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiMaxLong: 78, rsiShort: 48, rsiMinShort: 22, volMult, short: true });
      }
    }
  }
  for (const breakout of [20, 40, 80]) {
    for (const minAdx of [12, 18, 24]) {
      for (const rr of [1.8, 2.6, 3.5, 8]) {
        add({ ...common, type: 'donchian', name: `donchian b${breakout} adx${minAdx} rr${rr}`, breakout, minAdx, rr, stopAtr: 1.4, trailAtr: 2.2, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.8, short: true });
      }
      add({ ...common, type: 'donchian', name: `donchian b${breakout} adx${minAdx} trail`, breakout, minAdx, rr: 1, noTp: true, stopAtr: 1.4, trailAtr: 2.5, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.8, short: true });
    }
  }
  for (const kc of [1.5, 2]) {
    for (const minAdx of [8, 14, 20]) {
      for (const rr of [2, 3, 4, 8]) {
        add({ ...common, type: 'squeeze', name: `squeeze kc${kc} adx${minAdx} rr${rr}`, kc, minAdx, rr, stopAtr: 1.3, trailAtr: 2.0, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.7, short: true });
      }
      add({ ...common, type: 'squeeze', name: `squeeze kc${kc} adx${minAdx} trail`, kc, minAdx, rr: 1, noTp: true, stopAtr: 1.3, trailAtr: 2.3, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.7, short: true });
    }
  }
  for (const stMult of [2, 3, 4]) {
    for (const minAdx of [10, 16, 22]) {
      for (const rr of [1.6, 2.4, 3.2, 8]) {
        add({ ...common, type: 'supertrend', name: `supertrend m${stMult} adx${minAdx} rr${rr}`, stMult, minAdx, rr, stopAtr: 1.2, trailAtr: 2.4, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.7, short: true });
      }
      add({ ...common, type: 'supertrend', name: `supertrend m${stMult} adx${minAdx} trail`, stMult, minAdx, rr: 1, noTp: true, stopAtr: 1.2, trailAtr: 2.8, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.7, short: true });
    }
  }
  for (const emaMid of [20, 34, 50]) {
    for (const minAdx of [10, 16, 22]) {
      for (const rr of [1.5, 2.2, 3, 8]) {
        add({ ...common, type: 'pullback', name: `pullback ema${emaMid} adx${minAdx} rr${rr}`, emaMid, minAdx, rr, stopAtr: 1.2, trailAtr: 2.0, emaFast: 50, emaSlow: 200, rsiLong: 50, rsiShort: 50, volMult: 0.75, short: true });
      }
      add({ ...common, type: 'pullback', name: `pullback ema${emaMid} adx${minAdx} trail`, emaMid, minAdx, rr: 1, noTp: true, stopAtr: 1.2, trailAtr: 2.3, emaFast: 50, emaSlow: 200, rsiLong: 50, rsiShort: 50, volMult: 0.75, short: true });
    }
  }
  for (const entryScore of [7, 9, 11]) {
    for (const exitScore of [2, 4, 6]) {
      for (const minAdx of [8, 14, 20]) {
        add({ ...common, type: 'rating', name: `rating e${entryScore} x${exitScore} adx${minAdx}`, entryScore, exitScore, minAdx, rr: 1, noTp: true, stopAtr: 1.1, trailAtr: 2.6, emaFast: 50, emaSlow: 200, rsiLong: 52, rsiShort: 48, volMult: 0.65, short: true });
      }
    }
  }
  return cases;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function lowerBound(candles, timestamp) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (candles[mid].t < timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

function buildWindows(candles, totalDays, windowDays) {
  const count = Math.max(2, Math.floor(totalDays / windowDays));
  const endAnchor = candles.at(-1).t + 1;
  const windows = [];
  for (let index = 0; index < count; index += 1) {
    const distanceFromEnd = count - index - 1;
    const startMs = endAnchor - (distanceFromEnd + 1) * windowDays * DAY;
    const endMs = endAnchor - distanceFromEnd * windowDays * DAY;
    const start = Math.max(220, lowerBound(candles, startMs));
    const end = Math.min(candles.length - 1, lowerBound(candles, endMs) - 1);
    if (end - start < 80) continue;
    windows.push({ index, start, end, startMs, endMs });
  }
  return windows;
}

function summarizeWalkForwardStrategies(rows, strategies) {
  return strategies.map((strategy) => {
    const matches = rows.filter((row) => row.strategy === strategy.name);
    const daily = matches.map((row) => row.daily);
    const trades = matches.map((row) => row.trades);
    const dd = matches.map((row) => row.dd);
    const positivePct = matches.filter((row) => row.ret > 0).length * 100 / Math.max(1, matches.length);
    const summary = {
      name: strategy.name,
      type: strategy.type,
      samples: matches.length,
      avgDaily: mean(daily),
      medianDaily: median(daily),
      worstDaily: Math.min(...daily),
      positivePct,
      avgDd: mean(dd),
      medianTrades: median(trades),
    };
    summary.score = (
      summary.medianDaily * 4
      + summary.avgDaily * 2
      + summary.positivePct * 0.01
      - summary.avgDd * 0.025
      + Math.max(-5, summary.worstDaily) * 0.05
    );
    return summary;
  }).sort((a, b) => b.score - a.score);
}

function selectUniqueProfiles(rows, size, diversifyFamilies) {
  const selected = [];
  const profiles = new Set();
  const families = new Set();
  for (const row of rows) {
    if (profiles.has(row.profile)) continue;
    if (diversifyFamilies && families.has(row.type)) continue;
    selected.push(row);
    profiles.add(row.profile);
    families.add(row.type);
    if (selected.length >= size) break;
  }
  return selected;
}

function simulateRotation(rows, windowCount, policy) {
  const periods = [];
  for (let windowIndex = 1; windowIndex < windowCount; windowIndex += 1) {
    const previous = rows
      .filter((row) => row.windowIndex === windowIndex - 1 && row.trades >= policy.minTrades && row.daily > policy.minDaily)
      .map((row) => ({
        ...row,
        selectionScore: row.daily - row.dd * policy.ddPenalty + Math.min(row.trades, 20) * 0.002,
      }))
      .sort((a, b) => b.selectionScore - a.selectionScore);
    const selected = selectUniqueProfiles(previous, policy.size, policy.diversifyFamilies);
    const currentMap = new Map(
      rows
        .filter((row) => row.windowIndex === windowIndex)
        .map((row) => [`${row.profile}:${row.strategy}`, row]),
    );
    const current = selected.map((row) => currentMap.get(`${row.profile}:${row.strategy}`)).filter(Boolean);
    if (!current.length) continue;
    periods.push({
      windowIndex,
      daily: mean(current.map((row) => row.daily)),
      returnPct: mean(current.map((row) => row.ret)),
      dd: mean(current.map((row) => row.dd)),
      selected: current.map((row) => ({
        profile: row.profile,
        strategy: row.strategy,
        type: row.type,
        daily: row.daily,
        ret: row.ret,
        trades: row.trades,
      })),
    });
  }
  const daily = periods.map((period) => period.daily);
  return {
    name: policy.name,
    periods: periods.length,
    positivePeriods: daily.filter((value) => value > 0).length,
    avgDaily: mean(daily),
    medianDaily: median(daily),
    worstDaily: daily.length ? Math.min(...daily) : 0,
    bestDaily: daily.length ? Math.max(...daily) : 0,
    avgDd: mean(periods.map((period) => period.dd)),
    periodsDetail: periods,
  };
}

function formatNumber(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function walkForwardMarkdown(report) {
  const lines = [
    '# Robust Alpha Walk-Forward',
    '',
    `Generated: ${report.generatedAt}`,
    `Symbols: ${report.symbols.length}`,
    `Intervals: ${report.intervals.join(', ')}`,
    `Days: ${report.days}`,
    `Window days: ${report.windowDays}`,
    `Leverage: ${report.leverage}`,
    `Costs: fee ${report.feeBps} bps/side + slippage ${report.slippageBps} bps/side`,
    '',
    '## Rotation Policies',
    '',
    '| Policy | Avg Daily % | Median Daily % | Worst Daily % | Best Daily % | Positive Periods | Avg DD % |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.rotation) {
    lines.push(`| ${row.name} | ${formatNumber(row.avgDaily)} | ${formatNumber(row.medianDaily)} | ${formatNumber(row.worstDaily)} | ${formatNumber(row.bestDaily)} | ${row.positivePeriods}/${row.periods} | ${formatNumber(row.avgDd)} |`);
  }
  lines.push('', '## Most Robust Fixed Strategies', '', '| Strategy | Family | Avg Daily % | Median Daily % | Worst Daily % | Positive % | Avg DD % | Median Trades |', '|---|---|---:|---:|---:|---:|---:|---:|');
  for (const row of report.strategySummary.slice(0, 25)) {
    lines.push(`| ${row.name} | ${row.type} | ${formatNumber(row.avgDaily)} | ${formatNumber(row.medianDaily)} | ${formatNumber(row.worstDaily)} | ${formatNumber(row.positivePct, 2)} | ${formatNumber(row.avgDd)} | ${formatNumber(row.medianTrades, 1)} |`);
  }
  lines.push('', '## Latest Rotation Choices', '', '| Profile | Strategy | Family | Previous Daily % | Previous DD % | Trades |', '|---|---|---|---:|---:|---:|');
  for (const row of report.latestChoices) {
    lines.push(`| ${row.profile} | ${row.strategy} | ${row.type} | ${formatNumber(row.daily)} | ${formatNumber(row.dd)} | ${row.trades} |`);
  }
  lines.push('', 'Rotation returns are equal-weight approximations. A candidate is selected only from the immediately preceding window; the reported next window is unseen at selection time.', '');
  return lines.join('\n');
}

async function runWalkForward(datasets, cases, days, windowDays, symbols, intervals) {
  const rows = [];
  let completed = 0;
  for (const strategy of cases) {
    for (const dataset of datasets) {
      const windows = buildWindows(dataset.candles, days, windowDays);
      for (const window of windows) {
        rows.push({
          profile: `${dataset.symbol}:${dataset.interval}`,
          symbol: dataset.symbol,
          interval: dataset.interval,
          strategy: strategy.name,
          type: strategy.type,
          windowIndex: window.index,
          ...backtest(dataset.ctx, strategy, { start: window.start, end: window.end, days: windowDays }),
        });
      }
    }
    completed += 1;
    if (completed % 25 === 0 || completed === cases.length) {
      console.error(`[walk-forward ${completed}/${cases.length}]`);
    }
  }

  const windowCount = rows.reduce((highest, row) => Math.max(highest, row.windowIndex), -1) + 1;
  const policies = [
    { name: 'Top 3 previous window', size: 3, minTrades: 2, minDaily: 0, ddPenalty: 0.01, diversifyFamilies: false },
    { name: 'Top 5 previous window', size: 5, minTrades: 2, minDaily: 0, ddPenalty: 0.01, diversifyFamilies: false },
    { name: 'Top 8 previous window', size: 8, minTrades: 2, minDaily: 0, ddPenalty: 0.015, diversifyFamilies: false },
    { name: 'Top 5 family diversified', size: 5, minTrades: 2, minDaily: 0, ddPenalty: 0.015, diversifyFamilies: true },
    { name: 'Top 5 strict', size: 5, minTrades: 4, minDaily: 0.05, ddPenalty: 0.025, diversifyFamilies: false },
  ];
  const rotation = policies.map((policy) => simulateRotation(rows, windowCount, policy))
    .sort((a, b) => b.medianDaily - a.medianDaily || b.avgDaily - a.avgDaily);
  const strategySummary = summarizeWalkForwardStrategies(rows, cases);
  const latestIndex = windowCount - 1;
  const latestChoices = rows
    .filter((row) => row.windowIndex === latestIndex && row.trades >= 2 && row.daily > 0)
    .sort((a, b) => (b.daily - b.dd * 0.01) - (a.daily - a.dd * 0.01));
  const report = {
    generatedAt: new Date().toISOString(),
    symbols,
    intervals,
    days,
    windowDays,
    leverage: LEVERAGE,
    feeBps: FEE_BPS,
    slippageBps: SLIP_BPS,
    strategyCount: cases.length,
    profileCount: datasets.length,
    sampleCount: rows.length,
    rotation,
    strategySummary,
    latestChoices: selectUniqueProfiles(latestChoices, 10, false),
  };
  const jsonPath = path.resolve('data', `${OUTPUT_NAME}.json`);
  const markdownPath = path.resolve('data', `${OUTPUT_NAME}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, walkForwardMarkdown(report));
  console.table(rotation.map((row) => ({
    policy: row.name,
    avgDaily: formatNumber(row.avgDaily),
    medianDaily: formatNumber(row.medianDaily),
    worstDaily: formatNumber(row.worstDaily),
    positive: `${row.positivePeriods}/${row.periods}`,
    avgDd: formatNumber(row.avgDd),
  })));
  console.table(strategySummary.slice(0, 20).map((row) => ({
    strategy: row.name,
    family: row.type,
    avgDaily: formatNumber(row.avgDaily),
    medianDaily: formatNumber(row.medianDaily),
    worstDaily: formatNumber(row.worstDaily),
    positivePct: formatNumber(row.positivePct, 2),
    avgDd: formatNumber(row.avgDd),
  })));
  console.log(`Walk-forward report: ${markdownPath}`);
  if (!NO_JSON) console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const symbols = TOP_COUNT > 0
    ? await fetchTopUsdtSymbols(TOP_COUNT)
    : (positional[0] || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT').split(',').map((value) => value.trim());
  const intervalsArg = TOP_COUNT > 0 ? positional[0] : positional[1];
  const daysArg = TOP_COUNT > 0 ? positional[1] : positional[2];
  const intervals = (intervalsArg || '15m,30m,1h').split(',').map((value) => value.trim());
  const days = Number(daysArg || 90);
  const datasets = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      const candles = await fetchCandles(symbol.trim(), interval.trim(), days);
      datasets.push({ symbol, interval, candles, ctx: buildContext(candles), benchmark: (candles.at(-1).c / candles[0].c - 1) * 100 });
      console.error(`loaded ${symbol} ${interval} ${candles.length}`);
    }
  }
  const cases = makeCases(days);
  if (WALK_FORWARD) {
    await runWalkForward(datasets, cases, days, WINDOW_DAYS, symbols, intervals);
    return;
  }
  const rows = cases.map((strategy) => {
    const results = datasets.map((ds) => ({ ...backtest(ds.ctx, strategy), benchmark: ds.benchmark, symbol: ds.symbol, interval: ds.interval }));
    const daily = results.map((r) => r.daily);
    const ret = results.map((r) => r.ret);
    const dd = results.map((r) => r.dd);
    const trades = results.map((r) => r.trades);
    const excess = results.map((r) => r.ret - r.benchmark * LEVERAGE);
    return {
      name: strategy.name,
      type: strategy.type,
      medianDaily: median(daily),
      minDaily: Math.min(...daily),
      medianRet: median(ret),
      minRet: Math.min(...ret),
      medianDd: median(dd),
      maxDd: Math.max(...dd),
      medianTrades: median(trades),
      medianExcess: median(excess),
      score: median(daily) * 3 + median(excess) / 30 - median(dd) / 25 + Math.min(median(trades), 30) / 30,
      strategy,
      results,
    };
  });
  rows.sort((a, b) => b.score - a.score);
  console.table(rows.slice(0, 30).map(({ name, medianDaily, minDaily, medianRet, minRet, medianExcess, medianDd, maxDd, medianTrades, score }) => ({
    name,
    medianDaily: +medianDaily.toFixed(3),
    minDaily: +minDaily.toFixed(3),
    medianRet: +medianRet.toFixed(2),
    minRet: +minRet.toFixed(2),
    medianExcess: +medianExcess.toFixed(2),
    medianDd: +medianDd.toFixed(2),
    maxDd: +maxDd.toFixed(2),
    medianTrades,
    score: +score.toFixed(3),
  })));
  if (!NO_JSON) console.log(JSON.stringify({ leverage: LEVERAGE, feeBps: FEE_BPS, slippageBps: SLIP_BPS, days, rows: rows.slice(0, 20) }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
