const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FEE_BPS = Number(process.env.FEE_BPS || 10);
const SLIP_BPS = Number(process.env.SLIP_BPS || 2);
const LEVERAGE = Number(process.env.LEVERAGE || 2.1);

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
    macdHist: macd(close),
    volSma20: sma(volume, 20),
    ema20: ema(close, 20),
    ema34: ema(close, 34),
    ema50: ema(close, 50),
    ema100: ema(close, 100),
    ema200: ema(close, 200),
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

function openPosition(side, candle, equity, stop, target, meta) {
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
    stop,
    target,
    meta,
  };
}

function closePosition(pos, rawPrice, t, reason, equity, trades) {
  const feeRate = FEE_BPS / 10000;
  const slipRate = SLIP_BPS / 10000;
  const exit = rawPrice * (pos.side === 'long' ? 1 - slipRate : 1 + slipRate);
  const gross = pos.side === 'long' ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
  const exitFee = Math.abs(exit * pos.qty) * feeRate;
  const pnl = gross - pos.entryFee - exitFee;
  trades.push({ side: pos.side, entry: pos.entry, exit, pnl, reason, t, meta: pos.meta });
  return equity + pnl;
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

function backtest(ctx, strategy) {
  let equity = 1000;
  let pos = null;
  let pending = null;
  let peak = 1000;
  let maxDd = 0;
  const trades = [];
  for (let i = 1; i < ctx.candles.length; i += 1) {
    const candle = ctx.candles[i];
    if (pending && !pos) {
      pos = openPosition(pending.side, candle, equity, pending.stop, pending.target, pending.meta);
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

    const signal = strategySignal(ctx, strategy, i, pos);
    if (signal === 'close' && pos) {
      equity = closePosition(pos, candle.c, candle.t, 'signal', equity, trades);
      pos = null;
    } else if (signal && (!pos || pos.side !== signal)) {
      if (pos) {
        equity = closePosition(pos, candle.c, candle.t, 'reverse', equity, trades);
        pos = null;
      }
      const stopDist = Math.max(ctx.atr14[i] * strategy.stopAtr, ctx.close[i] * strategy.minStopPct / 100);
      const stop = signal === 'long' ? ctx.close[i] - stopDist : ctx.close[i] + stopDist;
      const targetDist = stopDist * strategy.rr;
      const target = strategy.noTp ? null : signal === 'long' ? ctx.close[i] + targetDist : ctx.close[i] - targetDist;
      pending = { side: signal, stop, target, meta: { name: strategy.name } };
    }
  }
  if (pos) equity = closePosition(pos, ctx.candles.at(-1).c, ctx.candles.at(-1).t, 'end', equity, trades);
  const wins = trades.filter((trade) => trade.pnl > 0);
  const profit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const loss = -trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    ret: (equity / 1000 - 1) * 100,
    daily: ((equity / 1000) ** (1 / strategy.days) - 1) * 100,
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

async function main() {
  const symbols = (process.argv[2] || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT').split(',');
  const intervals = (process.argv[3] || '15m,30m,1h').split(',');
  const days = Number(process.argv[4] || 90);
  const datasets = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      const candles = await fetchCandles(symbol.trim(), interval.trim(), days);
      datasets.push({ symbol, interval, candles, ctx: buildContext(candles), benchmark: (candles.at(-1).c / candles[0].c - 1) * 100 });
      console.error(`loaded ${symbol} ${interval} ${candles.length}`);
    }
  }
  const cases = makeCases(days);
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
  console.log(JSON.stringify({ leverage: LEVERAGE, feeBps: FEE_BPS, slippageBps: SLIP_BPS, days, rows: rows.slice(0, 20) }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
