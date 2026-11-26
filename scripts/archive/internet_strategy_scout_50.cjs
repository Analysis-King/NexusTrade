#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const FEE_BPS = Number(process.env.FEE_BPS || 5);
const SLIP_BPS = Number(process.env.SLIP_BPS || 2);
const LEVERAGE = Number(process.env.LEVERAGE || 2.5);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    candidates: 180,
    interval: "4h",
    windowDays: 45,
    minCoveragePct: 70,
    output: path.join("data", "internet_strategy_scout_50.json"),
    markdown: path.join("data", "internet_strategy_scout_50.md"),
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const option = raw.slice(2);
    const separator = option.indexOf("=");
    const key = separator >= 0 ? option.slice(0, separator) : option;
    const value = separator >= 0 ? option.slice(separator + 1) : "true";
    if (!(key in args)) continue;
    args[key] = ["interval", "output", "markdown"].includes(key) ? value : Number(value);
  }
  return args;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function avg(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function stddev(values) {
  const mean = avg(values);
  if (!Number.isFinite(mean)) return null;
  return Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
}

function intervalMs(interval) {
  const match = String(interval).match(/^(\d+)([mhd])$/i);
  if (!match) return 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  return value * DAY;
}

async function fetchTopFuturesSymbols(limit) {
  const stableOrFiat = new Set([
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDE", "USD1",
    "RLUSD", "XUSD", "EUR", "TRY", "BRL", "ARS", "AEUR", "PAXG", "XAUT",
  ]);
  const nonCrypto = new Set([
    "XAU", "XAG", "SPX", "SPY", "QQQ", "SOXL", "EWY", "NATGAS",
    "TSLA", "NVDA", "AMD", "INTC", "ARM", "MSTR", "MRVL", "WDC", "HOOD",
    "SKHYNIX", "DRAM", "CRCL", "NBIS", "RKLB", "GOOGL", "AVGO", "MSFT",
    "IBM", "META", "COIN", "AAOI", "AXTI", "CRWV", "QCOM", "SAMSUNG",
  ]);
  const response = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  if (!response.ok) throw new Error(`Binance futures ticker ${response.status}: ${await response.text()}`);
  const rows = await response.json();
  const ranked = rows.filter((row) => {
    const symbol = String(row.symbol || "");
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
    const base = symbol.slice(0, -4);
    if (stableOrFiat.has(base) || nonCrypto.has(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
    return Number(row.quoteVolume || 0) > 0;
  })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .map((row) => row.symbol);
  if (!ranked.includes("BTCUSDT")) ranked.unshift("BTCUSDT");
  return [...new Set(ranked)].slice(0, limit);
}

async function fetchCandles(symbol, interval, days) {
  const cachePath = path.join("data", "klines_cache", `${symbol}_${interval}_${days}d.json`);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  const limit = 1500;
  while (cursor <= endTime) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} ${interval} futures ${response.status}: ${await response.text()}`);
    const rows = await response.json();
    if (!rows.length) break;
    for (const row of rows) {
      all.push({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) });
    }
    const next = Number(rows.at(-1)[6]) + 1;
    if (next <= cursor || rows.length < limit) break;
    cursor = next;
    await sleep(5);
  }
  const candles = [...new Map(all.map((row) => [row.t, row])).values()].sort((a, b) => a.t - b.t);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(candles));
  return candles;
}

function sma(values, period) {
  const output = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    output.push(sum / Math.min(period, index + 1));
  }
  return output;
}

function ema(values, period) {
  const output = [];
  const alpha = 2 / (period + 1);
  for (const value of values) output.push(output.length ? value * alpha + output.at(-1) * (1 - alpha) : value);
  return output;
}

function wma(values, period) {
  const output = [];
  const denom = period * (period + 1) / 2;
  for (let index = 0; index < values.length; index += 1) {
    if (index + 1 < period) {
      output.push(values[index]);
      continue;
    }
    let sum = 0;
    for (let offset = 0; offset < period; offset += 1) sum += values[index - offset] * (period - offset);
    output.push(sum / denom);
  }
  return output;
}

function rma(values, period) {
  const output = [];
  let prev = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (prev == null) prev = value;
    else if (index <= period) prev = (prev * (index - 1) + value) / index;
    else prev = (prev * (period - 1) + value) / period;
    output.push(prev);
  }
  return output;
}

function rollingStd(values, period) {
  const output = [];
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    sum += value;
    sumSquares += value * value;
    if (index >= period) {
      sum -= values[index - period];
      sumSquares -= values[index - period] ** 2;
    }
    const size = Math.min(period, index + 1);
    output.push(Math.sqrt(Math.max(0, sumSquares / size - (sum / size) ** 2)));
  }
  return output;
}

function highest(values, period, index, excludeCurrent = false) {
  const end = excludeCurrent ? index : index + 1;
  const start = Math.max(0, end - period);
  return Math.max(...values.slice(start, end));
}

function lowest(values, period, index, excludeCurrent = false) {
  const end = excludeCurrent ? index : index + 1;
  const start = Math.max(0, end - period);
  return Math.min(...values.slice(start, end));
}

function trueRange(candles) {
  return candles.map((row, index) => {
    const prevClose = index ? candles[index - 1].c : row.c;
    return Math.max(row.h - row.l, Math.abs(row.h - prevClose), Math.abs(row.l - prevClose));
  });
}

function rsi(closes, period = 14) {
  const gains = [0];
  const losses = [0];
  for (let index = 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }
  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);
  return closes.map((_, index) => {
    if (avgLoss[index] === 0) return avgGain[index] > 0 ? 100 : 50;
    const rs = avgGain[index] / avgLoss[index];
    return 100 - 100 / (1 + rs);
  });
}

function stochastic(candles, period = 14) {
  return candles.map((row, index) => {
    const high = highest(candles.map((candle) => candle.h), period, index);
    const low = lowest(candles.map((candle) => candle.l), period, index);
    return high === low ? 50 : ((row.c - low) / (high - low)) * 100;
  });
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = fastEma.map((value, index) => value - slowEma[index]);
  const sig = ema(line, signal);
  return { line, signal: sig, hist: line.map((value, index) => value - sig[index]) };
}

function cci(candles, period = 20) {
  const typical = candles.map((row) => (row.h + row.l + row.c) / 3);
  const basis = sma(typical, period);
  return typical.map((value, index) => {
    const start = Math.max(0, index - period + 1);
    const window = typical.slice(start, index + 1);
    const meanDev = avg(window.map((item) => Math.abs(item - basis[index]))) || 0;
    return meanDev ? (value - basis[index]) / (0.015 * meanDev) : 0;
  });
}

function williamsR(candles, period = 14) {
  const highs = candles.map((row) => row.h);
  const lows = candles.map((row) => row.l);
  return candles.map((row, index) => {
    const high = highest(highs, period, index);
    const low = lowest(lows, period, index);
    return high === low ? -50 : ((high - row.c) / (high - low)) * -100;
  });
}

function ultimateOsc(candles) {
  const bp = [];
  const tr = [];
  for (let index = 0; index < candles.length; index += 1) {
    const prevClose = index ? candles[index - 1].c : candles[index].c;
    const trueLow = Math.min(candles[index].l, prevClose);
    const trueHigh = Math.max(candles[index].h, prevClose);
    bp.push(candles[index].c - trueLow);
    tr.push(trueHigh - trueLow);
  }
  return candles.map((_, index) => {
    const ratio = (period) => {
      const start = Math.max(0, index - period + 1);
      const b = bp.slice(start, index + 1).reduce((sum, value) => sum + value, 0);
      const t = tr.slice(start, index + 1).reduce((sum, value) => sum + value, 0);
      return t ? b / t : 0;
    };
    return 100 * (4 * ratio(7) + 2 * ratio(14) + ratio(28)) / 7;
  });
}

function vortex(candles, period = 14) {
  const tr = trueRange(candles);
  const plus = [0];
  const minus = [0];
  for (let index = 1; index < candles.length; index += 1) {
    plus.push(Math.abs(candles[index].h - candles[index - 1].l));
    minus.push(Math.abs(candles[index].l - candles[index - 1].h));
  }
  return candles.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const trSum = tr.slice(start, index + 1).reduce((sum, value) => sum + value, 0) || 1;
    return {
      plus: plus.slice(start, index + 1).reduce((sum, value) => sum + value, 0) / trSum,
      minus: minus.slice(start, index + 1).reduce((sum, value) => sum + value, 0) / trSum,
    };
  });
}

function kst(closes) {
  const roc = (period) => closes.map((close, index) => index >= period ? ((close / closes[index - period]) - 1) * 100 : 0);
  const a = sma(roc(10), 10);
  const b = sma(roc(15), 10);
  const c = sma(roc(20), 10);
  const d = sma(roc(30), 15);
  const line = closes.map((_, index) => a[index] + 2 * b[index] + 3 * c[index] + 4 * d[index]);
  return { line, signal: sma(line, 9) };
}

function coppock(closes) {
  const roc = (period) => closes.map((close, index) => index >= period ? ((close / closes[index - period]) - 1) * 100 : 0);
  const raw = closes.map((_, index) => roc(14)[index] + roc(11)[index]);
  return wma(raw, 10);
}

function trix(closes, period = 15) {
  const triple = ema(ema(ema(closes, period), period), period);
  const line = triple.map((value, index) => index ? ((value / triple[index - 1]) - 1) * 100 : 0);
  return { line, signal: ema(line, 9) };
}

function tsi(closes, long = 25, short = 13) {
  const momentum = closes.map((close, index) => index ? close - closes[index - 1] : 0);
  const absMomentum = momentum.map(Math.abs);
  const line = ema(ema(momentum, long), short).map((value, index) => {
    const denom = ema(ema(absMomentum, long), short)[index];
    return denom ? 100 * value / denom : 0;
  });
  return { line, signal: ema(line, 9) };
}

function stc(closes) {
  const macdLine = macd(closes, 23, 50, 10).line;
  const stochasticMacd = macdLine.map((value, index) => {
    const high = highest(macdLine, 10, index);
    const low = lowest(macdLine, 10, index);
    return high === low ? 50 : ((value - low) / (high - low)) * 100;
  });
  return ema(stochasticMacd, 3);
}

function aroon(candles, period = 25) {
  const highs = candles.map((row) => row.h);
  const lows = candles.map((row) => row.l);
  return candles.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const highWindow = highs.slice(start, index + 1);
    const lowWindow = lows.slice(start, index + 1);
    const highIndex = highWindow.lastIndexOf(Math.max(...highWindow));
    const lowIndex = lowWindow.lastIndexOf(Math.min(...lowWindow));
    const len = highWindow.length - 1 || 1;
    return {
      up: 100 * highIndex / len,
      down: 100 * lowIndex / len,
    };
  });
}

function psar(candles, step = 0.02, max = 0.2) {
  const dir = [];
  const sar = [];
  let trend = 1;
  let acceleration = step;
  let extreme = candles[0].h;
  let current = candles[0].l;
  for (let index = 0; index < candles.length; index += 1) {
    if (index > 0) {
      current += acceleration * (extreme - current);
      if (trend > 0) {
        if (candles[index].l < current) {
          trend = -1;
          current = extreme;
          extreme = candles[index].l;
          acceleration = step;
        } else if (candles[index].h > extreme) {
          extreme = candles[index].h;
          acceleration = Math.min(max, acceleration + step);
        }
      } else if (candles[index].h > current) {
        trend = 1;
        current = extreme;
        extreme = candles[index].h;
        acceleration = step;
      } else if (candles[index].l < extreme) {
        extreme = candles[index].l;
        acceleration = Math.min(max, acceleration + step);
      }
    }
    dir.push(trend);
    sar.push(current);
  }
  return { dir, sar };
}

function hma(values, period) {
  const half = Math.max(1, Math.round(period / 2));
  const sqrt = Math.max(1, Math.round(Math.sqrt(period)));
  const fast = wma(values, half);
  const slow = wma(values, period);
  return wma(values.map((_, index) => 2 * fast[index] - slow[index]), sqrt);
}

function zlema(values, period) {
  const lag = Math.floor((period - 1) / 2);
  const adjusted = values.map((value, index) => value + (index >= lag ? value - values[index - lag] : 0));
  return ema(adjusted, period);
}

function tema(values, period) {
  const e1 = ema(values, period);
  const e2 = ema(e1, period);
  const e3 = ema(e2, period);
  return values.map((_, index) => 3 * e1[index] - 3 * e2[index] + e3[index]);
}

function heikinAshi(candles) {
  const out = [];
  for (let index = 0; index < candles.length; index += 1) {
    const close = (candles[index].o + candles[index].h + candles[index].l + candles[index].c) / 4;
    const open = index ? (out[index - 1].o + out[index - 1].c) / 2 : (candles[index].o + candles[index].c) / 2;
    out.push({
      o: open,
      c: close,
      h: Math.max(candles[index].h, open, close),
      l: Math.min(candles[index].l, open, close),
    });
  }
  return out;
}

function rollingVwap(candles, period = 48) {
  const output = [];
  let pv = 0;
  let volume = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const typical = (candles[index].h + candles[index].l + candles[index].c) / 3;
    pv += typical * candles[index].v;
    volume += candles[index].v;
    if (index >= period) {
      const oldTypical = (candles[index - period].h + candles[index - period].l + candles[index - period].c) / 3;
      pv -= oldTypical * candles[index - period].v;
      volume -= candles[index - period].v;
    }
    output.push(volume ? pv / volume : candles[index].c);
  }
  return output;
}

function obv(candles) {
  const output = [0];
  for (let index = 1; index < candles.length; index += 1) {
    const direction = candles[index].c > candles[index - 1].c ? 1 : candles[index].c < candles[index - 1].c ? -1 : 0;
    output.push(output.at(-1) + direction * candles[index].v);
  }
  return output;
}

function cmf(candles, period = 20) {
  const mfv = candles.map((row) => {
    const range = row.h - row.l;
    const multiplier = range ? ((row.c - row.l) - (row.h - row.c)) / range : 0;
    return multiplier * row.v;
  });
  return candles.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const volume = candles.slice(start, index + 1).reduce((sum, row) => sum + row.v, 0);
    const flow = mfv.slice(start, index + 1).reduce((sum, value) => sum + value, 0);
    return volume ? flow / volume : 0;
  });
}

function mfi(candles, period = 14) {
  const pos = [0];
  const neg = [0];
  for (let index = 1; index < candles.length; index += 1) {
    const typical = (candles[index].h + candles[index].l + candles[index].c) / 3;
    const prevTypical = (candles[index - 1].h + candles[index - 1].l + candles[index - 1].c) / 3;
    const flow = typical * candles[index].v;
    pos.push(typical > prevTypical ? flow : 0);
    neg.push(typical < prevTypical ? flow : 0);
  }
  return candles.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const p = pos.slice(start, index + 1).reduce((sum, value) => sum + value, 0);
    const n = neg.slice(start, index + 1).reduce((sum, value) => sum + value, 0);
    return n ? 100 - 100 / (1 + p / n) : 50;
  });
}

function forceIndex(candles, period = 13) {
  const raw = candles.map((row, index) => index ? (row.c - candles[index - 1].c) * row.v : 0);
  return ema(raw, period);
}

function chaikinOsc(candles) {
  const adl = [];
  let acc = 0;
  for (const row of candles) {
    const range = row.h - row.l;
    const multiplier = range ? ((row.c - row.l) - (row.h - row.c)) / range : 0;
    acc += multiplier * row.v;
    adl.push(acc);
  }
  const fast = ema(adl, 3);
  const slow = ema(adl, 10);
  return fast.map((value, index) => value - slow[index]);
}

function rvi(candles, period = 10) {
  const num = sma(candles.map((row) => row.c - row.o), period);
  const den = sma(candles.map((row) => row.h - row.l), period);
  const line = num.map((value, index) => den[index] ? value / den[index] : 0);
  return { line, signal: sma(line, 4) };
}

function fisher(candles, period = 10) {
  const med = candles.map((row) => (row.h + row.l) / 2);
  const values = [];
  const fish = [];
  let prevValue = 0;
  let prevFish = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const high = highest(med, period, index);
    const low = lowest(med, period, index);
    const raw = high === low ? 0 : 2 * ((med[index] - low) / (high - low) - 0.5);
    const value = Math.max(-0.999, Math.min(0.999, 0.33 * raw + 0.67 * prevValue));
    const current = 0.5 * Math.log((1 + value) / (1 - value)) + 0.5 * prevFish;
    values.push(value);
    fish.push(current);
    prevValue = value;
    prevFish = current;
  }
  return fish;
}

function dpo(closes, period = 20) {
  const basis = sma(closes, period);
  const shift = Math.floor(period / 2) + 1;
  return closes.map((close, index) => index >= shift ? close - basis[index - shift] : 0);
}

function buildContext(candles) {
  const close = candles.map((row) => row.c);
  const high = candles.map((row) => row.h);
  const low = candles.map((row) => row.l);
  const volume = candles.map((row) => row.v);
  const tr = trueRange(candles);
  const atr14 = rma(tr, 14);
  const ema20 = ema(close, 20);
  const ema50 = ema(close, 50);
  const ema100 = ema(close, 100);
  const ema200 = ema(close, 200);
  const vwap48 = rollingVwap(candles, 48);
  const vwapStd = rollingStd(close.map((value, index) => value - vwap48[index]), 48);
  const obvLine = obv(candles);
  const macdValue = macd(close);
  return {
    candles,
    close,
    high,
    low,
    volume,
    atr14,
    natr: atr14.map((value, index) => close[index] ? (value / close[index]) * 100 : 0),
    rsi14: rsi(close, 14),
    stoch14: stochastic(candles, 14),
    macd: macdValue,
    ema20,
    ema50,
    ema100,
    ema200,
    cci20: cci(candles, 20),
    willr14: williamsR(candles, 14),
    ultimate: ultimateOsc(candles),
    vortex14: vortex(candles, 14),
    vortex21: vortex(candles, 21),
    kst: kst(close),
    coppock: coppock(close),
    trix: trix(close, 15),
    tsi: tsi(close, 25, 13),
    stc: stc(close),
    aroon25: aroon(candles, 25),
    psar: psar(candles),
    hma21: hma(close, 21),
    hma55: hma(close, 55),
    tema20: tema(close, 20),
    tema50: tema(close, 50),
    zlema20: zlema(close, 20),
    zlema50: zlema(close, 50),
    ha: heikinAshi(candles),
    vwap48,
    vwapUpper: vwap48.map((value, index) => value + 1.5 * vwapStd[index]),
    vwapLower: vwap48.map((value, index) => value - 1.5 * vwapStd[index]),
    obv: obvLine,
    obvEma: ema(obvLine, 21),
    cmf20: cmf(candles, 20),
    mfi14: mfi(candles, 14),
    force13: forceIndex(candles, 13),
    chaikin: chaikinOsc(candles),
    rvi: rvi(candles, 10),
    fisher10: fisher(candles, 10),
    dpo20: dpo(close, 20),
    volSma20: sma(volume, 20),
  };
}

function crossUp(seriesA, seriesB, index) {
  const b = Array.isArray(seriesB) ? seriesB[index] : seriesB;
  const bp = Array.isArray(seriesB) ? seriesB[index - 1] : seriesB;
  return seriesA[index] > b && seriesA[index - 1] <= bp;
}

function crossDown(seriesA, seriesB, index) {
  const b = Array.isArray(seriesB) ? seriesB[index] : seriesB;
  const bp = Array.isArray(seriesB) ? seriesB[index - 1] : seriesB;
  return seriesA[index] < b && seriesA[index - 1] >= bp;
}

function trendLong(ctx, index) {
  return ctx.close[index] > ctx.ema200[index] && ctx.ema50[index] > ctx.ema200[index];
}

function trendShort(ctx, index) {
  return ctx.close[index] < ctx.ema200[index] && ctx.ema50[index] < ctx.ema200[index];
}

function volOk(ctx, index, mult = 0.6) {
  return ctx.volume[index] >= ctx.volSma20[index] * mult;
}

function trendVotes(ctx, index) {
  const longVotes = [
    ctx.close[index] > ctx.ema200[index],
    ctx.ema50[index] > ctx.ema200[index],
    ctx.vortex14[index].plus > ctx.vortex14[index].minus,
    ctx.stc[index] > 50,
    ctx.kst.line[index] > ctx.kst.signal[index],
    ctx.tsi.line[index] > 0,
    ctx.cmf20[index] > 0,
    ctx.hma55[index] > ctx.hma55[index - 3],
    ctx.psar.dir[index] > 0,
    ctx.aroon25[index].up > ctx.aroon25[index].down,
  ].filter(Boolean).length;
  const shortVotes = [
    ctx.close[index] < ctx.ema200[index],
    ctx.ema50[index] < ctx.ema200[index],
    ctx.vortex14[index].minus > ctx.vortex14[index].plus,
    ctx.stc[index] < 50,
    ctx.kst.line[index] < ctx.kst.signal[index],
    ctx.tsi.line[index] < 0,
    ctx.cmf20[index] < 0,
    ctx.hma55[index] < ctx.hma55[index - 3],
    ctx.psar.dir[index] < 0,
    ctx.aroon25[index].down > ctx.aroon25[index].up,
  ].filter(Boolean).length;
  return { longVotes, shortVotes };
}

function recentAverage(series, index, length) {
  const start = Math.max(0, index - length + 1);
  return avg(series.slice(start, index + 1)) ?? 0;
}

function rawSignal(ctx, cfg, index, pos) {
  if (index < 220) return null;
  const c = ctx.close[index];
  const p = ctx.close[index - 1];
  const bullish = trendLong(ctx, index);
  const bearish = trendShort(ctx, index);
  const votes = trendVotes(ctx, index);

  switch (cfg.kind) {
    case "vortexCross14":
      if (ctx.vortex14[index].plus > ctx.vortex14[index].minus && ctx.vortex14[index - 1].plus <= ctx.vortex14[index - 1].minus && bullish) return "long";
      if (ctx.vortex14[index].minus > ctx.vortex14[index].plus && ctx.vortex14[index - 1].minus <= ctx.vortex14[index - 1].plus && bearish) return "short";
      return null;
    case "vortexCross21":
      if (ctx.vortex21[index].plus > ctx.vortex21[index].minus && ctx.vortex21[index - 1].plus <= ctx.vortex21[index - 1].minus) return "long";
      if (ctx.vortex21[index].minus > ctx.vortex21[index].plus && ctx.vortex21[index - 1].minus <= ctx.vortex21[index - 1].plus) return "short";
      return null;
    case "cciZero":
      if (crossUp(ctx.cci20, 0, index) && bullish) return "long";
      if (crossDown(ctx.cci20, 0, index) && bearish) return "short";
      return null;
    case "cciExtremeReversal":
      if (ctx.cci20[index] > -100 && ctx.cci20[index - 1] <= -100 && ctx.close[index] > ctx.ema50[index]) return "long";
      if (ctx.cci20[index] < 100 && ctx.cci20[index - 1] >= 100 && ctx.close[index] < ctx.ema50[index]) return "short";
      return null;
    case "willrTrend":
      if (ctx.willr14[index] > -50 && ctx.willr14[index - 1] <= -50 && bullish) return "long";
      if (ctx.willr14[index] < -50 && ctx.willr14[index - 1] >= -50 && bearish) return "short";
      return null;
    case "willrReversal":
      if (ctx.willr14[index] > -80 && ctx.willr14[index - 1] <= -80 && c > ctx.ema20[index]) return "long";
      if (ctx.willr14[index] < -20 && ctx.willr14[index - 1] >= -20 && c < ctx.ema20[index]) return "short";
      return null;
    case "ultimate50":
      if (crossUp(ctx.ultimate, 50, index) && bullish) return "long";
      if (crossDown(ctx.ultimate, 50, index) && bearish) return "short";
      return null;
    case "ultimateExtreme":
      if (ctx.ultimate[index] > 30 && ctx.ultimate[index - 1] <= 30 && c > ctx.ema50[index]) return "long";
      if (ctx.ultimate[index] < 70 && ctx.ultimate[index - 1] >= 70 && c < ctx.ema50[index]) return "short";
      return null;
    case "kstCross":
      if (crossUp(ctx.kst.line, ctx.kst.signal, index) && c > ctx.ema100[index]) return "long";
      if (crossDown(ctx.kst.line, ctx.kst.signal, index) && c < ctx.ema100[index]) return "short";
      return null;
    case "kstZero":
      if (crossUp(ctx.kst.line, 0, index)) return "long";
      if (crossDown(ctx.kst.line, 0, index)) return "short";
      return null;
    case "coppockZero":
      if (crossUp(ctx.coppock, 0, index)) return "long";
      if (crossDown(ctx.coppock, 0, index)) return "short";
      return null;
    case "trixZero":
      if (crossUp(ctx.trix.line, 0, index) && bullish) return "long";
      if (crossDown(ctx.trix.line, 0, index) && bearish) return "short";
      return null;
    case "trixSignal":
      if (crossUp(ctx.trix.line, ctx.trix.signal, index)) return "long";
      if (crossDown(ctx.trix.line, ctx.trix.signal, index)) return "short";
      return null;
    case "tsiZero":
      if (crossUp(ctx.tsi.line, 0, index) && bullish) return "long";
      if (crossDown(ctx.tsi.line, 0, index) && bearish) return "short";
      return null;
    case "tsiSignal":
      if (crossUp(ctx.tsi.line, ctx.tsi.signal, index)) return "long";
      if (crossDown(ctx.tsi.line, ctx.tsi.signal, index)) return "short";
      return null;
    case "stc50":
      if (crossUp(ctx.stc, 50, index)) return "long";
      if (crossDown(ctx.stc, 50, index)) return "short";
      return null;
    case "stcExtreme":
      if (ctx.stc[index] > 25 && ctx.stc[index - 1] <= 25 && bullish) return "long";
      if (ctx.stc[index] < 75 && ctx.stc[index - 1] >= 75 && bearish) return "short";
      return null;
    case "aroonCross":
      if (ctx.aroon25[index].up > ctx.aroon25[index].down && ctx.aroon25[index - 1].up <= ctx.aroon25[index - 1].down) return "long";
      if (ctx.aroon25[index].down > ctx.aroon25[index].up && ctx.aroon25[index - 1].down <= ctx.aroon25[index - 1].up) return "short";
      return null;
    case "aroonTrend":
      if (ctx.aroon25[index].up > 70 && ctx.aroon25[index].down < 30 && bullish) return "long";
      if (ctx.aroon25[index].down > 70 && ctx.aroon25[index].up < 30 && bearish) return "short";
      return null;
    case "psarFlip":
      if (ctx.psar.dir[index] > 0 && ctx.psar.dir[index - 1] < 0) return "long";
      if (ctx.psar.dir[index] < 0 && ctx.psar.dir[index - 1] > 0) return "short";
      return null;
    case "psarTrend":
      if (ctx.psar.dir[index] > 0 && ctx.psar.dir[index - 1] < 0 && bullish) return "long";
      if (ctx.psar.dir[index] < 0 && ctx.psar.dir[index - 1] > 0 && bearish) return "short";
      return null;
    case "hmaSlope":
      if (ctx.hma55[index] > ctx.hma55[index - 2] && c > ctx.hma55[index] && bullish) return "long";
      if (ctx.hma55[index] < ctx.hma55[index - 2] && c < ctx.hma55[index] && bearish) return "short";
      return null;
    case "hmaCross":
      if (crossUp(ctx.hma21, ctx.hma55, index)) return "long";
      if (crossDown(ctx.hma21, ctx.hma55, index)) return "short";
      return null;
    case "temaCross":
      if (crossUp(ctx.tema20, ctx.tema50, index)) return "long";
      if (crossDown(ctx.tema20, ctx.tema50, index)) return "short";
      return null;
    case "zlemaCross":
      if (crossUp(ctx.zlema20, ctx.zlema50, index)) return "long";
      if (crossDown(ctx.zlema20, ctx.zlema50, index)) return "short";
      return null;
    case "heikinTrend":
      if (ctx.ha[index].c > ctx.ha[index].o && ctx.ha[index - 1].c > ctx.ha[index - 1].o && bullish) return "long";
      if (ctx.ha[index].c < ctx.ha[index].o && ctx.ha[index - 1].c < ctx.ha[index - 1].o && bearish) return "short";
      return null;
    case "heikinFlip":
      if (ctx.ha[index].c > ctx.ha[index].o && ctx.ha[index - 1].c <= ctx.ha[index - 1].o) return "long";
      if (ctx.ha[index].c < ctx.ha[index].o && ctx.ha[index - 1].c >= ctx.ha[index - 1].o) return "short";
      return null;
    case "chandelier":
      if (c > highest(ctx.high, 22, index, true) - 3 * ctx.atr14[index] && p <= highest(ctx.high, 22, index - 1, true) - 3 * ctx.atr14[index - 1] && bullish) return "long";
      if (c < lowest(ctx.low, 22, index, true) + 3 * ctx.atr14[index] && p >= lowest(ctx.low, 22, index - 1, true) + 3 * ctx.atr14[index - 1] && bearish) return "short";
      return null;
    case "vwapBreakout":
      if (p <= ctx.vwapUpper[index - 1] && c > ctx.vwapUpper[index] && bullish) return "long";
      if (p >= ctx.vwapLower[index - 1] && c < ctx.vwapLower[index] && bearish) return "short";
      return null;
    case "vwapReversion":
      if (p < ctx.vwapLower[index - 1] && c > ctx.vwapLower[index]) return "long";
      if (p > ctx.vwapUpper[index - 1] && c < ctx.vwapUpper[index]) return "short";
      return null;
    case "obvCross":
      if (crossUp(ctx.obv, ctx.obvEma, index) && bullish) return "long";
      if (crossDown(ctx.obv, ctx.obvEma, index) && bearish) return "short";
      return null;
    case "obvBreakout":
      if (ctx.obv[index] > highest(ctx.obv, 50, index, true) && bullish) return "long";
      if (ctx.obv[index] < lowest(ctx.obv, 50, index, true) && bearish) return "short";
      return null;
    case "cmfZero":
      if (crossUp(ctx.cmf20, 0, index) && bullish) return "long";
      if (crossDown(ctx.cmf20, 0, index) && bearish) return "short";
      return null;
    case "cmfTrend":
      if (ctx.cmf20[index] > 0.05 && bullish && volOk(ctx, index)) return "long";
      if (ctx.cmf20[index] < -0.05 && bearish && volOk(ctx, index)) return "short";
      return null;
    case "mfiReversal":
      if (ctx.mfi14[index] > 25 && ctx.mfi14[index - 1] <= 25 && c > ctx.ema20[index]) return "long";
      if (ctx.mfi14[index] < 75 && ctx.mfi14[index - 1] >= 75 && c < ctx.ema20[index]) return "short";
      return null;
    case "mfiTrend":
      if (crossUp(ctx.mfi14, 50, index) && bullish) return "long";
      if (crossDown(ctx.mfi14, 50, index) && bearish) return "short";
      return null;
    case "forceZero":
      if (crossUp(ctx.force13, 0, index) && bullish) return "long";
      if (crossDown(ctx.force13, 0, index) && bearish) return "short";
      return null;
    case "chaikinZero":
      if (crossUp(ctx.chaikin, 0, index) && bullish) return "long";
      if (crossDown(ctx.chaikin, 0, index) && bearish) return "short";
      return null;
    case "volumeRocBreak":
      if (c > highest(ctx.high, 20, index, true) && ctx.volume[index] > ctx.volSma20[index] * 1.8) return "long";
      if (c < lowest(ctx.low, 20, index, true) && ctx.volume[index] > ctx.volSma20[index] * 1.8) return "short";
      return null;
    case "natrExpansion":
      if (ctx.natr[index] > highest(ctx.natr, 30, index, true) && c > highest(ctx.high, 20, index, true)) return "long";
      if (ctx.natr[index] > highest(ctx.natr, 30, index, true) && c < lowest(ctx.low, 20, index, true)) return "short";
      return null;
    case "nr7Breakout": {
      const range = ctx.high[index - 1] - ctx.low[index - 1];
      const minRange = Math.min(...ctx.high.slice(index - 7, index).map((h, offset) => h - ctx.low[index - 7 + offset]));
      if (range <= minRange && c > ctx.high[index - 1] && bullish) return "long";
      if (range <= minRange && c < ctx.low[index - 1] && bearish) return "short";
      return null;
    }
    case "insideBar":
      if (ctx.high[index - 1] < ctx.high[index - 2] && ctx.low[index - 1] > ctx.low[index - 2] && c > ctx.high[index - 1]) return "long";
      if (ctx.high[index - 1] < ctx.high[index - 2] && ctx.low[index - 1] > ctx.low[index - 2] && c < ctx.low[index - 1]) return "short";
      return null;
    case "fractalBreak":
      if (c > highest(ctx.high, 5, index, true) && bullish) return "long";
      if (c < lowest(ctx.low, 5, index, true) && bearish) return "short";
      return null;
    case "rviCross":
      if (crossUp(ctx.rvi.line, ctx.rvi.signal, index) && bullish) return "long";
      if (crossDown(ctx.rvi.line, ctx.rvi.signal, index) && bearish) return "short";
      return null;
    case "fisherCross":
      if (crossUp(ctx.fisher10, 0, index) && c > ctx.ema50[index]) return "long";
      if (crossDown(ctx.fisher10, 0, index) && c < ctx.ema50[index]) return "short";
      return null;
    case "dpoZero":
      if (crossUp(ctx.dpo20, 0, index) && bullish) return "long";
      if (crossDown(ctx.dpo20, 0, index) && bearish) return "short";
      return null;
    case "stochPop":
      if (ctx.stoch14[index] > 80 && ctx.stoch14[index - 1] <= 80 && bullish) return "long";
      if (ctx.stoch14[index] < 20 && ctx.stoch14[index - 1] >= 20 && bearish) return "short";
      return null;
    case "macdMfi":
      if (crossUp(ctx.macd.line, ctx.macd.signal, index) && ctx.mfi14[index] > 50 && bullish) return "long";
      if (crossDown(ctx.macd.line, ctx.macd.signal, index) && ctx.mfi14[index] < 50 && bearish) return "short";
      return null;
    case "hybridVoteBreakout":
      if (votes.longVotes >= 7 && c > highest(ctx.high, 20, index, true) && volOk(ctx, index, 1.15)) return "long";
      if (votes.shortVotes >= 7 && c < lowest(ctx.low, 20, index, true) && volOk(ctx, index, 1.15)) return "short";
      return null;
    case "hybridVotePullback":
      if (votes.longVotes >= 7 && (crossUp(ctx.willr14, -80, index) || crossUp(ctx.mfi14, 35, index)) && ctx.stc[index] > ctx.stc[index - 2]) return "long";
      if (votes.shortVotes >= 7 && (crossDown(ctx.willr14, -20, index) || crossDown(ctx.mfi14, 65, index)) && ctx.stc[index] < ctx.stc[index - 2]) return "short";
      return null;
    case "hybridStcVortexCmf":
      if (crossUp(ctx.stc, 50, index) && ctx.vortex14[index].plus > ctx.vortex14[index].minus && ctx.cmf20[index] > 0.03 && c > ctx.ema100[index]) return "long";
      if (crossDown(ctx.stc, 50, index) && ctx.vortex14[index].minus > ctx.vortex14[index].plus && ctx.cmf20[index] < -0.03 && c < ctx.ema100[index]) return "short";
      return null;
    case "hybridTsiKstAroon":
      if (crossUp(ctx.tsi.line, ctx.tsi.signal, index) && ctx.kst.line[index] > ctx.kst.signal[index] && ctx.aroon25[index].up > 60 && c > ctx.ema50[index]) return "long";
      if (crossDown(ctx.tsi.line, ctx.tsi.signal, index) && ctx.kst.line[index] < ctx.kst.signal[index] && ctx.aroon25[index].down > 60 && c < ctx.ema50[index]) return "short";
      return null;
    case "hybridVwapObvReclaim":
      if (p <= ctx.vwap48[index - 1] && c > ctx.vwap48[index] && ctx.obv[index] > ctx.obvEma[index] && ctx.cmf20[index] > 0 && votes.longVotes >= 6) return "long";
      if (p >= ctx.vwap48[index - 1] && c < ctx.vwap48[index] && ctx.obv[index] < ctx.obvEma[index] && ctx.cmf20[index] < 0 && votes.shortVotes >= 6) return "short";
      return null;
    case "hybridSqueezeBreakout": {
      const recentNatr = recentAverage(ctx.natr, index - 1, 20);
      const baseNatr = recentAverage(ctx.natr, index - 1, 100);
      const quiet = recentNatr < baseNatr * 0.82;
      if (quiet && c > highest(ctx.high, 30, index, true) && volOk(ctx, index, 1.35) && votes.longVotes >= 5) return "long";
      if (quiet && c < lowest(ctx.low, 30, index, true) && volOk(ctx, index, 1.35) && votes.shortVotes >= 5) return "short";
      return null;
    }
    case "hybridFisherMfiTrend":
      if (crossUp(ctx.fisher10, 0, index) && ctx.mfi14[index] > 45 && ctx.hma55[index] > ctx.hma55[index - 4] && c > ctx.ema50[index]) return "long";
      if (crossDown(ctx.fisher10, 0, index) && ctx.mfi14[index] < 55 && ctx.hma55[index] < ctx.hma55[index - 4] && c < ctx.ema50[index]) return "short";
      return null;
    case "hybridPsarChandelier":
      if (ctx.psar.dir[index] > 0 && ctx.psar.dir[index - 1] < 0 && c > highest(ctx.high, 22, index, true) - 2.5 * ctx.atr14[index] && ctx.aroon25[index].up > ctx.aroon25[index].down) return "long";
      if (ctx.psar.dir[index] < 0 && ctx.psar.dir[index - 1] > 0 && c < lowest(ctx.low, 22, index, true) + 2.5 * ctx.atr14[index] && ctx.aroon25[index].down > ctx.aroon25[index].up) return "short";
      return null;
    case "hybridMeanRevertRegime":
      if (ctx.rsi14[index - 1] < 34 && ctx.mfi14[index - 1] < 30 && c > ctx.vwapLower[index] && ctx.close[index] > ctx.ema200[index]) return "long";
      if (ctx.rsi14[index - 1] > 66 && ctx.mfi14[index - 1] > 70 && c < ctx.vwapUpper[index] && ctx.close[index] < ctx.ema200[index]) return "short";
      return null;
    case "hybridExhaustionFlip":
      if (ctx.willr14[index - 1] < -92 && ctx.fisher10[index] > ctx.fisher10[index - 1] && ctx.fisher10[index - 1] <= ctx.fisher10[index - 2] && ctx.vortex14[index].minus < ctx.vortex14[index - 2].minus) return "long";
      if (ctx.willr14[index - 1] > -8 && ctx.fisher10[index] < ctx.fisher10[index - 1] && ctx.fisher10[index - 1] >= ctx.fisher10[index - 2] && ctx.vortex14[index].plus < ctx.vortex14[index - 2].plus) return "short";
      return null;
    case "hybridMostLike":
      if (crossUp(ctx.close, ctx.ema20, index) && ctx.ema20[index] > ctx.ema50[index] && ctx.stc[index] > 50 && ctx.cmf20[index] > 0) return "long";
      if (crossDown(ctx.close, ctx.ema20, index) && ctx.ema20[index] < ctx.ema50[index] && ctx.stc[index] < 50 && ctx.cmf20[index] < 0) return "short";
      return null;
    case "hybridMomentumQuality":
      if (ctx.macd.hist[index] > 0 && ctx.macd.hist[index] > ctx.macd.hist[index - 2] && ctx.rsi14[index] > 54 && ctx.rsi14[index] < 74 && ctx.cmf20[index] > 0.04 && volOk(ctx, index, 1.05)) return "long";
      if (ctx.macd.hist[index] < 0 && ctx.macd.hist[index] < ctx.macd.hist[index - 2] && ctx.rsi14[index] < 46 && ctx.rsi14[index] > 26 && ctx.cmf20[index] < -0.04 && volOk(ctx, index, 1.05)) return "short";
      return null;
    case "hybridDonchianRetest":
      if (votes.longVotes >= 6 && ctx.low[index] <= ctx.ema20[index] && c > ctx.ema20[index] && ctx.willr14[index] > -50 && ctx.obv[index] > ctx.obvEma[index]) return "long";
      if (votes.shortVotes >= 6 && ctx.high[index] >= ctx.ema20[index] && c < ctx.ema20[index] && ctx.willr14[index] < -50 && ctx.obv[index] < ctx.obvEma[index]) return "short";
      return null;
    case "hybridRviCciVolume":
      if (crossUp(ctx.rvi.line, ctx.rvi.signal, index) && ctx.cci20[index] > 0 && ctx.force13[index] > 0 && volOk(ctx, index, 1.0) && bullish) return "long";
      if (crossDown(ctx.rvi.line, ctx.rvi.signal, index) && ctx.cci20[index] < 0 && ctx.force13[index] < 0 && volOk(ctx, index, 1.0) && bearish) return "short";
      return null;
    default:
      return null;
  }
}

function signal(ctx, cfg, index, pos) {
  const sig = rawSignal(ctx, cfg, index, pos);
  if (!sig || !cfg.invert) return sig;
  return sig === "long" ? "short" : "long";
}

function makeStrategies() {
  const names = [
    ["vortexCross14", "Vortex 14 EMA trend"],
    ["vortexCross21", "Vortex 21 pure cross"],
    ["cciZero", "CCI zero trend"],
    ["cciExtremeReversal", "CCI extreme reversal"],
    ["willrTrend", "WilliamsR trend reclaim"],
    ["willrReversal", "WilliamsR range reversal"],
    ["ultimate50", "Ultimate Osc 50 trend"],
    ["ultimateExtreme", "Ultimate Osc extreme reversal"],
    ["kstCross", "KST signal cross"],
    ["kstZero", "KST zero cross"],
    ["coppockZero", "Coppock zero"],
    ["trixZero", "TRIX zero trend"],
    ["trixSignal", "TRIX signal cross"],
    ["tsiZero", "TSI zero trend"],
    ["tsiSignal", "TSI signal cross"],
    ["stc50", "Schaff 50 cross"],
    ["stcExtreme", "Schaff extreme trend"],
    ["aroonCross", "Aroon cross"],
    ["aroonTrend", "Aroon strong trend"],
    ["psarFlip", "Parabolic SAR flip"],
    ["psarTrend", "Parabolic SAR trend"],
    ["hmaSlope", "HMA 55 slope"],
    ["hmaCross", "HMA 21/55 cross"],
    ["temaCross", "TEMA 20/50 cross"],
    ["zlemaCross", "ZLEMA 20/50 cross"],
    ["heikinTrend", "Heikin Ashi trend"],
    ["heikinFlip", "Heikin Ashi flip"],
    ["chandelier", "Chandelier trend flip"],
    ["vwapBreakout", "VWAP band breakout"],
    ["vwapReversion", "VWAP band reversion"],
    ["obvCross", "OBV EMA cross"],
    ["obvBreakout", "OBV 50 breakout"],
    ["cmfZero", "CMF zero trend"],
    ["cmfTrend", "CMF pressure trend"],
    ["mfiReversal", "MFI reversal"],
    ["mfiTrend", "MFI 50 trend"],
    ["forceZero", "Force index zero"],
    ["chaikinZero", "Chaikin oscillator zero"],
    ["volumeRocBreak", "Volume expansion breakout"],
    ["natrExpansion", "NATR expansion breakout"],
    ["nr7Breakout", "NR7 breakout"],
    ["insideBar", "Inside bar breakout"],
    ["fractalBreak", "Fractal breakout"],
    ["rviCross", "RVI cross"],
    ["fisherCross", "Fisher zero cross"],
    ["dpoZero", "DPO zero trend"],
    ["stochPop", "Stochastic pop"],
    ["macdMfi", "MACD + MFI confirmation"],
    ["hybridVoteBreakout", "Hybrid vote breakout"],
    ["hybridVotePullback", "Hybrid vote pullback"],
    ["hybridStcVortexCmf", "Hybrid STC Vortex CMF"],
    ["hybridTsiKstAroon", "Hybrid TSI KST Aroon"],
    ["hybridVwapObvReclaim", "Hybrid VWAP OBV reclaim"],
    ["hybridSqueezeBreakout", "Hybrid squeeze breakout"],
    ["hybridFisherMfiTrend", "Hybrid Fisher MFI trend"],
    ["hybridPsarChandelier", "Hybrid PSAR Chandelier"],
    ["hybridMeanRevertRegime", "Hybrid mean reversion regime"],
    ["hybridExhaustionFlip", "Hybrid exhaustion flip"],
    ["hybridMostLike", "Hybrid MOST-like EMA reclaim"],
    ["hybridMomentumQuality", "Hybrid momentum quality"],
    ["hybridDonchianRetest", "Hybrid Donchian retest"],
    ["hybridRviCciVolume", "Hybrid RVI CCI volume"],
  ];
  const hybridKinds = new Set(names.filter(([kind]) => kind.startsWith("hybrid")).map(([kind]) => kind));
  const baseProfiles = [
    { rr: 1.6, stopAtr: 1.4, minStopPct: 0.25, trailAtr: 0 },
    { rr: 2.4, stopAtr: 1.4, minStopPct: 0.25, trailAtr: 2.4 },
  ];
  const hybridProfiles = [
    { rr: 1.15, stopAtr: 0.75, minStopPct: 0.12, trailAtr: 0 },
    { rr: 1.35, stopAtr: 0.9, minStopPct: 0.15, trailAtr: 0 },
    { rr: 1.6, stopAtr: 1.0, minStopPct: 0.18, trailAtr: 1.8 },
    { rr: 1.8, stopAtr: 1.2, minStopPct: 0.22, trailAtr: 2.0 },
    { rr: 2.2, stopAtr: 1.4, minStopPct: 0.25, trailAtr: 2.4 },
    { rr: 2.8, stopAtr: 1.7, minStopPct: 0.3, trailAtr: 2.8 },
    { rr: 3.4, stopAtr: 2.1, minStopPct: 0.35, trailAtr: 3.2 },
  ];
  const configs = [];
  for (const [kind, label] of names) {
    const profiles = hybridKinds.has(kind) ? hybridProfiles : baseProfiles;
    for (const profile of profiles) {
      for (const invert of [false, true]) {
        configs.push({
          kind,
          name: `${label}${invert ? " inverse" : ""} rr${profile.rr} atr${profile.stopAtr} min${profile.minStopPct}`,
          invert,
          ...profile,
        });
      }
    }
  }
  return configs;
}

function openPosition(side, candle, equity, cfg, ctx, index) {
  const feeRate = FEE_BPS / 10000;
  const slipRate = SLIP_BPS / 10000;
  const notional = equity * LEVERAGE;
  const entry = candle.o * (side === "long" ? 1 + slipRate : 1 - slipRate);
  const stopDistance = Math.max(ctx.atr14[index] * cfg.stopAtr, entry * cfg.minStopPct / 100);
  const targetDistance = stopDistance * cfg.rr;
  return {
    side,
    entry,
    qty: notional / entry,
    entryFee: notional * feeRate,
    stop: side === "long" ? entry - stopDistance : entry + stopDistance,
    target: side === "long" ? entry + targetDistance : entry - targetDistance,
  };
}

function closePosition(pos, rawPrice, equity, trades, reason) {
  const feeRate = FEE_BPS / 10000;
  const slipRate = SLIP_BPS / 10000;
  const exit = rawPrice * (pos.side === "long" ? 1 - slipRate : 1 + slipRate);
  const gross = pos.side === "long" ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
  const exitFee = Math.abs(exit * pos.qty) * feeRate;
  const pnl = gross - pos.entryFee - exitFee;
  trades.push({ pnl, side: pos.side, reason });
  return equity + gross - exitFee;
}

function stopOrTarget(pos, candle) {
  if (pos.side === "long") {
    if (candle.l <= pos.stop) return [pos.stop, "sl"];
    if (candle.h >= pos.target) return [pos.target, "tp"];
  } else {
    if (candle.h >= pos.stop) return [pos.stop, "sl"];
    if (candle.l <= pos.target) return [pos.target, "tp"];
  }
  return [null, null];
}

function backtest(ctx, cfg, start, end, windowDays) {
  let equity = 1000;
  let peak = 1000;
  let maxDrawdownPct = 0;
  let pos = null;
  let pending = null;
  const trades = [];
  for (let index = start; index <= end; index += 1) {
    const candle = ctx.candles[index];
    if (pending && !pos) {
      pos = openPosition(pending, candle, equity, cfg, ctx, index);
      equity -= pos.entryFee;
    }
    pending = null;
    if (pos) {
      const [exit, reason] = stopOrTarget(pos, candle);
      if (exit != null) {
        equity = closePosition(pos, exit, equity, trades, reason);
        pos = null;
      }
    }
    if (pos && cfg.trailAtr) {
      const trail = ctx.atr14[index] * cfg.trailAtr;
      if (pos.side === "long") pos.stop = Math.max(pos.stop, ctx.close[index] - trail);
      else pos.stop = Math.min(pos.stop, ctx.close[index] + trail);
    }
    const mark = pos
      ? equity + (pos.side === "long" ? (ctx.close[index] - pos.entry) * pos.qty : (pos.entry - ctx.close[index]) * pos.qty)
      : equity;
    peak = Math.max(peak, mark);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - mark) / peak * 100 : 0);
    const sig = index < end ? signal(ctx, cfg, index, pos) : null;
    if (sig && (!pos || pos.side !== sig)) {
      if (pos) {
        equity = closePosition(pos, candle.c, equity, trades, "reverse");
        pos = null;
      }
      pending = sig;
    }
  }
  if (pos) equity = closePosition(pos, ctx.candles[end].c, equity, trades, "end");
  const wins = trades.filter((row) => row.pnl > 0);
  const profit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const loss = -trades.filter((row) => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0);
  const totalReturnPct = (equity / 1000 - 1) * 100;
  return {
    totalReturnPct: round(totalReturnPct),
    dailyPct: equity > 0 ? round((Math.pow(equity / 1000, 1 / windowDays) - 1) * 100) : -100,
    maxDrawdownPct: round(maxDrawdownPct),
    trades: trades.length,
    winRatePct: trades.length ? round((wins.length / trades.length) * 100, 2) : 0,
    profitFactor: loss > 0 ? round(profit / loss, 3) : profit > 0 ? 99 : 0,
  };
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

function buildWindows(candles, days, windowDays) {
  const count = Math.floor(days / windowDays);
  const anchor = candles.at(-1).t + 1;
  const windows = [];
  for (let windowIndex = 0; windowIndex < count; windowIndex += 1) {
    const startMs = anchor - (windowIndex + 1) * windowDays * DAY;
    const endMs = anchor - windowIndex * windowDays * DAY;
    const start = Math.max(220, lowerBound(candles, startMs));
    const end = Math.min(candles.length - 1, lowerBound(candles, endMs) - 1);
    if (end - start > 40) windows.push({ windowIndex, start, end });
  }
  return windows;
}

function summarize(rows) {
  const values = rows.map((row) => row.dailyPct).filter(Number.isFinite);
  return {
    samples: values.length,
    positivePct: values.length ? round(values.filter((value) => value > 0).length / values.length * 100, 2) : null,
    avgDailyPct: round(avg(values)),
    medianDailyPct: round(median(values)),
    worstDailyPct: values.length ? round(Math.min(...values)) : null,
    bestDailyPct: values.length ? round(Math.max(...values)) : null,
    avgDrawdownPct: round(avg(rows.map((row) => row.maxDrawdownPct))),
    medianTrades: round(median(rows.map((row) => row.trades)), 1),
  };
}

function nestedStrategySelector(results, strategies, windowCount, minTrainWindows = 4) {
  const periods = [];
  for (let windowIndex = windowCount - minTrainWindows - 1; windowIndex >= 0; windowIndex -= 1) {
    const ranked = strategies.map((strategy) => {
      const training = results.filter((row) => row.strategy === strategy.name && row.windowIndex > windowIndex);
      const summary = summarize(training);
      const score = (summary.medianDailyPct ?? -10) * 2
        + (summary.avgDailyPct ?? -10)
        + Math.min(0, summary.worstDailyPct ?? -10) * 0.25
        - (summary.avgDrawdownPct ?? 100) * 0.01
        + (summary.positivePct ?? 0) * 0.004;
      return { strategy, summary, score };
    }).filter((row) => row.summary.samples >= minTrainWindows * 10)
      .sort((a, b) => b.score - a.score);
    const chosen = ranked[0];
    if (!chosen) continue;
    const current = results.filter((row) => row.strategy === chosen.strategy.name && row.windowIndex === windowIndex);
    const currentSummary = summarize(current);
    periods.push({
      windowIndex,
      dailyPct: currentSummary.avgDailyPct,
      medianDailyPct: currentSummary.medianDailyPct,
      drawdownPct: currentSummary.avgDrawdownPct,
      selectedStrategy: chosen.strategy.name,
      training: chosen.summary,
    });
  }
  const values = periods.map((row) => row.dailyPct).filter(Number.isFinite);
  return {
    summary: {
      periods: values.length,
      positivePeriods: values.filter((value) => value > 0).length,
      avgDailyPct: round(avg(values)),
      medianDailyPct: round(median(values)),
      worstDailyPct: values.length ? round(Math.min(...values)) : null,
      bestDailyPct: values.length ? round(Math.max(...values)) : null,
      avgDrawdownPct: round(avg(periods.map((row) => row.drawdownPct))),
    },
    periods,
  };
}

function toMarkdown(report) {
  const lines = [
    "# Internet Strategy Scout 50",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} Binance USD-M perpetuals`,
    `Interval: ${report.interval}; windows: ${report.windowDays} days; leverage: ${report.leverage}x; costs: ${report.feeBps}+${report.slippageBps} bps`,
    `Strategies tested: ${report.strategies.length}`,
    "",
    "## Nested Strategy Selector",
    "",
    "| Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % |",
    "|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.nested.summary.periods} | ${report.nested.summary.positivePeriods}/${report.nested.summary.periods} | ${report.nested.summary.avgDailyPct} | ${report.nested.summary.medianDailyPct} | ${report.nested.summary.worstDailyPct} | ${report.nested.summary.bestDailyPct} | ${report.nested.summary.avgDrawdownPct} |`,
    "",
    "## Best Fixed Strategies Across All Symbols/Windows",
    "",
    "| # | Strategy | Samples | Positive % | Avg Daily % | Median % | Worst % | Best % | Avg DD % | Median Trades |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.fixed.slice(0, 30).map((row, index) => `| ${index + 1} | ${row.strategy} | ${row.summary.samples} | ${row.summary.positivePct} | ${row.summary.avgDailyPct} | ${row.summary.medianDailyPct} | ${row.summary.worstDailyPct} | ${row.summary.bestDailyPct} | ${row.summary.avgDrawdownPct} | ${row.summary.medianTrades} |`),
    "",
    "## Blind Periods",
    "",
    "| Window | Avg Daily % | Median Daily % | DD % | Selected Strategy | Training Avg % |",
    "|---:|---:|---:|---:|---|---:|",
    ...report.nested.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.medianDailyPct} | ${row.drawdownPct} | ${row.selectedStrategy} | ${row.training.avgDailyPct} |`),
    "",
    "This is research evidence only, not a profit guarantee.",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = await fetchTopFuturesSymbols(args.candidates);
  const datasets = [];
  for (const symbol of symbols) {
    if (datasets.length >= args.symbols) break;
    try {
      const candles = await fetchCandles(symbol, args.interval, args.days);
      const coveragePct = candles.length / Math.max(1, args.days * DAY / intervalMs(args.interval)) * 100;
      if (coveragePct >= args.minCoveragePct && candles.length >= 600) {
        datasets.push({ symbol, candles, ctx: buildContext(candles) });
        console.error(`loaded ${symbol}: ${candles.length}, coverage=${round(coveragePct, 1)}%`);
      } else {
        console.error(`skip ${symbol}: ${candles.length}, coverage=${round(coveragePct, 1)}%`);
      }
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  const strategies = makeStrategies();
  const results = [];
  for (const [strategyIndex, strategy] of strategies.entries()) {
    for (const dataset of datasets) {
      const windows = buildWindows(dataset.candles, args.days, args.windowDays);
      for (const window of windows) {
        results.push({
          strategy: strategy.name,
          kind: strategy.kind,
          symbol: dataset.symbol,
          windowIndex: window.windowIndex,
          ...backtest(dataset.ctx, strategy, window.start, window.end, args.windowDays),
        });
      }
    }
    if ((strategyIndex + 1) % 10 === 0 || strategyIndex + 1 === strategies.length) console.error(`tested ${strategyIndex + 1}/${strategies.length}`);
  }
  const windowCount = results.reduce((maxWindow, row) => Math.max(maxWindow, row.windowIndex), 0) + 1;
  const fixed = strategies.map((strategy) => ({
    strategy: strategy.name,
    kind: strategy.kind,
    summary: summarize(results.filter((row) => row.strategy === strategy.name)),
  })).sort((a, b) => (b.summary.medianDailyPct ?? -Infinity) - (a.summary.medianDailyPct ?? -Infinity)
    || (b.summary.avgDailyPct ?? -Infinity) - (a.summary.avgDailyPct ?? -Infinity));
  const nested = nestedStrategySelector(results, strategies, windowCount, 4);
  const report = {
    generatedAt: new Date().toISOString(),
    interval: args.interval,
    days: args.days,
    windowDays: args.windowDays,
    leverage: LEVERAGE,
    feeBps: FEE_BPS,
    slippageBps: SLIP_BPS,
    symbols: datasets.map((row) => row.symbol),
    strategies: strategies.map((row) => row.name),
    nested,
    fixed,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table([nested.summary]);
  console.table(fixed.slice(0, 20).map((row) => ({
    strategy: row.strategy,
    pos: row.summary.positivePct,
    avg: row.summary.avgDailyPct,
    median: row.summary.medianDailyPct,
    worst: row.summary.worstDailyPct,
    best: row.summary.bestDailyPct,
    dd: row.summary.avgDrawdownPct,
  })));
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
