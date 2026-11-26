const DAY = 86_400_000;
const TR_OFFSET = 3 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LEVERAGE_ARG = process.argv.find((arg) => arg.startsWith('--leverage='));
const LEVERAGE = LEVERAGE_ARG ? Number(LEVERAGE_ARG.split('=')[1]) : Number(process.env.LEVERAGE || 2);
const NO_JSON = process.argv.includes('--no-json') || process.env.NO_JSON === '1';

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
    for (const k of raw) {
      all.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    }
    const next = +raw.at(-1)[6] + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(45);
  }
  return [...new Map(all.map((candle) => [candle.t, candle])).values()].sort((a, b) => a.t - b.t);
}

async function fetchTopUsdtSymbols(limit = 80) {
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
      if (stableOrFiat.has(base)) return false;
      if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
      return Number(item.quoteVolume || 0) > 0;
    })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((item) => item.symbol);
}

function ema(values, period) {
  const out = [];
  const alpha = 2 / (period + 1);
  for (const value of values) {
    out.push(out.length ? value * alpha + out.at(-1) * (1 - alpha) : value);
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
    const window = values.slice(Math.max(0, i - period + 1), i + 1);
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
    out.push(Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length));
  }
  return out;
}

function rma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!out.length) out.push(value);
    else if (i <= period) out.push((out.at(-1) * (i - 1) + value) / i);
    else out.push((out.at(-1) * (period - 1) + value) / period);
  }
  return out;
}

function dayKey(t) {
  return Math.floor((t + TR_OFFSET) / DAY);
}

function indicators(candles, cfg) {
  const close = candles.map((c) => c.c);
  const volume = candles.map((c) => c.v);
  const emaFast = ema(close, cfg.fastEma);
  const emaSlow = ema(close, cfg.slowEma);
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    return Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
  });
  const atr = rma(tr, cfg.atrPeriod);
  const gains = close.map((value, i) => Math.max(0, i ? value - close[i - 1] : 0));
  const losses = close.map((value, i) => Math.max(0, i ? close[i - 1] - value : 0));
  const avgGain = rma(gains, cfg.rsiPeriod);
  const avgLoss = rma(losses, cfg.rsiPeriod);
  const rsi = avgGain.map((gain, i) => {
    const loss = avgLoss[i];
    if (loss === 0) return gain > 0 ? 100 : 50;
    const rs = gain / loss;
    return 100 - 100 / (1 + rs);
  });
  const stoch = candles.map((candle, i) => {
    const window = candles.slice(Math.max(0, i - 14 + 1), i + 1);
    const low = Math.min(...window.map((row) => row.l));
    const high = Math.max(...window.map((row) => row.h));
    return high === low ? 50 : (candle.c - low) / (high - low) * 100;
  });
  const macdFast = ema(close, 12);
  const macdSlow = ema(close, 26);
  const macdLine = macdFast.map((value, i) => value - macdSlow[i]);
  const macdSignal = ema(macdLine, 9);
  const macdHist = macdLine.map((value, i) => value - macdSignal[i]);
  const bbBasis = sma(close, 20);
  const bbDev = std(close, 20);
  const bbWidth = bbBasis.map((value, i) => value > 0 ? (4 * bbDev[i]) / value * 100 : 0);
  const volSma = volume.map((_, i) => {
    const w = volume.slice(Math.max(0, i - cfg.volumePeriod + 1), i + 1);
    return w.reduce((sum, value) => sum + value, 0) / w.length;
  });
  const donchianHigh = candles.map((_, i) => {
    const w = candles.slice(Math.max(0, i - cfg.breakoutPeriod), i);
    return w.length ? Math.max(...w.map((c) => c.h)) : candles[i].h;
  });
  const donchianLow = candles.map((_, i) => {
    const w = candles.slice(Math.max(0, i - cfg.breakoutPeriod), i);
    return w.length ? Math.min(...w.map((c) => c.l)) : candles[i].l;
  });
  const roc = close.map((value, i) => {
    if (i < cfg.rocPeriod || close[i - cfg.rocPeriod] <= 0) return 0;
    return (value / close[i - cfg.rocPeriod] - 1) * 100;
  });
  const dayGain = [];
  let currentDay = null;
  let low = Infinity;
  for (const candle of candles) {
    const key = dayKey(candle.t);
    if (key !== currentDay) {
      currentDay = key;
      low = candle.l;
    } else {
      low = Math.min(low, candle.l);
    }
    dayGain.push(low > 0 ? (candle.c / low - 1) * 100 : 0);
  }
  return { emaFast, emaSlow, atr, rsi, stoch, macdHist, bbWidth, volSma, donchianHigh, donchianLow, roc, dayGain };
}

function buildConfigs() {
  const configs = [];
  const add = (name, params) => configs.push({
    name,
    fastEma: 21,
    slowEma: 89,
    atrPeriod: 14,
    rsiPeriod: 14,
    volumePeriod: 20,
    breakoutPeriod: 12,
    rocPeriod: 4,
    minDayGain: 0.5,
    maxDayGain: 2.8,
    minRoc: 0.12,
    minVolumeRatio: 0.8,
    minRsi: 50,
    maxRsi: 82,
    minAtrPct: 0.05,
    maxAtrPct: 4,
    requireBreakout: false,
    stopAtr: 0.9,
    minStopPct: 0.18,
    maxStopPct: 1.0,
    rewardRisk: 1.5,
    maxPositions: 3,
    maxHoldBars: 24,
    cooldownBars: 4,
    direction: 'long',
    ...params,
  });

  for (const maxPositions of [1, 2, 3, 5]) {
    add(`rot early pos${maxPositions}`, { maxPositions, requireBreakout: false, minDayGain: 0.4, maxDayGain: 2.2, minRoc: 0.1, rewardRisk: 1.2 });
    add(`rot breakout pos${maxPositions}`, { maxPositions, requireBreakout: true, minDayGain: 0.7, maxDayGain: 3.0, minRoc: 0.18, rewardRisk: 1.5 });
    add(`rot strict pos${maxPositions}`, { maxPositions, requireBreakout: true, minDayGain: 1.0, maxDayGain: 3.8, minRoc: 0.28, minVolumeRatio: 1.1, rewardRisk: 1.8 });
  }
  add('rot 1h smoother pos3', { fastEma: 13, slowEma: 55, maxPositions: 3, requireBreakout: false, minDayGain: 0.4, minRoc: 0.08, rewardRisk: 1.2 });
  add('rot high-volume pos3', { maxPositions: 3, requireBreakout: true, minDayGain: 0.8, minVolumeRatio: 1.5, rewardRisk: 1.8 });
  add('rot ultra pos1', { maxPositions: 1, requireBreakout: true, minDayGain: 1.4, maxDayGain: 4.5, minRoc: 0.35, minVolumeRatio: 2.0, minRsi: 55, maxRsi: 86, rewardRisk: 2.4, maxHoldBars: 12, cooldownBars: 8 });
  add('rot ultra pos2', { maxPositions: 2, requireBreakout: true, minDayGain: 1.4, maxDayGain: 4.5, minRoc: 0.35, minVolumeRatio: 2.0, minRsi: 55, maxRsi: 86, rewardRisk: 2.4, maxHoldBars: 12, cooldownBars: 8 });
  add('rot early quality pos1', { maxPositions: 1, requireBreakout: false, minDayGain: 0.5, maxDayGain: 1.6, minRoc: 0.12, minVolumeRatio: 1.8, minRsi: 52, maxRsi: 76, rewardRisk: 1.6, maxHoldBars: 10, cooldownBars: 10 });
  add('rot early quality pos2', { maxPositions: 2, requireBreakout: false, minDayGain: 0.5, maxDayGain: 1.6, minRoc: 0.12, minVolumeRatio: 1.8, minRsi: 52, maxRsi: 76, rewardRisk: 1.6, maxHoldBars: 10, cooldownBars: 10 });
  add('fade pump pos1', { direction: 'short', maxPositions: 1, requireBreakout: false, minDayGain: 1.8, maxDayGain: 6.0, minRoc: 0.45, minVolumeRatio: 1.3, minRsi: 68, maxRsi: 92, rewardRisk: 1.2, maxHoldBars: 8, cooldownBars: 10 });
  add('fade pump pos2', { direction: 'short', maxPositions: 2, requireBreakout: false, minDayGain: 1.8, maxDayGain: 6.0, minRoc: 0.45, minVolumeRatio: 1.3, minRsi: 68, maxRsi: 92, rewardRisk: 1.2, maxHoldBars: 8, cooldownBars: 10 });
  add('fade extreme pos1', { direction: 'short', maxPositions: 1, requireBreakout: true, minDayGain: 2.5, maxDayGain: 8.0, minRoc: 0.7, minVolumeRatio: 1.8, minRsi: 72, maxRsi: 95, rewardRisk: 1.4, maxHoldBars: 6, cooldownBars: 12 });
  add('fade extreme pos2', { direction: 'short', maxPositions: 2, requireBreakout: true, minDayGain: 2.5, maxDayGain: 8.0, minRoc: 0.7, minVolumeRatio: 1.8, minRsi: 72, maxRsi: 95, rewardRisk: 1.4, maxHoldBars: 6, cooldownBars: 12 });
  for (const maxPositions of [1, 2, 3, 5]) {
    add(`mined strict pos${maxPositions}`, { signalType: 'minedStrictLong', maxPositions, direction: 'long', rewardRisk: 1.8, minStopPct: 0.35, maxStopPct: 1.4, maxHoldBars: 999, cooldownBars: 6, trailing: false });
    add(`mined v1 pos${maxPositions}`, { signalType: 'minedLong', maxPositions, direction: 'long', rewardRisk: 1.5, minStopPct: 0.35, maxStopPct: 1.4, maxHoldBars: 999, cooldownBars: 6, trailing: false });
  }
  for (const breakoutPeriod of [12, 24, 48]) {
    for (const slowEma of [55, 100, 200]) {
      for (const maxPositions of [2, 4, 6]) {
        for (const stopAtr of [1.5, 2.2]) {
          for (const trailAtr of [2, 3]) {
            add(`trend both b${breakoutPeriod} e${slowEma} p${maxPositions} s${stopAtr} t${trailAtr}`, {
              signalType: 'trendBoth',
              breakoutPeriod,
              fastEma: 21,
              slowEma,
              maxPositions,
              stopAtr,
              trailAtr,
              minStopPct: 0.4,
              maxStopPct: 4,
              minVolumeRatio: 0.8,
              maxHoldBars: 999,
              cooldownBars: 2,
              trailing: true,
              useTakeProfit: false,
            });
          }
        }
      }
    }
  }
  return configs;
}

function signalFor(row, idx, cfg) {
  const { candle, ind } = row;
  if (idx < Math.max(cfg.slowEma, cfg.breakoutPeriod, cfg.rsiPeriod, cfg.atrPeriod) + 2) return null;
  const close = candle.c;
  const atrPct = close > 0 ? ind.atr[idx] / close * 100 : 0;
  if (cfg.signalType === 'trendBoth') {
    const volumeRatio = ind.volSma[idx] > 0 ? candle.v / ind.volSma[idx] : 0;
    const longBreakout = close > ind.donchianHigh[idx] && close > ind.emaFast[idx] && ind.emaFast[idx] > ind.emaSlow[idx];
    const shortBreakout = close < ind.donchianLow[idx] && close < ind.emaFast[idx] && ind.emaFast[idx] < ind.emaSlow[idx];
    if (volumeRatio < cfg.minVolumeRatio || atrPct < cfg.minAtrPct || atrPct > cfg.maxAtrPct) return null;
    if (!longBreakout && !shortBreakout) return null;
    const breakoutDistance = longBreakout
      ? (close - ind.donchianHigh[idx]) / Math.max(ind.atr[idx], 1e-12)
      : (ind.donchianLow[idx] - close) / Math.max(ind.atr[idx], 1e-12);
    return {
      side: longBreakout ? 'long' : 'short',
      score: breakoutDistance * 2 + volumeRatio + Math.abs(ind.emaFast[idx] / ind.emaSlow[idx] - 1) * 100,
      atr: ind.atr[idx],
      atrPct,
      volumeRatio,
    };
  }
  if (cfg.signalType === 'minedStrictLong' || cfg.signalType === 'minedLong') {
    const prevMacd = ind.macdHist[idx - 1] ?? ind.macdHist[idx];
    const rsiMax = cfg.signalType === 'minedStrictLong' ? 30 : 30;
    const minBbWidth = cfg.signalType === 'minedStrictLong' ? 12 : 10;
    if (
      ind.rsi[idx] < rsiMax &&
      ind.stoch[idx] >= 20 &&
      ind.stoch[idx] < 40 &&
      ind.macdHist[idx] < 0 &&
      ind.macdHist[idx] > prevMacd &&
      ind.bbWidth[idx] >= minBbWidth
    ) {
      return {
        side: 'long',
        score: (rsiMax - ind.rsi[idx]) * 1.5 + ind.bbWidth[idx] * 0.25 + (ind.stoch[idx] - 20) * 0.05 + (ind.macdHist[idx] - prevMacd) * 1000,
        atr: ind.atr[idx],
        atrPct,
        rsi: ind.rsi[idx],
        stoch: ind.stoch[idx],
        bbWidth: ind.bbWidth[idx],
      };
    }
    return null;
  }
  const volumeRatio = ind.volSma[idx] > 0 ? candle.v / ind.volSma[idx] : 0;
  const trend = close > ind.emaFast[idx] && ind.emaFast[idx] > ind.emaSlow[idx];
  const breakout = close > ind.donchianHigh[idx];
  if (ind.dayGain[idx] < cfg.minDayGain || ind.dayGain[idx] > cfg.maxDayGain) return null;
  if (ind.roc[idx] < cfg.minRoc) return null;
  if (ind.rsi[idx] < cfg.minRsi || ind.rsi[idx] > cfg.maxRsi) return null;
  if (volumeRatio < cfg.minVolumeRatio) return null;
  if (atrPct < cfg.minAtrPct || atrPct > cfg.maxAtrPct) return null;
  if (cfg.direction !== 'short' && !trend) return null;
  if (cfg.requireBreakout && !breakout) return null;
  return {
    side: cfg.direction === 'short' ? 'short' : 'long',
    score: ind.dayGain[idx] * 1.4 + ind.roc[idx] * 2 + volumeRatio * 0.8 + (ind.rsi[idx] - 50) * 0.05 + (breakout ? 1.5 : 0),
    atr: ind.atr[idx],
    atrPct,
    dayGain: ind.dayGain[idx],
    roc: ind.roc[idx],
    rsi: ind.rsi[idx],
    volumeRatio,
  };
}

function simulate(dataset, cfg, days) {
  const fee = 0.001;
  const slip = 0.0002;
  let equity = 1000;
  let peak = 1000;
  let maxDd = 0;
  const positions = [];
  const trades = [];
  const cooldown = new Map();
  let pending = [];
  const times = [...new Set(dataset.flatMap((row) => row.candles.map((c) => c.t)))].sort((a, b) => a - b);
  const barMs = times.length > 1 ? Math.max(1, times[1] - times[0]) : 60 * 60 * 1000;
  const bySymbolTime = new Map();
  for (const row of dataset) {
    row.candles.forEach((candle, idx) => {
      bySymbolTime.set(`${row.symbol}:${candle.t}`, { row, idx, candle, ind: row.ind });
    });
  }

  for (const time of times) {
    const openSlots = Math.max(0, cfg.maxPositions - positions.length);
    if (openSlots > 0 && pending.length) {
      const selected = pending.sort((a, b) => b.signal.score - a.signal.score).slice(0, openSlots);
      for (const item of selected) {
        if (positions.some((p) => p.symbol === item.symbol)) continue;
        const next = bySymbolTime.get(`${item.symbol}:${time}`);
        if (!next) continue;
        const isShort = item.signal.side === 'short';
        const entry = next.candle.o * (isShort ? (1 - slip) : (1 + slip));
        const stopPct = Math.max(cfg.minStopPct, Math.min(cfg.maxStopPct, item.signal.atr / entry * 100 * cfg.stopAtr));
        const risk = entry * stopPct / 100;
        const notional = Math.max(0, equity / cfg.maxPositions * LEVERAGE);
        if (notional <= 0) continue;
        const qty = notional / entry;
        const entryFee = notional * fee;
        equity -= entryFee;
        positions.push({
          symbol: item.symbol,
          side: item.signal.side,
          signalType: cfg.signalType,
          trailing: cfg.trailing !== false,
          entry,
          qty,
          entryTime: time,
          bars: 0,
          high: entry,
          sl: isShort ? entry + risk : entry - risk,
          tp: isShort ? entry - risk * cfg.rewardRisk : entry + risk * cfg.rewardRisk,
          notional,
          entryFee,
          meta: item.signal,
        });
      }
    }
    pending = [];

    for (let i = positions.length - 1; i >= 0; i -= 1) {
      const position = positions[i];
      const item = bySymbolTime.get(`${position.symbol}:${time}`);
      if (!item) continue;
      const candle = item.candle;
      position.bars += 1;
      if (position.trailing && position.side === 'short') {
        position.high = Math.min(position.high, candle.l);
        const trail = position.high + item.ind.atr[item.idx] * (cfg.trailAtr || 1.2);
        position.sl = Math.min(position.sl, trail);
      } else if (position.trailing) {
        position.high = Math.max(position.high, candle.h);
        const trail = position.high - item.ind.atr[item.idx] * (cfg.trailAtr || 1.2);
        position.sl = Math.max(position.sl, trail);
      }
      let exit = null;
      let reason = null;
      const prevMacd = item.idx > 0 ? item.ind.macdHist[item.idx - 1] : item.ind.macdHist[item.idx];
      if (position.signalType && position.signalType.startsWith('mined') && position.side === 'long' && item.ind.rsi[item.idx] >= 50 && item.ind.macdHist[item.idx] < prevMacd) {
        exit = candle.c * (1 - slip);
        reason = 'momentum';
      } else if (position.side === 'short' && candle.h >= position.sl) {
        exit = position.sl * (1 + slip);
        reason = 'sl';
      } else if (cfg.useTakeProfit !== false && position.side === 'short' && candle.l <= position.tp) {
        exit = position.tp * (1 + slip);
        reason = 'tp';
      } else if (position.side !== 'short' && candle.l <= position.sl) {
        exit = position.sl * (1 - slip);
        reason = 'sl';
      } else if (cfg.useTakeProfit !== false && position.side !== 'short' && candle.h >= position.tp) {
        exit = position.tp * (1 - slip);
        reason = 'tp';
      } else if (position.bars >= cfg.maxHoldBars) {
        exit = candle.c * (position.side === 'short' ? (1 + slip) : (1 - slip));
        reason = 'time';
      }
      if (exit != null) {
        const gross = position.side === 'short' ? (position.entry - exit) * position.qty : (exit - position.entry) * position.qty;
        const exitFee = exit * position.qty * fee;
        const pnl = gross - exitFee;
        equity += pnl;
        trades.push({ symbol: position.symbol, pnl, ret: pnl / 1000 * 100, reason, bars: position.bars, entryTime: position.entryTime, exitTime: time });
        cooldown.set(position.symbol, time + cfg.cooldownBars * barMs);
        positions.splice(i, 1);
      }
    }

    const candidates = [];
    for (const row of dataset) {
      if (positions.some((p) => p.symbol === row.symbol)) continue;
      const cd = cooldown.get(row.symbol);
      if (cd != null && cd > time) continue;
      const item = bySymbolTime.get(`${row.symbol}:${time}`);
      if (!item) continue;
      const signal = signalFor(item, item.idx, cfg);
      if (signal) candidates.push({ symbol: row.symbol, signal });
    }
    pending = candidates.sort((a, b) => b.signal.score - a.signal.score).slice(0, cfg.maxPositions);

    const mark = equity + positions.reduce((sum, position) => {
      const item = bySymbolTime.get(`${position.symbol}:${time}`);
      if (!item) return sum;
      const unrealized = position.side === 'short'
        ? (position.entry - item.candle.c) * position.qty
        : (item.candle.c - position.entry) * position.qty;
      return sum + unrealized;
    }, 0);
    peak = Math.max(peak, mark);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - mark) / peak * 100 : 0);
  }

  for (const position of positions) {
    const row = dataset.find((item) => item.symbol === position.symbol);
    const last = row.candles.at(-1);
    const exit = last.c * (position.side === 'short' ? (1 + slip) : (1 - slip));
    const gross = position.side === 'short' ? (position.entry - exit) * position.qty : (exit - position.entry) * position.qty;
    const exitFee = exit * position.qty * fee;
    const pnl = gross - exitFee;
    equity += pnl;
    trades.push({ symbol: position.symbol, pnl, ret: pnl / 1000 * 100, reason: 'end', bars: position.bars, entryTime: position.entryTime, exitTime: last.t });
  }

  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const totalReturnPct = (equity / 1000 - 1) * 100;
  return {
    ret: totalReturnPct,
    dailyCompound: totalReturnPct > -100 ? (Math.pow(1 + totalReturnPct / 100, 1 / days) - 1) * 100 : -100,
    trades: trades.length,
    win: trades.length ? wins.length / trades.length * 100 : 0,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : null),
    dd: maxDd,
    final: equity,
  };
}

async function main() {
  const days = Number(process.argv[2] || 90);
  const interval = process.argv[3] || '1h';
  const count = Number(process.argv[4] || 50);
  const symbols = await fetchTopUsdtSymbols(Math.max(count * 2, 90));
  const dataset = [];
  for (const symbol of symbols) {
    if (dataset.length >= count) break;
    try {
      const candles = await fetchCandles(symbol, interval, days);
      if (candles.length < 300) continue;
      dataset.push({ symbol, candles });
      console.log(`[${dataset.length}/${count}] ${symbol} ${candles.length}`);
    } catch (err) {
      console.log(`[skip] ${symbol}: ${err.message || err}`);
    }
  }
  const configs = buildConfigs();
  const rows = [];
  for (const cfg of configs) {
    const prepared = dataset.map((row) => ({ ...row, ind: indicators(row.candles, cfg) }));
    rows.push({ preset: cfg.name, ...simulate(prepared, cfg, days), params: cfg });
  }
  rows.sort((a, b) => b.dailyCompound - a.dailyCompound || b.ret - a.ret);
  console.table(rows.map(({ preset, ret, dailyCompound, trades, win, pf, dd }) => ({ preset, ret, dailyCompound, trades, win, pf, dd })));
  if (!NO_JSON) console.log(JSON.stringify({ days, interval, count: dataset.length, leverage: LEVERAGE, symbols: dataset.map((row) => row.symbol), rows }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
