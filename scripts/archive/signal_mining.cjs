const DAY = 86_400_000;
const TR_OFFSET = 3 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FEE_BPS = Number(process.env.FEE_BPS || 10);
const SLIP_BPS = Number(process.env.SLIP_BPS || 2);
const ROUND_TRIP_COST_PCT = 2 * (FEE_BPS + SLIP_BPS) / 100;
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
    for (const k of raw) all.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    const next = +raw.at(-1)[6] + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(35);
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
      if (base.length < 2) return false;
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
  for (const value of values) out.push(out.length ? value * alpha + out.at(-1) * (1 - alpha) : value);
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

function std(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    const window = values.slice(Math.max(0, i - period + 1), i + 1);
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
    out.push(Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length));
  }
  return out;
}

function trueRange(candles) {
  return candles.map((candle, i) => {
    const prev = i ? candles[i - 1].c : candle.c;
    return Math.max(candle.h - candle.l, Math.abs(candle.h - prev), Math.abs(candle.l - prev));
  });
}

function rsi(closes, period = 14) {
  const gains = closes.map((value, i) => Math.max(0, i ? value - closes[i - 1] : 0));
  const losses = closes.map((value, i) => Math.max(0, i ? closes[i - 1] - value : 0));
  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);
  return avgGain.map((gain, i) => {
    const loss = avgLoss[i];
    if (loss === 0) return gain > 0 ? 100 : 50;
    const rs = gain / loss;
    return 100 - 100 / (1 + rs);
  });
}

function stoch(candles, period = 14) {
  return candles.map((candle, i) => {
    const window = candles.slice(Math.max(0, i - period + 1), i + 1);
    const low = Math.min(...window.map((row) => row.l));
    const high = Math.max(...window.map((row) => row.h));
    return high === low ? 50 : (candle.c - low) / (high - low) * 100;
  });
}

function macdHist(closes) {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const line = fast.map((value, i) => value - slow[i]);
  const signal = ema(line, 9);
  return line.map((value, i) => value - signal[i]);
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
  const plus = rma(plusDm, period).map((value, i) => atr[i] > 0 ? value / atr[i] * 100 : 0);
  const minus = rma(minusDm, period).map((value, i) => atr[i] > 0 ? value / atr[i] * 100 : 0);
  const dx = plus.map((value, i) => {
    const sum = value + minus[i];
    return sum > 0 ? Math.abs(value - minus[i]) / sum * 100 : 0;
  });
  return rma(dx, period);
}

function localDay(t) {
  return Math.floor((t + TR_OFFSET) / DAY);
}

function higherTrend(candles, hours) {
  const bucketMs = hours * 60 * 60 * 1000;
  const groups = [];
  const bucketIndex = new Map();
  for (const candle of candles) {
    const bucket = Math.floor(candle.t / bucketMs);
    let group = groups.at(-1);
    if (!group || group.bucket !== bucket) {
      group = { bucket, t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v };
      groups.push(group);
      bucketIndex.set(bucket, groups.length - 1);
    } else {
      group.h = Math.max(group.h, candle.h);
      group.l = Math.min(group.l, candle.l);
      group.c = candle.c;
      group.v += candle.v;
    }
  }

  const closes = groups.map((group) => group.c);
  const fast = ema(closes, 21);
  const slow = ema(closes, 55);
  const labels = groups.map((group, i) => {
    if (i < 60) return 'unknown';
    const slopeBase = slow[Math.max(0, i - 6)] || slow[i];
    const slopePct = slopeBase ? (slow[i] / slopeBase - 1) * 100 : 0;
    if (group.c > fast[i] && fast[i] > slow[i] && slopePct > 0) return 'strong_bull';
    if (group.c > slow[i] && slopePct >= 0) return 'bull';
    if (group.c < fast[i] && fast[i] < slow[i] && slopePct < 0) return 'strong_bear';
    if (group.c < slow[i] && slopePct <= 0) return 'bear';
    return 'mixed';
  });

  return candles.map((candle) => {
    const bucket = Math.floor(candle.t / bucketMs);
    const idx = (bucketIndex.get(bucket) ?? 0) - 1;
    return idx >= 0 ? labels[idx] : 'unknown';
  });
}

function bucket(value, cuts, labels) {
  for (let i = 0; i < cuts.length; i += 1) {
    if (value < cuts[i]) return labels[i];
  }
  return labels.at(-1);
}

function buildContext(symbol, candles) {
  const close = candles.map((c) => c.c);
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const volume = candles.map((c) => c.v);
  const atr14 = rma(trueRange(candles), 14);
  const rsi14 = rsi(close, 14);
  const stoch14 = stoch(candles, 14);
  const macd = macdHist(close);
  const adx14 = adx(candles, 14);
  const ema20 = ema(close, 20);
  const ema50 = ema(close, 50);
  const ema100 = ema(close, 100);
  const ema200 = ema(close, 200);
  const htf4h = higherTrend(candles, 4);
  const htf1d = higherTrend(candles, 24);
  const volSma20 = sma(volume, 20);
  const basis = sma(close, 20);
  const dev = std(close, 20);
  const bbWidth = basis.map((value, i) => value > 0 ? (4 * dev[i]) / value * 100 : 0);
  const dayGain = [];
  const dayDrop = [];
  let currentDay = null;
  let dayLow = Infinity;
  let dayHigh = -Infinity;
  for (const candle of candles) {
    const day = localDay(candle.t);
    if (day !== currentDay) {
      currentDay = day;
      dayLow = candle.l;
      dayHigh = candle.h;
    } else {
      dayLow = Math.min(dayLow, candle.l);
      dayHigh = Math.max(dayHigh, candle.h);
    }
    dayGain.push(dayLow > 0 ? (candle.c / dayLow - 1) * 100 : 0);
    dayDrop.push(candle.c > 0 ? (dayHigh / candle.c - 1) * 100 : 0);
  }
  return {
    symbol, candles, close, high, low, volume, atr14, rsi14, stoch14, macd,
    adx14, ema20, ema50, ema100, ema200, htf4h, htf1d, volSma20, bbWidth, dayGain, dayDrop,
  };
}

function highest(values, start, end) {
  let out = -Infinity;
  for (let i = start; i <= end; i += 1) out = Math.max(out, values[i]);
  return out;
}

function lowest(values, start, end) {
  let out = Infinity;
  for (let i = start; i <= end; i += 1) out = Math.min(out, values[i]);
  return out;
}

function tradeOutcome(ctx, index, side, horizon, stopPct, rewardRisk) {
  if (index + horizon >= ctx.candles.length || index + 1 >= ctx.candles.length) return null;
  const entry = ctx.candles[index + 1].o;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const targetPct = stopPct * rewardRisk;
  let reason = 'horizon';
  let grossPct = 0;
  for (let i = index + 1; i <= index + horizon; i += 1) {
    const candle = ctx.candles[i];
    if (side === 'long') {
      const stopped = (candle.l / entry - 1) * 100 <= -stopPct;
      const targeted = (candle.h / entry - 1) * 100 >= targetPct;
      if (stopped || targeted) {
        reason = stopped ? 'stop' : 'target';
        grossPct = stopped ? -stopPct : targetPct;
        return { grossPct, netPct: grossPct - ROUND_TRIP_COST_PCT, r: (grossPct - ROUND_TRIP_COST_PCT) / stopPct, win: grossPct > 0, reason };
      }
    } else {
      const stopped = (entry / candle.h - 1) * 100 <= -stopPct;
      const targeted = (entry / candle.l - 1) * 100 >= targetPct;
      if (stopped || targeted) {
        reason = stopped ? 'stop' : 'target';
        grossPct = stopped ? -stopPct : targetPct;
        return { grossPct, netPct: grossPct - ROUND_TRIP_COST_PCT, r: (grossPct - ROUND_TRIP_COST_PCT) / stopPct, win: grossPct > 0, reason };
      }
    }
  }
  const exit = ctx.candles[index + horizon].c;
  grossPct = side === 'long' ? (exit / entry - 1) * 100 : (entry / exit - 1) * 100;
  return { grossPct, netPct: grossPct - ROUND_TRIP_COST_PCT, r: (grossPct - ROUND_TRIP_COST_PCT) / stopPct, win: grossPct > ROUND_TRIP_COST_PCT, reason };
}

function featureTokens(ctx, i, side) {
  const c = ctx.candles[i];
  const prevMacd = i ? ctx.macd[i - 1] : ctx.macd[i];
  const prevClose = i ? ctx.close[i - 1] : ctx.close[i];
  const roc3 = i >= 3 && ctx.close[i - 3] > 0 ? (ctx.close[i] / ctx.close[i - 3] - 1) * 100 : 0;
  const roc6 = i >= 6 && ctx.close[i - 6] > 0 ? (ctx.close[i] / ctx.close[i - 6] - 1) * 100 : 0;
  const roc12 = i >= 12 && ctx.close[i - 12] > 0 ? (ctx.close[i] / ctx.close[i - 12] - 1) * 100 : 0;
  const volumeRatio = ctx.volSma20[i] > 0 ? ctx.volume[i] / ctx.volSma20[i] : 0;
  const atrPct = ctx.close[i] > 0 ? ctx.atr14[i] / ctx.close[i] * 100 : 0;
  const high20 = i >= 20 ? highest(ctx.high, i - 20, i - 1) : ctx.high[i];
  const low20 = i >= 20 ? lowest(ctx.low, i - 20, i - 1) : ctx.low[i];
  const high50 = i >= 50 ? highest(ctx.high, i - 50, i - 1) : ctx.high[i];
  const low50 = i >= 50 ? lowest(ctx.low, i - 50, i - 1) : ctx.low[i];
  const bodyPct = c.o > 0 ? Math.abs(c.c / c.o - 1) * 100 : 0;
  const dir = c.c >= c.o ? 'green' : 'red';
  const trend =
    ctx.close[i] > ctx.ema50[i] && ctx.ema50[i] > ctx.ema200[i] ? 'bull' :
    ctx.close[i] < ctx.ema50[i] && ctx.ema50[i] < ctx.ema200[i] ? 'bear' : 'mixed';
  const emaStack =
    ctx.ema20[i] > ctx.ema50[i] && ctx.ema50[i] > ctx.ema100[i] ? 'up' :
    ctx.ema20[i] < ctx.ema50[i] && ctx.ema50[i] < ctx.ema100[i] ? 'down' : 'flat';
  return {
    side,
    trend: `trend=${trend}`,
    htf4h: `htf4h=${ctx.htf4h[i]}`,
    htf1d: `htf1d=${ctx.htf1d[i]}`,
    emaStack: `ema=${emaStack}`,
    rsi: `rsi=${bucket(ctx.rsi14[i], [30, 40, 50, 60, 70, 80], ['<30', '30-40', '40-50', '50-60', '60-70', '70-80', '>80'])}`,
    stoch: `stoch=${bucket(ctx.stoch14[i], [20, 40, 60, 80], ['<20', '20-40', '40-60', '60-80', '>80'])}`,
    macd: `macd=${ctx.macd[i] > 0 ? 'pos' : 'neg'}_${ctx.macd[i] > prevMacd ? 'rise' : 'fall'}`,
    roc3: `roc3=${bucket(roc3, [-1, -0.3, 0.3, 1], ['<-1', '-1--0.3', '-0.3-0.3', '0.3-1', '>1'])}`,
    roc6: `roc6=${bucket(roc6, [-1.5, -0.5, 0.5, 1.5], ['<-1.5', '-1.5--0.5', '-0.5-0.5', '0.5-1.5', '>1.5'])}`,
    roc12: `roc12=${bucket(roc12, [-2, -0.8, 0.8, 2], ['<-2', '-2--0.8', '-0.8-0.8', '0.8-2', '>2'])}`,
    dayGain: `dayGain=${bucket(ctx.dayGain[i], [0.3, 0.8, 1.5, 3, 5], ['<0.3', '0.3-0.8', '0.8-1.5', '1.5-3', '3-5', '>5'])}`,
    dayDrop: `dayDrop=${bucket(ctx.dayDrop[i], [0.3, 0.8, 1.5, 3, 5], ['<0.3', '0.3-0.8', '0.8-1.5', '1.5-3', '3-5', '>5'])}`,
    volume: `vol=${bucket(volumeRatio, [0.8, 1.2, 2, 3], ['<0.8', '0.8-1.2', '1.2-2', '2-3', '>3'])}`,
    atr: `atr=${bucket(atrPct, [0.2, 0.5, 1, 2], ['<0.2', '0.2-0.5', '0.5-1', '1-2', '>2'])}`,
    adx: `adx=${bucket(ctx.adx14[i], [15, 25, 35], ['<15', '15-25', '25-35', '>35'])}`,
    breakout: `breakout=${ctx.close[i] > high50 ? 'high50' : ctx.close[i] > high20 ? 'high20' : ctx.close[i] < low50 ? 'low50' : ctx.close[i] < low20 ? 'low20' : 'none'}`,
    bbWidth: `bbWidth=${bucket(ctx.bbWidth[i], [1, 2.5, 5, 10], ['<1', '1-2.5', '2.5-5', '5-10', '>10'])}`,
    candle: `candle=${dir}_${bucket(bodyPct, [0.15, 0.5, 1.2], ['small', 'med', 'large', 'xlarge'])}`,
    prevClose: `prev=${ctx.close[i] > prevClose ? 'up' : 'down'}`,
  };
}

function comboKeys(tokens) {
  const base = `side=${tokens.side}`;
  const specs = [
    ['htf4h', 'trend', 'rsi', 'macd'],
    ['htf4h', 'rsi', 'stoch', 'bbWidth'],
    ['htf1d', 'htf4h', 'dayGain', 'volume'],
    ['htf4h', 'breakout', 'roc6', 'volume'],
    ['trend', 'rsi', 'roc6', 'volume'],
    ['trend', 'emaStack', 'macd', 'roc6'],
    ['trend', 'breakout', 'rsi', 'volume'],
    ['dayGain', 'rsi', 'roc3', 'volume'],
    ['dayGain', 'breakout', 'adx', 'atr'],
    ['rsi', 'stoch', 'macd', 'bbWidth'],
    ['trend', 'dayGain', 'dayDrop', 'candle'],
    ['emaStack', 'roc12', 'volume', 'adx'],
    ['breakout', 'roc6', 'atr', 'volume'],
    ['dayDrop', 'rsi', 'macd', 'volume'],
  ];
  return specs.map((spec) => [base, ...spec.map((name) => tokens[name])].join('|'));
}

function updateStats(map, key, symbol, outcome) {
  let row = map.get(key);
  if (!row) {
    row = { key, samples: 0, wins: 0, totalR: 0, totalNetPct: 0, totalGrossPct: 0, targets: 0, stops: 0, horizons: 0, symbols: new Set() };
    map.set(key, row);
  }
  row.samples += 1;
  row.wins += outcome.win ? 1 : 0;
  row.totalR += outcome.r;
  row.totalNetPct += outcome.netPct;
  row.totalGrossPct += outcome.grossPct;
  row.targets += outcome.reason === 'target' ? 1 : 0;
  row.stops += outcome.reason === 'stop' ? 1 : 0;
  row.horizons += outcome.reason === 'horizon' ? 1 : 0;
  row.symbols.add(symbol);
}

function finalize(rows, minSamples, minSymbols) {
  return [...rows.values()]
    .filter((row) => row.samples >= minSamples && row.symbols.size >= minSymbols)
    .map((row) => ({
      key: row.key,
      samples: row.samples,
      symbols: row.symbols.size,
      winRate: row.wins / row.samples * 100,
      expectancyR: row.totalR / row.samples,
      avgNetPct: row.totalNetPct / row.samples,
      avgGrossPct: row.totalGrossPct / row.samples,
      targetPct: row.targets / row.samples * 100,
      stopPct: row.stops / row.samples * 100,
      horizonPct: row.horizons / row.samples * 100,
      score: (row.totalR / row.samples) * Math.log10(row.samples) * Math.min(1, row.symbols.size / minSymbols),
    }))
    .sort((a, b) => b.score - a.score);
}

async function main() {
  const interval = process.argv[2] || '1h';
  const days = Number(process.argv[3] || 180);
  const count = Number(process.argv[4] || 50);
  const horizon = Number(process.argv[5] || (interval === '15m' ? 48 : 12));
  const rewardRisk = Number(process.argv[6] || 1.5);
  const contexts = [];
  const failures = [];
  const symbols = await fetchTopUsdtSymbols(Math.max(count * 2, 100));
  for (const symbol of symbols) {
    if (contexts.length >= count) break;
    try {
      const candles = await fetchCandles(symbol, interval, days);
      if (candles.length < Math.max(300, horizon + 220)) {
        failures.push({ symbol, reason: `not enough candles (${candles.length})` });
        continue;
      }
      contexts.push(buildContext(symbol, candles));
      console.log(`[${contexts.length}/${count}] ${symbol} ${candles.length}`);
    } catch (err) {
      failures.push({ symbol, reason: err.message || String(err) });
    }
  }

  const longRows = new Map();
  const shortRows = new Map();
  let evaluated = 0;
  for (const ctx of contexts) {
    for (let i = 220; i < ctx.candles.length - horizon - 1; i += 1) {
      const atrPct = ctx.close[i] > 0 ? ctx.atr14[i] / ctx.close[i] * 100 : 0;
      const stopPct = Math.max(0.35, Math.min(1.4, atrPct));
      for (const side of ['long', 'short']) {
        const outcome = tradeOutcome(ctx, i, side, horizon, stopPct, rewardRisk);
        if (!outcome) continue;
        const tokens = featureTokens(ctx, i, side);
        const rows = side === 'long' ? longRows : shortRows;
        for (const key of comboKeys(tokens)) updateStats(rows, key, ctx.symbol, outcome);
        evaluated += 1;
      }
    }
  }

  const minSamples = Math.max(80, Math.floor(contexts.length * 8));
  const minSymbols = Math.max(8, Math.floor(contexts.length * 0.25));
  const longTop = finalize(longRows, minSamples, minSymbols).slice(0, 30);
  const shortTop = finalize(shortRows, minSamples, minSymbols).slice(0, 30);

  console.log(`Signal mining: ${contexts.length} sembol, ${interval}, ${days} gun, horizon=${horizon}, RR=${rewardRisk}, evaluated=${evaluated}`);
  console.log('\nLONG adaylari');
  console.table(longTop.map(({ key, samples, symbols, winRate, expectancyR, avgNetPct, targetPct, stopPct, score }) => ({
    key, samples, symbols, winRate, expectancyR, avgNetPct, targetPct, stopPct, score,
  })));
  console.log('\nSHORT adaylari');
  console.table(shortTop.map(({ key, samples, symbols, winRate, expectancyR, avgNetPct, targetPct, stopPct, score }) => ({
    key, samples, symbols, winRate, expectancyR, avgNetPct, targetPct, stopPct, score,
  })));

  if (!NO_JSON) {
    console.log(JSON.stringify({
      interval, days, count: contexts.length, horizon, rewardRisk,
      feeBps: FEE_BPS, slipBps: SLIP_BPS, roundTripCostPct: ROUND_TRIP_COST_PCT,
      symbols: contexts.map((ctx) => ctx.symbol),
      longTop,
      shortTop,
      failures,
    }, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
