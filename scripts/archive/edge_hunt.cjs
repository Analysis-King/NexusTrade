const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const interval = process.argv[2] || '15m';
const days = Number(process.argv[3] || 90);
const targetCount = Number(process.argv[4] || 30);
const leverage = Number(process.argv[5] || 3);
const feeBps = Number(process.argv[6] || 10);
const slipBps = Number(process.argv[7] || 2);
const NO_JSON = process.argv.includes('--no-json') || process.env.NO_JSON === '1';

const feeRate = feeBps / 10000;
const slipRate = slipBps / 10000;

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
      if (stableOrFiat.has(base)) return false;
      if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
      return Number(item.quoteVolume || 0) > 0;
    })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((item) => item.symbol);
}

function avg(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function med(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function ema(values, period) {
  const out = new Array(values.length);
  const alpha = 2 / (period + 1);
  let prev = values[0] || 0;
  out[0] = prev;
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

function rolling(values, period, fn, fallback = null) {
  const out = new Array(values.length).fill(fallback);
  for (let i = period - 1; i < values.length; i += 1) {
    out[i] = fn(values, i + 1 - period, i + 1);
  }
  return out;
}

function highest(values, period) {
  return rolling(values, period, (arr, start, end) => {
    let best = -Infinity;
    for (let i = start; i < end; i += 1) best = Math.max(best, arr[i]);
    return best;
  });
}

function lowest(values, period) {
  return rolling(values, period, (arr, start, end) => {
    let best = Infinity;
    for (let i = start; i < end; i += 1) best = Math.min(best, arr[i]);
    return best;
  });
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function stdev(values, period, ma) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    const mean = ma[i];
    for (let j = i + 1 - period; j <= i; j += 1) sum += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(sum / period);
  }
  return out;
}

function rsi(values, period) {
  const out = new Array(values.length).fill(50);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const g = Math.max(change, 0);
    const l = Math.max(-change, 0);
    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        gain /= period;
        loss /= period;
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    if (i >= period) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(candles, period) {
  const tr = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i += 1) {
    tr[i] = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
  }
  return ema(tr, period);
}

function adx(candles, period) {
  const plusDm = new Array(candles.length).fill(0);
  const minusDm = new Array(candles.length).fill(0);
  const tr = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i += 1) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
  }
  const smoothTr = ema(tr, period);
  const smoothPlus = ema(plusDm, period);
  const smoothMinus = ema(minusDm, period);
  const dx = tr.map((_, i) => {
    if (!smoothTr[i]) return 0;
    const pdi = 100 * smoothPlus[i] / smoothTr[i];
    const mdi = 100 * smoothMinus[i] / smoothTr[i];
    const sum = pdi + mdi;
    return sum ? 100 * Math.abs(pdi - mdi) / sum : 0;
  });
  return { value: ema(dx, period), plus: smoothPlus.map((v, i) => smoothTr[i] ? 100 * v / smoothTr[i] : 0), minus: smoothMinus.map((v, i) => smoothTr[i] ? 100 * v / smoothTr[i] : 0) };
}

function buildData(candles) {
  const open = candles.map((c) => c.o);
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const close = candles.map((c) => c.c);
  const volume = candles.map((c) => c.v);
  const cache = { candles, open, high, low, close, volume, ema: new Map(), atr: new Map(), rsi: new Map(), sma: new Map(), high: new Map(), low: new Map(), adx: new Map() };
  cache.getEma = (p) => cache.ema.get(p) || cache.ema.set(p, ema(close, p)).get(p);
  cache.getAtr = (p) => cache.atr.get(p) || cache.atr.set(p, atr(candles, p)).get(p);
  cache.getRsi = (p) => cache.rsi.get(p) || cache.rsi.set(p, rsi(close, p)).get(p);
  cache.getSma = (p) => cache.sma.get(p) || cache.sma.set(p, sma(close, p)).get(p);
  cache.getHighest = (p) => cache.high.get(p) || cache.high.set(p, highest(high, p)).get(p);
  cache.getLowest = (p) => cache.low.get(p) || cache.low.set(p, lowest(low, p)).get(p);
  cache.getAdx = (p) => cache.adx.get(p) || cache.adx.set(p, adx(candles, p)).get(p);
  cache.volumeMa = sma(volume, 30);
  return cache;
}

function makeStrategies() {
  const out = [];
  const add = (family, params, signalFn) => out.push({ family, name: `${family} ${JSON.stringify(params)}`, params, signalFn });

  for (const fast of [8, 13, 21]) {
    for (const mid of [21, 34, 55]) {
      for (const slow of [89, 144, 200]) {
        if (!(fast < mid && mid < slow)) continue;
        for (const adxMin of [12, 18, 24]) {
          for (const pullback of [false, true]) {
            add('trend_pullback', { fast, mid, slow, adxMin, atrP: 14, stopAtr: 1.0, rr: pullback ? 1.5 : 2.2, pullback }, (d, i, p) => {
              const c = d.close[i];
              const prev = d.close[i - 1];
              const ef = d.getEma(p.fast);
              const em = d.getEma(p.mid);
              const es = d.getEma(p.slow);
              const a = d.getAdx(14);
              if (a.value[i] < p.adxMin) return 0;
              const up = ef[i] > em[i] && em[i] > es[i] && c > es[i] && a.plus[i] > a.minus[i];
              const down = ef[i] < em[i] && em[i] < es[i] && c < es[i] && a.minus[i] > a.plus[i];
              const longTrigger = p.pullback ? prev <= ef[i - 1] && c > ef[i] : c > ef[i] && prev <= ef[i - 1];
              const shortTrigger = p.pullback ? prev >= ef[i - 1] && c < ef[i] : c < ef[i] && prev >= ef[i - 1];
              if (up && longTrigger) return 1;
              if (down && shortTrigger) return -1;
              return 0;
            });
          }
        }
      }
    }
  }

  for (const br of [12, 20, 34]) {
    for (const emaP of [55, 100, 200]) {
      for (const adxMin of [10, 16, 22]) {
        for (const volMin of [0.8, 1.1, 1.5]) {
          add('donchian_momentum', { br, emaP, adxMin, volMin, atrP: 14, stopAtr: 1.15, rr: 2.4 }, (d, i, p) => {
            const prevHigh = d.getHighest(p.br)[i - 1];
            const prevLow = d.getLowest(p.br)[i - 1];
            if (prevHigh == null || prevLow == null) return 0;
            const c = d.close[i];
            const prev = d.close[i - 1];
            const e = d.getEma(p.emaP);
            const a = d.getAdx(14);
            const vma = d.volumeMa[i] || d.volume[i];
            if (a.value[i] < p.adxMin || d.volume[i] / Math.max(vma, 1) < p.volMin) return 0;
            if (c > prevHigh && prev <= prevHigh && c > e[i] && a.plus[i] > a.minus[i]) return 1;
            if (c < prevLow && prev >= prevLow && c < e[i] && a.minus[i] > a.plus[i]) return -1;
            return 0;
          });
        }
      }
    }
  }

  for (const bbP of [20, 34]) {
    for (const rsiP of [7, 14]) {
      for (const rsiBand of [[24, 76], [30, 70], [35, 65]]) {
        for (const trendFilter of [false, true]) {
          add('bb_rsi_revert', { bbP, std: 2, rsiP, os: rsiBand[0], ob: rsiBand[1], trendFilter, atrP: 14, stopAtr: 1.0, rr: 1.2, exitMid: true }, (d, i, p) => {
            const ma = d.getSma(p.bbP);
            if (ma[i] == null) return 0;
            const sd = stdev(d.close, p.bbP, ma);
            const upper = ma[i] + sd[i] * p.std;
            const lower = ma[i] - sd[i] * p.std;
            const r = d.getRsi(p.rsiP)[i];
            const e = d.getEma(100);
            const c = d.close[i];
            if (c < lower && r <= p.os && (!p.trendFilter || c >= e[i])) return 1;
            if (c > upper && r >= p.ob && (!p.trendFilter || c <= e[i])) return -1;
            return 0;
          });
        }
      }
    }
  }

  for (const emaP of [50, 100, 200]) {
    for (const rsiP of [7, 14]) {
      for (const th of [[55, 45], [60, 40]]) {
        for (const atrMin of [0.12, 0.25, 0.45]) {
          add('impulse_follow', { emaP, rsiP, longRsi: th[0], shortRsi: th[1], atrMin, atrP: 14, stopAtr: 0.8, rr: 1.6 }, (d, i, p) => {
            const c = d.close[i];
            const e = d.getEma(p.emaP);
            const r = d.getRsi(p.rsiP);
            const atrPct = d.getAtr(p.atrP)[i] / c * 100;
            const bodyPct = Math.abs(c - d.open[i]) / c * 100;
            if (atrPct < p.atrMin || bodyPct < atrPct * 0.35) return 0;
            if (c > e[i] && r[i] >= p.longRsi && r[i] > r[i - 1]) return 1;
            if (c < e[i] && r[i] <= p.shortRsi && r[i] < r[i - 1]) return -1;
            return 0;
          });
        }
      }
    }
  }

  return out;
}

function backtest(data, strategy, opts = {}) {
  const candles = data.candles;
  const start = opts.start || 250;
  const end = opts.end || candles.length - 1;
  const maxHold = opts.maxHold || 96;
  let equity = 1000;
  let peak = equity;
  let dd = 0;
  let position = null;
  let pending = 0;
  const trades = [];
  const atrValues = data.getAtr(strategy.params.atrP || 14);

  for (let i = start; i <= end; i += 1) {
    const candle = candles[i];

    if (position) {
      let exit = null;
      let reason = '';
      const hitSl = position.side === 1 ? candle.l <= position.sl : candle.h >= position.sl;
      const hitTp = position.side === 1 ? candle.h >= position.tp : candle.l <= position.tp;
      if (hitSl && hitTp) {
        exit = position.sl;
        reason = 'sl';
      } else if (hitSl) {
        exit = position.sl;
        reason = 'sl';
      } else if (hitTp) {
        exit = position.tp;
        reason = 'tp';
      } else if (i - position.i >= maxHold) {
        exit = candle.c;
        reason = 'time';
      }
      if (exit != null) {
        const fill = exit * (1 - slipRate * position.side);
        const gross = position.side === 1 ? (fill / position.entry - 1) : (position.entry / fill - 1);
        const net = gross * position.notional - position.notional * feeRate;
        equity += net;
        trades.push({ pct: net / Math.max(1, equity - net) * 100, reason });
        position = null;
      }
    }

    if (pending && !position) {
      const entry = candle.o * (1 + slipRate * pending);
      const atrDistance = Math.max(atrValues[i] * strategy.params.stopAtr, entry * 0.0012);
      const tpDistance = atrDistance * strategy.params.rr;
      const sl = pending === 1 ? entry - atrDistance : entry + atrDistance;
      const tp = pending === 1 ? entry + tpDistance : entry - tpDistance;
      const notional = equity * leverage;
      equity -= notional * feeRate;
      position = { side: pending, entry, sl, tp, i, notional };
      pending = 0;
    }

    if (position) {
      const mark = position.side === 1
        ? equity + (candle.c / position.entry - 1) * position.notional
        : equity + (position.entry / candle.c - 1) * position.notional;
      peak = Math.max(peak, mark);
      dd = Math.max(dd, peak > 0 ? (peak - mark) / peak * 100 : 0);
    } else {
      peak = Math.max(peak, equity);
      dd = Math.max(dd, peak > 0 ? (peak - equity) / peak * 100 : 0);
    }

    if (i < end) {
      const signal = strategy.signalFn(data, i, strategy.params);
      if (signal && (!position || position.side !== signal)) {
        if (position) {
          const fill = candle.c * (1 - slipRate * position.side);
          const gross = position.side === 1 ? (fill / position.entry - 1) : (position.entry / fill - 1);
          const net = gross * position.notional - position.notional * feeRate;
          equity += net;
          trades.push({ pct: net / Math.max(1, equity - net) * 100, reason: 'flip' });
          position = null;
        }
        pending = signal;
      }
    }

    if (equity <= 20) break;
  }

  if (position) {
    const last = candles[Math.min(end, candles.length - 1)];
    const fill = last.c * (1 - slipRate * position.side);
    const gross = position.side === 1 ? (fill / position.entry - 1) : (position.entry / fill - 1);
    equity += gross * position.notional - position.notional * feeRate;
    trades.push({ pct: gross * leverage * 100, reason: 'end' });
  }

  const ret = (equity / 1000 - 1) * 100;
  const wins = trades.filter((t) => t.pct > 0).length;
  return {
    ret,
    daily: ret > -100 ? (Math.pow(1 + ret / 100, 1 / days) - 1) * 100 : -100,
    trades: trades.length,
    win: trades.length ? wins * 100 / trades.length : 0,
    dd,
  };
}

function summarizeCandidate(strategy, rows) {
  const train = rows.map((r) => r.train);
  const val = rows.map((r) => r.val);
  return {
    name: strategy.name,
    family: strategy.family,
    params: strategy.params,
    trainAvgDaily: avg(train.map((r) => r.daily)),
    trainMedDaily: med(train.map((r) => r.daily)),
    valAvgDaily: avg(val.map((r) => r.daily)),
    valMedDaily: med(val.map((r) => r.daily)),
    valAvgRet: avg(val.map((r) => r.ret)),
    valMedRet: med(val.map((r) => r.ret)),
    valProfitablePct: val.filter((r) => r.ret > 0).length * 100 / Math.max(1, val.length),
    valAvgDd: avg(val.map((r) => r.dd)),
    valMedDd: med(val.map((r) => r.dd)),
    valAvgTrades: avg(val.map((r) => r.trades)),
  };
}

async function main() {
  const symbols = await fetchTopUsdtSymbols(Math.max(targetCount * 2, 80));
  const datasets = [];
  for (const symbol of symbols) {
    if (datasets.length >= targetCount) break;
    try {
      const candles = await fetchCandles(symbol, interval, days);
      if (candles.length < 600) continue;
      datasets.push({ symbol, data: buildData(candles) });
      console.log(`[data ${datasets.length}/${targetCount}] ${symbol} ${candles.length}`);
    } catch (err) {
      console.log(`[skip] ${symbol} ${err.message}`);
    }
  }

  const strategies = makeStrategies();
  const splitRatio = 0.67;
  const rows = [];
  const stableCombos = [];
  for (let si = 0; si < strategies.length; si += 1) {
    const strategy = strategies[si];
    const perSymbol = [];
    for (const item of datasets) {
      const n = item.data.candles.length;
      const split = Math.max(300, Math.floor(n * splitRatio));
      const train = backtest(item.data, strategy, { start: 250, end: split, maxHold: interval === '1h' ? 72 : 96 });
      const val = backtest(item.data, strategy, { start: split + 1, end: n - 1, maxHold: interval === '1h' ? 72 : 96 });
      perSymbol.push({ symbol: item.symbol, train, val });
      stableCombos.push({
        family: strategy.family,
        symbol: item.symbol,
        trainDaily: train.daily,
        trainRet: train.ret,
        trainTrades: train.trades,
        valDaily: val.daily,
        valRet: val.ret,
        valTrades: val.trades,
        valDd: val.dd,
        minDaily: Math.min(train.daily, val.daily),
        params: strategy.params,
      });
    }
    const summary = summarizeCandidate(strategy, perSymbol);
    summary.score = (
      (summary.valMedDaily || -99) * 5
      + (summary.valAvgDaily || -99) * 2
      + summary.valProfitablePct * 0.04
      - (summary.valMedDd || 0) * 0.03
      + Math.min(50, summary.valAvgTrades || 0) * 0.01
    );
    rows.push({ ...summary, perSymbol });
    if ((si + 1) % 100 === 0) console.log(`[scan ${si + 1}/${strategies.length}] best=${rows.sort((a, b) => b.score - a.score)[0]?.family}`);
  }

  rows.sort((a, b) => b.score - a.score);
  console.log(`Edge hunt: ${datasets.length} sembol, ${strategies.length} aday, ${interval}, ${days} gun, leverage=${leverage}`);
  console.table(rows.slice(0, 25).map((r) => ({
    family: r.family,
    valAvgDaily: Number(r.valAvgDaily?.toFixed(3)),
    valMedDaily: Number(r.valMedDaily?.toFixed(3)),
    valAvgRet: Number(r.valAvgRet?.toFixed(2)),
    valMedRet: Number(r.valMedRet?.toFixed(2)),
    valProfitablePct: Number(r.valProfitablePct?.toFixed(1)),
    valMedDd: Number(r.valMedDd?.toFixed(2)),
    valAvgTrades: Number(r.valAvgTrades?.toFixed(1)),
    score: Number(r.score?.toFixed(3)),
    params: JSON.stringify(r.params),
  })));
  console.log('Best symbol details:');
  console.table(rows[0].perSymbol.map((r) => ({
    symbol: r.symbol,
    trainDaily: Number(r.train.daily.toFixed(3)),
    trainRet: Number(r.train.ret.toFixed(2)),
    valDaily: Number(r.val.daily.toFixed(3)),
    valRet: Number(r.val.ret.toFixed(2)),
    valTrades: r.val.trades,
    valDd: Number(r.val.dd.toFixed(2)),
  })).sort((a, b) => b.valDaily - a.valDaily));
  stableCombos.sort((a, b) => b.minDaily - a.minDaily);
  console.log('Stable strategy/symbol eslesmeleri:');
  console.table(stableCombos.slice(0, 30).map((r) => ({
    family: r.family,
    symbol: r.symbol,
    minDaily: Number(r.minDaily.toFixed(3)),
    trainDaily: Number(r.trainDaily.toFixed(3)),
    valDaily: Number(r.valDaily.toFixed(3)),
    trainRet: Number(r.trainRet.toFixed(2)),
    valRet: Number(r.valRet.toFixed(2)),
    trainTrades: r.trainTrades,
    valTrades: r.valTrades,
    valDd: Number(r.valDd.toFixed(2)),
    params: JSON.stringify(r.params),
  })));
  if (!NO_JSON) {
    console.log(JSON.stringify({ interval, days, targetCount, leverage, feeBps, slipBps, best: rows.slice(0, 10), stableCombos: stableCombos.slice(0, 50) }, null, 2));
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
