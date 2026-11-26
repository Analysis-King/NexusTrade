#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const COST_RATE = 0.0012;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 900,
    symbols: 50,
    candidates: 110,
    interval: "1h",
    minCoveragePct: 70,
    holdoutDays: 180,
    windowDays: 90,
    holdoutSymbolPct: 40,
    output: path.join("data", "orderflow_cross_sectional_research.json"),
    markdown: path.join("data", "orderflow_cross_sectional_research.md"),
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
  const response = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  if (!response.ok) throw new Error(`ticker ${response.status}: ${await response.text()}`);
  const rows = await response.json();
  return rows.filter((row) => /^[A-Z0-9]+USDT$/.test(String(row.symbol || "")) && Number(row.quoteVolume || 0) > 0)
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
    for (const row of rows) {
      all.push({
        t: Number(row[0]),
        c: Number(row[4]),
        v: Number(row[5]),
        q: Number(row[7]),
        takerBuy: Number(row[9]),
      });
    }
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

function rollingStd(values, period) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    output.push(Math.max(stddev(values.slice(Math.max(0, index - period + 1), index + 1)), 1e-6));
  }
  return output;
}

function prepare(symbol, candles) {
  const closes = candles.map((row) => row.c);
  const returns = closes.map((close, index) => index ? Math.log(close / closes[index - 1]) : 0);
  const ofi = candles.map((row) => row.v > 0 ? 2 * row.takerBuy / row.v - 1 : 0);
  const quote = candles.map((row) => Math.max(row.q, 1));
  const quoteEma = ema(quote, 24);
  return {
    symbol,
    candles,
    closes,
    maps: new Map(candles.map((row, index) => [row.t, index])),
    returns,
    vol24: rollingStd(returns, 24),
    ofi3: ema(ofi, 3),
    ofi6: ema(ofi, 6),
    ofi12: ema(ofi, 12),
    ofi24: ema(ofi, 24),
    volumeShock: quote.map((value, index) => Math.log(value / Math.max(quoteEma[index], 1))),
  };
}

function momentum(series, index, lookback) {
  return index >= lookback ? Math.log(series.closes[index] / series.closes[index - lookback]) : 0;
}

function zscores(rows, key) {
  const mean = avg(rows.map((row) => row[key]));
  const deviation = Math.max(stddev(rows.map((row) => row[key])), 1e-6);
  for (const row of rows) row[`${key}Z`] = (row[key] - mean) / deviation;
}

function desiredWeights(dataset, time, cfg) {
  const rows = [];
  for (const series of dataset) {
    const index = series.maps.get(time);
    if (!Number.isInteger(index) || index < Math.max(60, cfg.lookback)) continue;
    rows.push({
      symbol: series.symbol,
      ofi: series[`ofi${cfg.lookback}`][index],
      momentum: momentum(series, index, cfg.lookback),
      volumeShock: series.volumeShock[index],
      volatility: series.vol24[index],
    });
  }
  if (rows.length < cfg.count * 2) return new Map();
  for (const key of ["ofi", "momentum", "volumeShock"]) zscores(rows, key);
  for (const row of rows) {
    if (cfg.mode === "aligned") row.score = row.ofiZ + row.momentumZ + 0.25 * row.volumeShockZ;
    else if (cfg.mode === "divergence") row.score = row.ofiZ - row.momentumZ + 0.25 * row.volumeShockZ;
    else if (cfg.mode === "absorption") row.score = row.ofiZ * Math.max(0, row.volumeShockZ) - row.momentumZ;
    else if (cfg.mode === "impulse") row.score = row.ofiZ * (1 + Math.max(0, row.volumeShockZ)) + 0.5 * row.momentumZ;
    else row.score = row.ofiZ;
    row.score *= cfg.scoreDirection || 1;
  }
  const longs = rows.filter((row) => row.score >= cfg.minScore).sort((a, b) => b.score - a.score).slice(0, cfg.count);
  const shorts = rows.filter((row) => row.score <= -cfg.minScore).sort((a, b) => a.score - b.score).slice(0, cfg.count);
  const output = new Map();
  for (const [selected, side] of [[longs, 1], [shorts, -1]]) {
    if (!selected.length) continue;
    const total = selected.reduce((sum, row) => sum + 1 / row.volatility, 0);
    for (const row of selected) output.set(row.symbol, side * cfg.leverage * 0.5 * ((1 / row.volatility) / total));
  }
  return output;
}

function simulate(dataset, times, cfg, startTime, endTime) {
  const seriesMap = new Map(dataset.map((row) => [row.symbol, row]));
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let previousTime = null;
  let weights = new Map();
  let counter = cfg.rebalance;
  let turnover = 0;
  for (const time of times) {
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
    }
    if (equity <= 0) break;
    counter += 1;
    if (counter >= cfg.rebalance) {
      const next = desiredWeights(dataset, time, cfg);
      const symbols = new Set([...weights.keys(), ...next.keys()]);
      const currentTurnover = [...symbols].reduce((sum, symbol) => sum + Math.abs((next.get(symbol) || 0) - (weights.get(symbol) || 0)), 0);
      equity *= Math.max(0, 1 - currentTurnover * COST_RATE);
      turnover += currentTurnover;
      weights = next;
      counter = 0;
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
  };
}

function buildConfigs() {
  const configs = [];
  for (const mode of ["ofi", "aligned", "divergence", "absorption", "impulse"]) {
    for (const lookback of [6, 12, 24]) {
      for (const rebalance of [6, 12, 24]) {
        for (const count of [3, 6]) {
          for (const leverage of [1, 2, 3, 4]) {
            for (const minScore of [0.5]) {
              for (const scoreDirection of [1, -1]) {
                configs.push({
                  name: `${scoreDirection > 0 ? "" : "anti-"}${mode}-lb${lookback}-r${rebalance}-n${count}-l${leverage}-s${minScore}`,
                  mode,
                  lookback,
                  rebalance,
                  count,
                  leverage,
                  minScore,
                  scoreDirection,
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

function timesFor(dataset) {
  return [...new Set(dataset.flatMap((series) => series.candles.map((row) => row.t)))].sort((a, b) => a - b);
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
  return [
    "# Order-Flow Cross-Sectional Strategy",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} Binance perpetuals; ${report.interval}; one-way costs: 12 bps`,
    "",
    `Selected on older tuning data only: **${report.selected?.config?.name || "none"}**`,
    "",
    "| Split | Periods | Positive % | Avg Daily % | Median % | Worst % | Avg DD % | Worst DD % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(report.strict).map(([name, section]) => `| ${name} | ${section.summary.periods} | ${section.summary.positivePct} | ${section.summary.avgDailyPct} | ${section.summary.medianDailyPct} | ${section.summary.worstDailyPct} | ${section.summary.avgMaxDrawdownPct} | ${section.summary.worstMaxDrawdownPct} |`),
    "",
    `Strict acceptance: **${report.accepted ? "PASS" : "FAIL"}**`,
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const candidates = await fetchTopFuturesSymbols(args.candidates);
  const dataset = [];
  for (const symbol of candidates) {
    if (dataset.length >= args.symbols) break;
    try {
      const candles = await fetchCandles(symbol, args.interval, args.days);
      const coveragePct = candles.length ? (Date.now() - candles[0].t) / (args.days * DAY) * 100 : 0;
      if (candles.length >= 1500 && coveragePct >= args.minCoveragePct) dataset.push(prepare(symbol, candles));
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
  const tuningTimes = timesFor(split.tuning);
  const trainingWindows = buildWindows(holdoutStart, oldest, args.windowDays);
  const ranked = configs.map((config) => {
    const periods = trainingWindows.map((window) => simulate(split.tuning, tuningTimes, config, window.startTime, window.endTime));
    const summary = summarize(periods);
    return { config, summary, score: robustScore(summary) };
  }).sort((a, b) => b.score - a.score);
  const selected = ranked.find((row) => Number.isFinite(row.score)) || ranked[0];
  const evaluate = (rows, windows) => {
    const times = timesFor(rows);
    const periods = windows.map((window) => simulate(rows, times, selected.config, window.startTime, window.endTime));
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
