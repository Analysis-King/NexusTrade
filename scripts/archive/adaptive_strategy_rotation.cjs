#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const DEFAULT_COST_BPS = 12;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    candidates: 110,
    interval: "4h",
    minCoveragePct: 70,
    holdoutDays: 180,
    windowDays: 90,
    holdoutSymbolPct: 40,
    costBps: DEFAULT_COST_BPS,
    output: path.join("data", "adaptive_strategy_rotation.json"),
    markdown: path.join("data", "adaptive_strategy_rotation.md"),
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
  return Number.isFinite(mean) ? Math.sqrt(avg(values.map((value) => (value - mean) ** 2))) : null;
}

async function fetchTopFuturesSymbols(limit) {
  const stableOrFiat = new Set([
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDE", "USD1",
    "RLUSD", "XUSD", "EUR", "TRY", "BRL", "ARS", "AEUR", "PAXG", "XAUT",
  ]);
  const nonCrypto = new Set([
    "XAU", "XAG", "SPX", "SPY", "QQQ", "SOXL", "EWY",
    "TSLA", "NVDA", "AMD", "INTC", "ARM", "MSTR", "MRVL", "WDC", "HOOD",
    "SKHYNIX", "DRAM", "CRCL", "NBIS", "RKLB",
  ]);
  const response = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  if (!response.ok) throw new Error(`ticker ${response.status}: ${await response.text()}`);
  const rows = await response.json();
  return rows.filter((row) => {
    const symbol = String(row.symbol || "");
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
    const base = symbol.slice(0, -4);
    if (stableOrFiat.has(base) || nonCrypto.has(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
    return Number(row.quoteVolume || 0) > 0;
  })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((row) => row.symbol);
}

async function fetchCandles(symbol, interval, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit: 1500 }).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} ${response.status}: ${await response.text()}`);
    const rows = await response.json();
    if (!rows.length) break;
    for (const row of rows) all.push({ t: Number(row[0]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]) });
    const next = Number(rows.at(-1)[6]) + 1;
    if (next <= cursor || rows.length < 1500) break;
    cursor = next;
    await sleep(20);
  }
  return [...new Map(all.map((row) => [row.t, row])).values()].sort((a, b) => a.t - b.t);
}

function ema(values, period) {
  const output = [];
  const alpha = 2 / (period + 1);
  for (const value of values) output.push(output.length ? value * alpha + output.at(-1) * (1 - alpha) : value);
  return output;
}

function prepare(symbol, candles) {
  return {
    symbol,
    candles,
    closes: candles.map((row) => row.c),
    maps: new Map(candles.map((row, index) => [row.t, index])),
  };
}

function signalPositions(series, base, direction) {
  const positions = Array(series.candles.length).fill(0);
  const trend = ema(series.closes, base.ema);
  let position = 0;
  for (let index = Math.max(base.breakout, base.ema) + 1; index < series.candles.length; index += 1) {
    const close = series.closes[index];
    const breakoutHigh = Math.max(...series.candles.slice(index - base.breakout, index).map((row) => row.h));
    const breakoutLow = Math.min(...series.candles.slice(index - base.breakout, index).map((row) => row.l));
    const exitHigh = Math.max(...series.candles.slice(index - base.exit, index).map((row) => row.h));
    const exitLow = Math.min(...series.candles.slice(index - base.exit, index).map((row) => row.l));
    if (direction > 0) {
      if (!position && close > breakoutHigh && close > trend[index]) position = 1;
      else if (position && (close < exitLow || close < trend[index])) position = 0;
    } else {
      if (!position && close < breakoutLow && close < trend[index]) position = -1;
      else if (position && (close > exitHigh || close > trend[index])) position = 0;
    }
    positions[index] = position;
  }
  return positions;
}

function buildSleeves(dataset, times, base, costRate) {
  const sleeves = [];
  for (const series of dataset) {
    for (const direction of [1, -1]) {
      const rawPositions = signalPositions(series, base, direction);
      const positions = [];
      const returns = [];
      let previousPosition = 0;
      let previousClose = null;
      for (const time of times) {
        const index = series.maps.get(time);
        const position = Number.isInteger(index) ? rawPositions[index] : 0;
        const close = Number.isInteger(index) ? series.closes[index] : previousClose;
        const priceReturn = previousClose && close ? previousPosition * (close / previousClose - 1) : 0;
        const turnoverCost = Math.abs(position - previousPosition) * costRate;
        positions.push(position);
        returns.push(priceReturn - turnoverCost);
        previousPosition = position;
        previousClose = close;
      }
      sleeves.push({ symbol: series.symbol, direction, positions, returns });
    }
  }
  return sleeves;
}

function sleeveScore(sleeve, index, cfg) {
  if (index < cfg.lookback) return null;
  const values = sleeve.returns.slice(index - cfg.lookback + 1, index + 1);
  const total = values.reduce((growth, value) => growth * Math.max(0.01, 1 + value), 1) - 1;
  const volatility = Math.max(stddev(values), 1e-6);
  if (total <= cfg.minTrailingReturn) return null;
  return cfg.scoreMode === "sharpe" ? avg(values) / volatility : total;
}

function simulate(dataset, times, sleeves, cfg, startTime, endTime, costRate) {
  const seriesMap = new Map(dataset.map((row) => [row.symbol, row]));
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let previousTime = null;
  let weights = new Map();
  let rebalanceCounter = cfg.rebalance;
  let turnover = 0;
  let activePeriods = 0;
  for (let timeIndex = 0; timeIndex < times.length; timeIndex += 1) {
    const time = times[timeIndex];
    if (time < startTime || time > endTime) continue;
    if (previousTime != null) {
      let portfolioReturn = 0;
      for (const [symbol, weight] of weights) {
        const series = seriesMap.get(symbol);
        const current = series?.maps.get(time);
        const previous = series?.maps.get(previousTime);
        if (Number.isInteger(current) && Number.isInteger(previous)) {
          portfolioReturn += weight * (series.closes[current] / series.closes[previous] - 1);
        }
      }
      equity *= Math.max(0, 1 + portfolioReturn);
      if (weights.size) activePeriods += 1;
    }
    if (equity <= 0) break;
    rebalanceCounter += 1;
    if (rebalanceCounter >= cfg.rebalance) {
      const ranked = sleeves.map((sleeve) => ({
        sleeve,
        score: sleeveScore(sleeve, timeIndex, cfg),
        position: sleeve.positions[timeIndex],
        vol: Math.max(stddev(sleeve.returns.slice(Math.max(0, timeIndex - cfg.lookback + 1), timeIndex + 1)), 1e-5),
      })).filter((row) => Number.isFinite(row.score) && row.position !== 0)
        .sort((a, b) => b.score - a.score);
      const selected = [];
      const symbols = new Set();
      for (const row of ranked) {
        if (symbols.has(row.sleeve.symbol)) continue;
        selected.push(row);
        symbols.add(row.sleeve.symbol);
        if (selected.length >= cfg.count) break;
      }
      const next = new Map();
      if (selected.length) {
        const rawTotal = cfg.weightMode === "inverseVol"
          ? selected.reduce((sum, row) => sum + 1 / row.vol, 0)
          : selected.length;
        for (const row of selected) {
          const fraction = cfg.weightMode === "inverseVol" ? (1 / row.vol) / rawTotal : 1 / selected.length;
          next.set(row.sleeve.symbol, row.position * cfg.leverage * fraction);
        }
      }
      const allSymbols = new Set([...weights.keys(), ...next.keys()]);
      const currentTurnover = [...allSymbols].reduce((sum, symbol) => sum + Math.abs((next.get(symbol) || 0) - (weights.get(symbol) || 0)), 0);
      equity *= Math.max(0, 1 - currentTurnover * costRate);
      turnover += currentTurnover;
      weights = next;
      rebalanceCounter = 0;
    }
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / Math.max(peak, 1e-12) * 100);
    previousTime = time;
  }
  const days = Math.max(1, (endTime - startTime) / DAY);
  return {
    totalReturnPct: round((equity / 1000 - 1) * 100),
    dailyPct: equity > 0 ? round((Math.pow(equity / 1000, 1 / days) - 1) * 100) : -100,
    maxDrawdownPct: round(maxDrawdownPct),
    turnover: round(turnover, 2),
    activePct: round(activePeriods / Math.max(1, days * 6) * 100, 2),
  };
}

function buildConfigs() {
  const bases = [
    { name: "fast", breakout: 20, exit: 10, ema: 50 },
    { name: "balanced", breakout: 55, exit: 20, ema: 100 },
    { name: "slow", breakout: 89, exit: 34, ema: 200 },
  ];
  const configs = [];
  for (const base of bases) {
    for (const lookback of [42, 90, 180]) {
      for (const rebalance of [6, 18]) {
        for (const count of [3, 6]) {
          for (const leverage of [1, 2, 3, 4]) {
            for (const scoreMode of ["return", "sharpe"]) {
              for (const weightMode of ["equal"]) {
                configs.push({
                  name: `${base.name}-lb${lookback}-r${rebalance}-n${count}-l${leverage}-${scoreMode}-${weightMode}`,
                  base,
                  lookback,
                  rebalance,
                  count,
                  leverage,
                  scoreMode,
                  weightMode,
                  minTrailingReturn: 0,
                });
              }
            }
          }
        }
      }
    }
  }
  return configs;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function splitDataset(dataset, holdoutPct) {
  const ordered = [...dataset].sort((a, b) => stableHash(a.symbol) - stableHash(b.symbol));
  const count = Math.max(4, Math.min(ordered.length - 4, Math.round(ordered.length * holdoutPct / 100)));
  return { holdout: ordered.slice(0, count), tuning: ordered.slice(count) };
}

function buildWindows(endTime, startTime, windowDays) {
  const windows = [];
  let end = endTime;
  while (end - windowDays * DAY >= startTime) {
    windows.push({ startTime: end - windowDays * DAY, endTime: end });
    end -= windowDays * DAY;
  }
  return windows;
}

function summarize(rows) {
  const values = rows.map((row) => row.dailyPct).filter(Number.isFinite);
  const mean = avg(values);
  const deviation = stddev(values);
  return {
    periods: rows.length,
    positivePct: rows.length ? round(rows.filter((row) => row.dailyPct > 0).length / rows.length * 100, 2) : null,
    avgDailyPct: round(mean),
    medianDailyPct: round(median(values)),
    worstDailyPct: values.length ? round(Math.min(...values)) : null,
    avgMaxDrawdownPct: round(avg(rows.map((row) => row.maxDrawdownPct))),
    worstMaxDrawdownPct: rows.length ? round(Math.max(...rows.map((row) => row.maxDrawdownPct))) : null,
    lowerConfidenceDailyPct: values.length ? round(mean - 0.75 * deviation / Math.sqrt(values.length) + Math.min(0, Math.min(...values)) * 0.25) : null,
  };
}

function robustScore(summary) {
  if (!summary || summary.periods < 4 || summary.positivePct < 60 || summary.worstDailyPct < -0.8) return -Infinity;
  if (summary.avgMaxDrawdownPct > 45 || summary.worstMaxDrawdownPct > 70) return -Infinity;
  return summary.lowerConfidenceDailyPct - summary.avgMaxDrawdownPct * 0.015;
}

function toMarkdown(report) {
  const lines = [
    "# Adaptive Strategy Rotation",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} Binance perpetuals; ${report.interval}; one-way costs: ${report.costBps} bps`,
    "",
    `Selected on older tuning data only: **${report.selected?.config?.name || "none"}**`,
    "",
    "| Split | Periods | Positive % | Avg Daily % | Median % | Worst % | Avg DD % | Worst DD % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(report.strict).map(([name, section]) => `| ${name} | ${section.summary.periods} | ${section.summary.positivePct} | ${section.summary.avgDailyPct} | ${section.summary.medianDailyPct} | ${section.summary.worstDailyPct} | ${section.summary.avgMaxDrawdownPct} | ${section.summary.worstMaxDrawdownPct} |`),
    "",
    `Strict acceptance: **${report.accepted ? "PASS" : "FAIL"}**`,
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const costRate = args.costBps / 10_000;
  const candidates = await fetchTopFuturesSymbols(args.candidates);
  const dataset = [];
  for (const symbol of candidates) {
    if (dataset.length >= args.symbols) break;
    try {
      const candles = await fetchCandles(symbol, args.interval, args.days);
      const coveragePct = candles.length ? (Date.now() - candles[0].t) / (args.days * DAY) * 100 : 0;
      if (candles.length >= 1000 && coveragePct >= args.minCoveragePct) dataset.push(prepare(symbol, candles));
      console.error(`${coveragePct >= args.minCoveragePct ? "loaded" : "skip"} ${symbol}: bars=${candles.length}, coverage=${round(coveragePct, 1)}%`);
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  if (dataset.length < 12) throw new Error(`Only ${dataset.length} symbols passed coverage gate.`);
  const newest = Math.min(...dataset.map((row) => row.candles.at(-1).t));
  const oldest = Math.max(...dataset.map((row) => row.candles[0].t));
  const holdoutStart = newest - args.holdoutDays * DAY;
  const split = splitDataset(dataset, args.holdoutSymbolPct);
  const configs = buildConfigs();
  const timesFor = (rows) => [...new Set(rows.flatMap((series) => series.candles.map((row) => row.t)))].sort((a, b) => a - b);
  const cache = new Map();
  const getContext = (rows, base) => {
    const key = `${rows.map((row) => row.symbol).join(",")}|${base.name}|${args.costBps}`;
    if (!cache.has(key)) {
      const times = timesFor(rows);
      cache.set(key, { times, sleeves: buildSleeves(rows, times, base, costRate) });
    }
    return cache.get(key);
  };
  const trainingWindows = buildWindows(holdoutStart, oldest, args.windowDays);
  const ranked = [];
  for (const config of configs) {
    const context = getContext(split.tuning, config.base);
    const rows = trainingWindows.map((window) => simulate(split.tuning, context.times, context.sleeves, config, window.startTime, window.endTime, costRate));
    const summary = summarize(rows);
    ranked.push({ config, summary, score: robustScore(summary) });
  }
  ranked.sort((a, b) => b.score - a.score);
  const selected = ranked.find((row) => Number.isFinite(row.score)) || ranked[0];
  const evaluate = (rows, windows) => {
    const context = getContext(rows, selected.config.base);
    const periods = windows.map((window) => simulate(rows, context.times, context.sleeves, selected.config, window.startTime, window.endTime, costRate));
    return { summary: summarize(periods), periods };
  };
  const newestWindows = buildWindows(newest, holdoutStart, args.windowDays);
  const strict = {
    tuningOlder: evaluate(split.tuning, trainingWindows),
    tuningNewestTime: evaluate(split.tuning, newestWindows),
    holdoutSymbolsOlderTime: evaluate(split.holdout, trainingWindows),
    strictJointHoldout: evaluate(split.holdout, newestWindows),
  };
  const joint = strict.strictJointHoldout.summary;
  const report = {
    generatedAt: new Date().toISOString(),
    interval: args.interval,
    costBps: args.costBps,
    symbols: dataset.map((row) => row.symbol),
    tuningSymbols: split.tuning.map((row) => row.symbol),
    holdoutSymbols: split.holdout.map((row) => row.symbol),
    selected,
    strict,
    accepted: joint.avgDailyPct >= 0.8 && joint.positivePct >= 75 && joint.worstDailyPct > -0.5,
    topTraining: ranked.slice(0, 30),
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table(Object.entries(strict).map(([name, section]) => ({ name, ...section.summary })));
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
