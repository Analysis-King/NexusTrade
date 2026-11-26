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
    candidates: 220,
    interval: "4h",
    windowDays: 45,
    minCoveragePct: 70,
    maxRules: 1600,
    output: path.join("data", "edge_miner_solution.json"),
    markdown: path.join("data", "edge_miner_solution.md"),
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const [key, value = "true"] = raw.slice(2).split("=");
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
  if (!response.ok) throw new Error(`ticker ${response.status}: ${await response.text()}`);
  const rows = await response.json();
  return rows
    .filter((row) => row.symbol.endsWith("USDT"))
    .map((row) => ({
      symbol: row.symbol,
      base: row.symbol.slice(0, -4).replace(/^1000/, ""),
      quoteVolume: Number(row.quoteVolume || 0),
    }))
    .filter((row) => !stableOrFiat.has(row.base) && !nonCrypto.has(row.base))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit)
    .map((row) => row.symbol);
}

async function fetchCandles(symbol, interval, days) {
  const cachePath = path.join("data", "klines_cache", `${symbol}_${interval}_${days}d.json`);
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, "utf8"));
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
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    output.push(sum / Math.min(period, i + 1));
  }
  return output;
}

function ema(values, period) {
  const output = [];
  const alpha = 2 / (period + 1);
  for (const value of values) output.push(output.length ? value * alpha + output.at(-1) * (1 - alpha) : value);
  return output;
}

function rma(values, period) {
  const output = [];
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    if (prev == null) prev = values[i];
    else if (i <= period) prev = (prev * (i - 1) + values[i]) / i;
    else prev = (prev * (period - 1) + values[i]) / period;
    output.push(prev);
  }
  return output;
}

function rollingStd(values, period) {
  const output = [];
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    sumSquares += values[i] ** 2;
    if (i >= period) {
      sum -= values[i - period];
      sumSquares -= values[i - period] ** 2;
    }
    const n = Math.min(period, i + 1);
    const mean = sum / n;
    output.push(Math.sqrt(Math.max(0, sumSquares / n - mean ** 2)));
  }
  return output;
}

function highest(values, period, index, excludeCurrent = false) {
  const end = excludeCurrent ? index - 1 : index;
  const start = Math.max(0, end - period + 1);
  let value = -Infinity;
  for (let i = start; i <= end; i += 1) value = Math.max(value, values[i]);
  return value;
}

function lowest(values, period, index, excludeCurrent = false) {
  const end = excludeCurrent ? index - 1 : index;
  const start = Math.max(0, end - period + 1);
  let value = Infinity;
  for (let i = start; i <= end; i += 1) value = Math.min(value, values[i]);
  return value;
}

function trueRange(candles) {
  return candles.map((row, i) => {
    if (!i) return row.h - row.l;
    return Math.max(row.h - row.l, Math.abs(row.h - candles[i - 1].c), Math.abs(row.l - candles[i - 1].c));
  });
}

function rsi(values, period = 14) {
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    gains.push(Math.max(0, change));
    losses.push(Math.max(0, -change));
  }
  const ag = rma(gains, period);
  const al = rma(losses, period);
  return values.map((_, i) => (al[i] ? 100 - 100 / (1 + ag[i] / al[i]) : 50));
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = fast.map((value, i) => value - slow[i]);
  const signal = ema(line, 9);
  return { line, signal, hist: line.map((value, i) => value - signal[i]) };
}

function cmf(candles, period = 20) {
  const mfv = candles.map((row) => {
    const range = row.h - row.l;
    const multiplier = range ? ((row.c - row.l) - (row.h - row.c)) / range : 0;
    return multiplier * row.v;
  });
  return candles.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let flow = 0;
    let volume = 0;
    for (let j = start; j <= i; j += 1) {
      flow += mfv[j];
      volume += candles[j].v;
    }
    return volume ? flow / volume : 0;
  });
}

function mfi(candles, period = 14) {
  const pos = [0];
  const neg = [0];
  for (let i = 1; i < candles.length; i += 1) {
    const t = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const p = (candles[i - 1].h + candles[i - 1].l + candles[i - 1].c) / 3;
    const flow = t * candles[i].v;
    pos.push(t > p ? flow : 0);
    neg.push(t < p ? flow : 0);
  }
  return candles.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let p = 0;
    let n = 0;
    for (let j = start; j <= i; j += 1) {
      p += pos[j];
      n += neg[j];
    }
    return n ? 100 - 100 / (1 + p / n) : 50;
  });
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
  const macdValue = macd(close);
  const bbBasis = sma(close, 20);
  const bbStd = rollingStd(close, 20);
  const natr = atr14.map((value, i) => close[i] ? value / close[i] * 100 : 0);
  return {
    candles,
    close,
    high,
    low,
    volume,
    atr14,
    natr,
    natr50: sma(natr, 50),
    natr100: sma(natr, 100),
    rsi14: rsi(close, 14),
    macd: macdValue,
    cmf20: cmf(candles, 20),
    mfi14: mfi(candles, 14),
    ema20,
    ema50,
    ema100,
    ema200,
    volSma20: sma(volume, 20),
    bbBasis,
    bbUpper: bbBasis.map((value, i) => value + 2 * bbStd[i]),
    bbLower: bbBasis.map((value, i) => value - 2 * bbStd[i]),
  };
}

function crossUp(series, level, i) {
  const current = Array.isArray(level) ? level[i] : level;
  const prev = Array.isArray(level) ? level[i - 1] : level;
  return series[i] > current && series[i - 1] <= prev;
}

function crossDown(series, level, i) {
  const current = Array.isArray(level) ? level[i] : level;
  const prev = Array.isArray(level) ? level[i - 1] : level;
  return series[i] < current && series[i - 1] >= prev;
}

function primitives() {
  return {
    trend: [
      ["ema50_200", (c, i, s) => s === "long" ? c.close[i] > c.ema200[i] && c.ema50[i] > c.ema200[i] : c.close[i] < c.ema200[i] && c.ema50[i] < c.ema200[i]],
      ["ema20_50", (c, i, s) => s === "long" ? c.ema20[i] > c.ema50[i] && c.close[i] > c.ema20[i] : c.ema20[i] < c.ema50[i] && c.close[i] < c.ema20[i]],
      ["ema50_slope", (c, i, s) => s === "long" ? c.ema50[i] > c.ema50[i - 6] : c.ema50[i] < c.ema50[i - 6]],
      ["macd_regime", (c, i, s) => s === "long" ? c.macd.line[i] > 0 : c.macd.line[i] < 0],
      ["bb_side", (c, i, s) => s === "long" ? c.close[i] > c.bbBasis[i] : c.close[i] < c.bbBasis[i]],
    ],
    trigger: [
      ["break20", (c, i, s) => s === "long" ? c.close[i] > highest(c.high, 20, i, true) : c.close[i] < lowest(c.low, 20, i, true)],
      ["break55", (c, i, s) => s === "long" ? c.close[i] > highest(c.high, 55, i, true) : c.close[i] < lowest(c.low, 55, i, true)],
      ["ema20_reclaim", (c, i, s) => s === "long" ? c.low[i] <= c.ema20[i] && c.close[i] > c.ema20[i] : c.high[i] >= c.ema20[i] && c.close[i] < c.ema20[i]],
      ["rsi50_cross", (c, i, s) => s === "long" ? crossUp(c.rsi14, 50, i) : crossDown(c.rsi14, 50, i)],
      ["macd_hist_flip", (c, i, s) => s === "long" ? crossUp(c.macd.hist, 0, i) : crossDown(c.macd.hist, 0, i)],
      ["bb_break", (c, i, s) => s === "long" ? c.close[i] > c.bbUpper[i] : c.close[i] < c.bbLower[i]],
      ["bb_mean_reclaim", (c, i, s) => s === "long" ? c.close[i - 1] < c.bbLower[i - 1] && c.close[i] > c.bbLower[i] : c.close[i - 1] > c.bbUpper[i - 1] && c.close[i] < c.bbUpper[i]],
      ["quiet_break20", (c, i, s) => c.natr50[i - 1] < c.natr100[i - 1] * 0.9 && (s === "long" ? c.close[i] > highest(c.high, 20, i, true) : c.close[i] < lowest(c.low, 20, i, true))],
    ],
    confirm: [
      ["rsi_quality", (c, i, s) => s === "long" ? c.rsi14[i] > 52 && c.rsi14[i] < 74 : c.rsi14[i] < 48 && c.rsi14[i] > 26],
      ["macd_accel", (c, i, s) => s === "long" ? c.macd.hist[i] > c.macd.hist[i - 2] : c.macd.hist[i] < c.macd.hist[i - 2]],
      ["cmf_flow", (c, i, s) => s === "long" ? c.cmf20[i] > 0.03 : c.cmf20[i] < -0.03],
      ["mfi_flow", (c, i, s) => s === "long" ? c.mfi14[i] > 52 : c.mfi14[i] < 48],
      ["volume_120", (c, i) => c.volume[i] > c.volSma20[i] * 1.2],
      ["volume_160", (c, i) => c.volume[i] > c.volSma20[i] * 1.6],
      ["atr_expand", (c, i) => c.natr[i] > c.natr50[i]],
      ["not_overextended", (c, i) => Math.abs(c.close[i] - c.ema20[i]) < c.atr14[i] * 2.2],
    ],
  };
}

function makeRules(maxRules) {
  const p = primitives();
  const profiles = [
    { rr: 1.2, stopAtr: 0.8, minStopPct: 0.12, trailAtr: 0 },
    { rr: 1.5, stopAtr: 1.0, minStopPct: 0.16, trailAtr: 0 },
    { rr: 1.8, stopAtr: 1.2, minStopPct: 0.2, trailAtr: 1.8 },
    { rr: 2.3, stopAtr: 1.5, minStopPct: 0.25, trailAtr: 2.4 },
  ];
  const base = [];
  for (const side of ["long", "short"]) {
    for (const trend of p.trend) {
      for (const trigger of p.trigger) {
        for (const confirm of p.confirm) {
          base.push({
            side,
            parts: [trend, trigger, confirm],
            label: `${side} ${trend[0]} + ${trigger[0]} + ${confirm[0]}`,
          });
        }
      }
    }
  }
  const rules = [];
  for (const item of base.slice(0, Math.max(1, Math.floor(maxRules / profiles.length)))) {
    for (const profile of profiles) {
      rules.push({
        ...item,
        ...profile,
        name: `${item.label} rr${profile.rr} atr${profile.stopAtr}`,
      });
    }
  }
  return rules.slice(0, maxRules);
}

function hasSignal(ctx, rule, i) {
  return rule.parts.every(([, fn]) => fn(ctx, i, rule.side));
}

function openPosition(rule, candle, equity, ctx, i) {
  const feeRate = FEE_BPS / 10000;
  const slipRate = SLIP_BPS / 10000;
  const notional = equity * LEVERAGE;
  const entry = candle.o * (rule.side === "long" ? 1 + slipRate : 1 - slipRate);
  const stopDistance = Math.max(ctx.atr14[i] * rule.stopAtr, entry * rule.minStopPct / 100);
  const targetDistance = stopDistance * rule.rr;
  return {
    side: rule.side,
    entry,
    qty: notional / entry,
    entryFee: notional * feeRate,
    stop: rule.side === "long" ? entry - stopDistance : entry + stopDistance,
    target: rule.side === "long" ? entry + targetDistance : entry - targetDistance,
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

function backtest(ctx, rule, start, end, windowDays) {
  let equity = 1000;
  let peak = 1000;
  let maxDrawdownPct = 0;
  let pos = null;
  let pending = false;
  const trades = [];
  for (let i = start; i <= end; i += 1) {
    const candle = ctx.candles[i];
    if (pending && !pos) {
      pos = openPosition(rule, candle, equity, ctx, i);
      equity -= pos.entryFee;
    }
    pending = false;
    if (pos) {
      const [exit, reason] = stopOrTarget(pos, candle);
      if (exit != null) {
        equity = closePosition(pos, exit, equity, trades, reason);
        pos = null;
      }
    }
    if (pos && rule.trailAtr) {
      const trail = ctx.atr14[i] * rule.trailAtr;
      if (pos.side === "long") pos.stop = Math.max(pos.stop, ctx.close[i] - trail);
      else pos.stop = Math.min(pos.stop, ctx.close[i] + trail);
    }
    const mark = pos
      ? equity + (pos.side === "long" ? (ctx.close[i] - pos.entry) * pos.qty : (pos.entry - ctx.close[i]) * pos.qty)
      : equity;
    peak = Math.max(peak, mark);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - mark) / peak * 100 : 0);
    if (!pos && i < end && hasSignal(ctx, rule, i)) pending = true;
  }
  if (pos) equity = closePosition(pos, ctx.candles[end].c, equity, trades, "end");
  const wins = trades.filter((row) => row.pnl > 0);
  const profit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const loss = -trades.filter((row) => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0);
  return {
    totalReturnPct: round((equity / 1000 - 1) * 100),
    dailyPct: equity > 0 ? round((Math.pow(equity / 1000, 1 / windowDays) - 1) * 100) : -100,
    maxDrawdownPct: round(maxDrawdownPct),
    trades: trades.length,
    winRatePct: trades.length ? round(wins.length / trades.length * 100, 2) : 0,
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
    winRatePct: round(avg(rows.map((row) => row.winRatePct))),
  };
}

function nestedSelector(results, rules, windowCount, minTrainWindows = 4) {
  const byRule = new Map();
  const byRuleWindow = new Map();
  for (const row of results) {
    if (!byRule.has(row.rule)) byRule.set(row.rule, []);
    byRule.get(row.rule).push(row);
    const windowKey = `${row.rule}\t${row.windowIndex}`;
    if (!byRuleWindow.has(windowKey)) byRuleWindow.set(windowKey, []);
    byRuleWindow.get(windowKey).push(row);
  }
  const periods = [];
  for (let windowIndex = windowCount - minTrainWindows - 1; windowIndex >= 0; windowIndex -= 1) {
    const ranked = rules.map((rule) => {
      const training = (byRule.get(rule.name) || []).filter((row) => row.windowIndex > windowIndex);
      const summary = summarize(training);
      const activityPenalty = Math.abs((summary.medianTrades ?? 0) - 2) * 0.01;
      const score = (summary.medianDailyPct ?? -10) * 2
        + (summary.avgDailyPct ?? -10)
        + Math.min(0, summary.worstDailyPct ?? -10) * 0.25
        + (summary.positivePct ?? 0) * 0.004
        - (summary.avgDrawdownPct ?? 100) * 0.012
        - activityPenalty;
      return { rule, summary, score };
    }).filter((row) => row.summary.samples >= minTrainWindows * 10 && (row.summary.medianTrades ?? 0) > 0)
      .sort((a, b) => b.score - a.score);
    const chosen = ranked[0];
    if (!chosen) continue;
    const current = byRuleWindow.get(`${chosen.rule.name}\t${windowIndex}`) || [];
    const currentSummary = summarize(current);
    periods.push({
      windowIndex,
      dailyPct: currentSummary.avgDailyPct,
      medianDailyPct: currentSummary.medianDailyPct,
      drawdownPct: currentSummary.avgDrawdownPct,
      selectedRule: chosen.rule.name,
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

function scoreSummary(summary) {
  const activityPenalty = Math.abs((summary.medianTrades ?? 0) - 2) * 0.01;
  return (summary.medianDailyPct ?? -10) * 2
    + (summary.avgDailyPct ?? -10)
    + Math.min(0, summary.worstDailyPct ?? -10) * 0.25
    + (summary.positivePct ?? 0) * 0.004
    + Math.min(summary.winRatePct ?? 0, 65) * 0.001
    - (summary.avgDrawdownPct ?? 100) * 0.012
    - activityPenalty;
}

function symbolAdaptiveSelector(results, rules, windowCount, minTrainWindows = 4) {
  const symbols = [...new Set(results.map((row) => row.symbol))];
  const bySymbolRule = new Map();
  const bySymbolRuleWindow = new Map();
  for (const row of results) {
    const key = `${row.symbol}\t${row.rule}`;
    if (!bySymbolRule.has(key)) bySymbolRule.set(key, []);
    bySymbolRule.get(key).push(row);
    bySymbolRuleWindow.set(`${key}\t${row.windowIndex}`, row);
  }
  const periods = [];
  for (let windowIndex = windowCount - minTrainWindows - 1; windowIndex >= 0; windowIndex -= 1) {
    const chosenRows = [];
    const choices = [];
    for (const symbol of symbols) {
      const ranked = rules.map((rule) => {
        const training = (bySymbolRule.get(`${symbol}\t${rule.name}`) || []).filter((row) => row.windowIndex > windowIndex);
        const summary = summarize(training);
        return { rule, summary, score: scoreSummary(summary) };
      }).filter((row) => row.summary.samples >= minTrainWindows && (row.summary.medianTrades ?? 0) > 0)
        .sort((a, b) => b.score - a.score);
      const chosen = ranked[0];
      if (!chosen) continue;
      const current = bySymbolRuleWindow.get(`${symbol}\t${chosen.rule.name}\t${windowIndex}`);
      if (!current) continue;
      chosenRows.push(current);
      choices.push({ symbol, rule: chosen.rule.name, training: chosen.summary, score: round(chosen.score) });
    }
    const currentSummary = summarize(chosenRows);
    periods.push({
      windowIndex,
      selectedSymbols: chosenRows.length,
      dailyPct: currentSummary.avgDailyPct,
      medianDailyPct: currentSummary.medianDailyPct,
      drawdownPct: currentSummary.avgDrawdownPct,
      positivePct: currentSummary.positivePct,
      medianTrades: currentSummary.medianTrades,
      topChoices: Object.entries(choices.reduce((acc, row) => {
        acc[row.rule] = (acc[row.rule] || 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5),
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

function passesGlobalGate(summary) {
  return (summary.avgDailyPct ?? -10) > 0.025
    && (summary.positivePct ?? 0) >= 42
    && (summary.avgDrawdownPct ?? 100) <= 16
    && (summary.medianTrades ?? 0) > 0;
}

function gatedNestedSelector(results, rules, windowCount, minTrainWindows = 4) {
  const byRule = new Map();
  const byRuleWindow = new Map();
  for (const row of results) {
    if (!byRule.has(row.rule)) byRule.set(row.rule, []);
    byRule.get(row.rule).push(row);
    const windowKey = `${row.rule}\t${row.windowIndex}`;
    if (!byRuleWindow.has(windowKey)) byRuleWindow.set(windowKey, []);
    byRuleWindow.get(windowKey).push(row);
  }
  const periods = [];
  for (let windowIndex = windowCount - minTrainWindows - 1; windowIndex >= 0; windowIndex -= 1) {
    const ranked = rules.map((rule) => {
      const training = (byRule.get(rule.name) || []).filter((row) => row.windowIndex > windowIndex);
      const summary = summarize(training);
      return { rule, summary, score: scoreSummary(summary) };
    }).filter((row) => row.summary.samples >= minTrainWindows * 10 && passesGlobalGate(row.summary))
      .sort((a, b) => b.score - a.score);
    const chosen = ranked[0];
    if (!chosen) {
      periods.push({
        windowIndex,
        dailyPct: 0,
        medianDailyPct: 0,
        drawdownPct: 0,
        selectedRule: "NO_TRADE",
        training: { avgDailyPct: 0 },
      });
      continue;
    }
    const currentSummary = summarize(byRuleWindow.get(`${chosen.rule.name}\t${windowIndex}`) || []);
    periods.push({
      windowIndex,
      dailyPct: currentSummary.avgDailyPct,
      medianDailyPct: currentSummary.medianDailyPct,
      drawdownPct: currentSummary.avgDrawdownPct,
      selectedRule: chosen.rule.name,
      training: chosen.summary,
    });
  }
  const values = periods.map((row) => row.dailyPct).filter(Number.isFinite);
  return {
    summary: {
      periods: values.length,
      activePeriods: periods.filter((row) => row.selectedRule !== "NO_TRADE").length,
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
  return [
    "# Edge Miner Solution",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} Binance USD-M perpetuals`,
    `Interval: ${report.interval}; windows: ${report.windowDays} days; leverage: ${report.leverage}x; costs: ${report.feeBps}+${report.slippageBps} bps`,
    `Rules tested: ${report.rules.length}`,
    "",
    "## Nested Selector",
    "",
    "| Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % |",
    "|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.nested.summary.periods} | ${report.nested.summary.positivePeriods}/${report.nested.summary.periods} | ${report.nested.summary.avgDailyPct} | ${report.nested.summary.medianDailyPct} | ${report.nested.summary.worstDailyPct} | ${report.nested.summary.bestDailyPct} | ${report.nested.summary.avgDrawdownPct} |`,
    "",
    "## Symbol Adaptive Shadow Selector",
    "",
    "| Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % |",
    "|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.symbolAdaptive.summary.periods} | ${report.symbolAdaptive.summary.positivePeriods}/${report.symbolAdaptive.summary.periods} | ${report.symbolAdaptive.summary.avgDailyPct} | ${report.symbolAdaptive.summary.medianDailyPct} | ${report.symbolAdaptive.summary.worstDailyPct} | ${report.symbolAdaptive.summary.bestDailyPct} | ${report.symbolAdaptive.summary.avgDrawdownPct} |`,
    "",
    "## Gated Shadow Selector",
    "",
    "| Periods | Active | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.gated.summary.periods} | ${report.gated.summary.activePeriods} | ${report.gated.summary.positivePeriods}/${report.gated.summary.periods} | ${report.gated.summary.avgDailyPct} | ${report.gated.summary.medianDailyPct} | ${report.gated.summary.worstDailyPct} | ${report.gated.summary.bestDailyPct} | ${report.gated.summary.avgDrawdownPct} |`,
    "",
    "## Best Fixed Rules",
    "",
    "| # | Rule | Samples | Positive % | Avg Daily % | Median % | Worst % | Best % | DD % | Trades | WR % |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.fixed.slice(0, 30).map((row, index) => `| ${index + 1} | ${row.rule} | ${row.summary.samples} | ${row.summary.positivePct} | ${row.summary.avgDailyPct} | ${row.summary.medianDailyPct} | ${row.summary.worstDailyPct} | ${row.summary.bestDailyPct} | ${row.summary.avgDrawdownPct} | ${row.summary.medianTrades} | ${row.summary.winRatePct} |`),
    "",
    "## Blind Periods",
    "",
    "| Window | Avg Daily % | Median % | DD % | Selected Rule | Training Avg % |",
    "|---:|---:|---:|---:|---|---:|",
    ...report.nested.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.medianDailyPct} | ${row.drawdownPct} | ${row.selectedRule} | ${row.training.avgDailyPct} |`),
    "",
    "## Symbol Adaptive Blind Periods",
    "",
    "| Window | Symbols | Avg Daily % | Median % | Positive % | DD % | Trades | Top Choice Count |",
    "|---:|---:|---:|---:|---:|---:|---:|---|",
    ...report.symbolAdaptive.periods.map((row) => `| ${row.windowIndex} | ${row.selectedSymbols} | ${row.dailyPct} | ${row.medianDailyPct} | ${row.positivePct} | ${row.drawdownPct} | ${row.medianTrades} | ${row.topChoices.map(([rule, count]) => `${count}x ${rule}`).join("<br>")} |`),
    "",
    "## Gated Blind Periods",
    "",
    "| Window | Avg Daily % | Median % | DD % | Selected Rule | Training Avg % |",
    "|---:|---:|---:|---:|---|---:|",
    ...report.gated.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.medianDailyPct} | ${row.drawdownPct} | ${row.selectedRule} | ${row.training.avgDailyPct} |`),
    "",
    "Research only. This is not a profit guarantee.",
    "",
  ].join("\n");
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
  const rules = makeRules(args.maxRules);
  const results = [];
  for (const [ruleIndex, rule] of rules.entries()) {
    for (const dataset of datasets) {
      for (const window of buildWindows(dataset.candles, args.days, args.windowDays)) {
        results.push({
          rule: rule.name,
          symbol: dataset.symbol,
          windowIndex: window.windowIndex,
          ...backtest(dataset.ctx, rule, window.start, window.end, args.windowDays),
        });
      }
    }
    if ((ruleIndex + 1) % 100 === 0 || ruleIndex + 1 === rules.length) console.error(`tested ${ruleIndex + 1}/${rules.length}`);
  }
  const windowCount = results.reduce((maxWindow, row) => Math.max(maxWindow, row.windowIndex), 0) + 1;
  const fixed = rules.map((rule) => ({
    rule: rule.name,
    summary: summarize(results.filter((row) => row.rule === rule.name)),
  })).sort((a, b) => (b.summary.medianDailyPct ?? -Infinity) - (a.summary.medianDailyPct ?? -Infinity)
    || (b.summary.avgDailyPct ?? -Infinity) - (a.summary.avgDailyPct ?? -Infinity));
  const nested = nestedSelector(results, rules, windowCount, 4);
  const symbolAdaptive = symbolAdaptiveSelector(results, rules, windowCount, 4);
  const gated = gatedNestedSelector(results, rules, windowCount, 4);
  const report = {
    generatedAt: new Date().toISOString(),
    interval: args.interval,
    days: args.days,
    windowDays: args.windowDays,
    leverage: LEVERAGE,
    feeBps: FEE_BPS,
    slippageBps: SLIP_BPS,
    symbols: datasets.map((row) => row.symbol),
    rules: rules.map((row) => row.name),
    nested,
    symbolAdaptive,
    gated,
    fixed,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table([nested.summary]);
  console.table([symbolAdaptive.summary]);
  console.table([gated.summary]);
  console.table(fixed.slice(0, 20).map((row) => ({
    rule: row.rule,
    pos: row.summary.positivePct,
    avg: row.summary.avgDailyPct,
    median: row.summary.medianDailyPct,
    worst: row.summary.worstDailyPct,
    best: row.summary.bestDailyPct,
    dd: row.summary.avgDrawdownPct,
    trades: row.summary.medianTrades,
  })));
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
