#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const PERIODS_PER_YEAR = 4 * 365;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    candidates: 110,
    minCoveragePct: 70,
    holdoutMonths: 6,
    costBps: 7,
    output: path.join("data", "adaptive_trend_paper_research.json"),
    markdown: path.join("data", "adaptive_trend_paper_research.md"),
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const option = raw.slice(2);
    const separator = option.indexOf("=");
    const key = separator >= 0 ? option.slice(0, separator) : option;
    const value = separator >= 0 ? option.slice(separator + 1) : "true";
    if (!(key in args)) continue;
    args[key] = ["output", "markdown"].includes(key) ? value : Number(value);
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
    "SKHYNIX", "DRAM", "CRCL", "NBIS", "RKLB", "IBM", "META", "COIN",
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

async function fetchCandles(symbol, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    Object.entries({ symbol, interval: "6h", startTime: cursor, endTime, limit: 1500 }).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} ${response.status}: ${await response.text()}`);
    const rows = await response.json();
    if (!rows.length) break;
    for (const row of rows) {
      all.push({ t: Number(row[0]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), q: Number(row[7]) });
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

function prepare(symbol, candles) {
  const tr = candles.map((row, index) => index
    ? Math.max(row.h - row.l, Math.abs(row.h - candles[index - 1].c), Math.abs(row.l - candles[index - 1].c))
    : row.h - row.l);
  return {
    symbol,
    candles,
    atr: ema(tr, 14),
    maps: new Map(candles.map((row, index) => [row.t, index])),
  };
}

function simulateSleeve(series, cfg, direction, startTime, endTime) {
  const costRate = (cfg.costBps || 0) / 10000;
  const returns = new Map();
  let position = 0;
  let trailing = null;
  let previousClose = null;
  for (let index = 0; index < series.candles.length; index += 1) {
    const row = series.candles[index];
    if (row.t < startTime || row.t > endTime) continue;
    let periodReturn = previousClose ? position * (row.c / previousClose - 1) : 0;
    let nextPosition = position;
    if (!position && index >= cfg.lookback) {
      const momentum = row.c / series.candles[index - cfg.lookback].c - 1;
      if ((direction > 0 && momentum > cfg.threshold) || (direction < 0 && momentum < -cfg.threshold)) {
        nextPosition = direction;
        trailing = row.c - direction * cfg.atrMult * series.atr[index];
      }
    } else if (position > 0) {
      trailing = Math.max(trailing, row.c - cfg.atrMult * series.atr[index]);
      if (row.c < trailing) {
        nextPosition = 0;
        trailing = null;
      }
    } else if (position < 0) {
      trailing = Math.min(trailing, row.c + cfg.atrMult * series.atr[index]);
      if (row.c > trailing) {
        nextPosition = 0;
        trailing = null;
      }
    }
    periodReturn -= Math.abs(nextPosition - position) * costRate;
    returns.set(row.t, periodReturn);
    position = nextPosition;
    previousClose = row.c;
  }
  return returns;
}

function sleeveSummary(returns) {
  const values = [...returns.values()];
  const deviation = stddev(values);
  return {
    sharpe: deviation > 0 ? avg(values) / deviation * Math.sqrt(PERIODS_PER_YEAR) : -Infinity,
    totalReturn: values.reduce((growth, value) => growth * Math.max(0.01, 1 + value), 1) - 1,
  };
}

function buildSignalConfigs() {
  const configs = [];
  for (const lookback of [4, 8, 12, 20, 30]) {
    for (const threshold of [0.02, 0.04, 0.06, 0.1]) {
      for (const atrMult of [2, 2.5, 3, 3.5]) {
        configs.push({ lookback, threshold, atrMult });
      }
    }
  }
  return configs;
}

function optimizeSleeve(series, configs, direction, trainStart, trainEnd, testStart, testEnd, costBps) {
  let best = null;
  for (const cfg of configs) {
    const pricedCfg = { ...cfg, costBps };
    const training = simulateSleeve(series, pricedCfg, direction, trainStart, trainEnd);
    const summary = sleeveSummary(training);
    if (!best || summary.sharpe > best.training.sharpe) best = { cfg: pricedCfg, training: summary };
  }
  return {
    symbol: series.symbol,
    direction,
    config: best.cfg,
    training: best.training,
    testReturns: simulateSleeve(series, best.cfg, direction, testStart, testEnd),
  };
}

function buildMonths(dataset, configs, oldest, newest, costBps) {
  const months = [];
  let testStart = oldest + 30 * DAY;
  while (testStart + 30 * DAY <= newest) {
    const trainStart = testStart - 30 * DAY;
    const trainEnd = testStart - 1;
    const testEnd = testStart + 30 * DAY - 1;
    const sleeves = [];
    const volumes = [];
    for (const series of dataset) {
      const trainingRows = series.candles.filter((row) => row.t >= trainStart && row.t <= trainEnd);
      if (trainingRows.length < 80) continue;
      volumes.push({ symbol: series.symbol, volume: avg(trainingRows.map((row) => row.q)) });
      sleeves.push(optimizeSleeve(series, configs, 1, trainStart, trainEnd, testStart, testEnd, costBps));
      sleeves.push(optimizeSleeve(series, configs, -1, trainStart, trainEnd, testStart, testEnd, costBps));
    }
    months.push({ trainStart, testStart, testEnd, sleeves, volumes });
    testStart += 30 * DAY;
    console.error(`prepared month ${months.length}: ${new Date(testStart).toISOString().slice(0, 10)}`);
  }
  return months;
}

function evaluateMonths(months, cfg) {
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  const monthRows = [];
  for (const month of months) {
    const rankedVolume = [...month.volumes].sort((a, b) => b.volume - a.volume);
    const longUniverse = new Set(rankedVolume.slice(0, cfg.candidateCount).map((row) => row.symbol));
    const shortUniverse = new Set(rankedVolume.slice(-cfg.candidateCount).map((row) => row.symbol));
    const longs = month.sleeves.filter((row) => row.direction > 0 && longUniverse.has(row.symbol) && row.training.sharpe >= cfg.longSharpe);
    const shorts = month.sleeves.filter((row) => row.direction < 0 && shortUniverse.has(row.symbol) && row.training.sharpe >= cfg.shortSharpe);
    const times = [...new Set([...longs, ...shorts].flatMap((row) => [...row.testReturns.keys()]))].sort((a, b) => a - b);
    const monthStartEquity = equity;
    for (const time of times) {
      const longReturn = longs.length ? avg(longs.map((row) => row.testReturns.get(time) || 0)) : 0;
      const shortReturn = shorts.length ? avg(shorts.map((row) => row.testReturns.get(time) || 0)) : 0;
      const portfolioReturn = cfg.leverage * (cfg.longAllocation * longReturn + (1 - cfg.longAllocation) * shortReturn);
      equity *= Math.max(0, 1 + portfolioReturn);
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / Math.max(peak, 1e-12) * 100);
    }
    const growth = equity / monthStartEquity;
    monthRows.push({
      testStart: month.testStart,
      returnPct: round((growth - 1) * 100),
      dailyPct: growth > 0 ? round((Math.pow(growth, 1 / 30) - 1) * 100) : -100,
      longs: longs.length,
      shorts: shorts.length,
    });
  }
  const days = Math.max(1, months.length * 30);
  return {
    totalReturnPct: round((equity / 1000 - 1) * 100),
    dailyPct: equity > 0 ? round((Math.pow(equity / 1000, 1 / days) - 1) * 100) : -100,
    maxDrawdownPct: round(maxDrawdownPct),
    positiveMonthsPct: monthRows.length ? round(monthRows.filter((row) => row.returnPct > 0).length / monthRows.length * 100, 2) : null,
    worstMonthPct: monthRows.length ? round(Math.min(...monthRows.map((row) => row.returnPct))) : null,
    avgLongs: round(avg(monthRows.map((row) => row.longs)), 2),
    avgShorts: round(avg(monthRows.map((row) => row.shorts)), 2),
    months: monthRows,
  };
}

function buildPortfolioConfigs() {
  const configs = [];
  for (const longAllocation of [0.6, 0.7, 0.8]) {
    for (const longSharpe of [0.5, 1.3]) {
      for (const shortSharpe of [0.7, 1.7]) {
        for (const candidateCount of [10, 15]) {
          for (const leverage of [1, 2, 3, 4, 6, 8]) {
            configs.push({ name: `a${longAllocation}-ls${longSharpe}-ss${shortSharpe}-k${candidateCount}-l${leverage}`, longAllocation, longSharpe, shortSharpe, candidateCount, leverage });
          }
        }
      }
    }
  }
  return configs;
}

function trainingScore(result) {
  if (result.positiveMonthsPct < 55 || result.worstMonthPct < -60 || result.maxDrawdownPct > 75) return -Infinity;
  return result.dailyPct - result.maxDrawdownPct * 0.01 + result.positiveMonthsPct * 0.001;
}

function toMarkdown(report) {
  const older = report.older;
  const holdout = report.holdout;
  return [
    "# AdaptiveTrend Paper Replication",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} Binance perpetuals; H6; one-way cost: ${report.costBps} bps`,
    "",
    `Selected on older months only: **${report.selected.name}**`,
    "",
    "| Split | Months | Daily % | Total % | Positive Months % | Worst Month % | Max DD % | Avg Longs | Avg Shorts |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| Older tuning | ${older.months.length} | ${older.dailyPct} | ${older.totalReturnPct} | ${older.positiveMonthsPct} | ${older.worstMonthPct} | ${older.maxDrawdownPct} | ${older.avgLongs} | ${older.avgShorts} |`,
    `| Blind newest | ${holdout.months.length} | ${holdout.dailyPct} | ${holdout.totalReturnPct} | ${holdout.positiveMonthsPct} | ${holdout.worstMonthPct} | ${holdout.maxDrawdownPct} | ${holdout.avgLongs} | ${holdout.avgShorts} |`,
    "",
    `Strict target: **${report.accepted ? "PASS" : "FAIL"}**`,
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
      const candles = await fetchCandles(symbol, args.days);
      const coveragePct = candles.length ? (Date.now() - candles[0].t) / (args.days * DAY) * 100 : 0;
      if (candles.length >= 800 && coveragePct >= args.minCoveragePct) dataset.push(prepare(symbol, candles));
      console.error(`${coveragePct >= args.minCoveragePct ? "loaded" : "skip"} ${symbol}: bars=${candles.length}, coverage=${round(coveragePct, 1)}%`);
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  if (dataset.length < 12) throw new Error(`Only ${dataset.length} symbols passed coverage gate.`);
  const newest = Math.min(...dataset.map((row) => row.candles.at(-1).t));
  const oldest = Math.max(...dataset.map((row) => row.candles[0].t));
  const months = buildMonths(dataset, buildSignalConfigs(), oldest, newest, args.costBps);
  const splitIndex = Math.max(4, months.length - args.holdoutMonths);
  const olderMonths = months.slice(0, splitIndex);
  const holdoutMonths = months.slice(splitIndex);
  const ranked = buildPortfolioConfigs().map((config) => {
    const result = evaluateMonths(olderMonths, config);
    return { config, result, score: trainingScore(result) };
  }).sort((a, b) => b.score - a.score);
  const selected = ranked.find((row) => Number.isFinite(row.score)) || ranked[0];
  const older = selected.result;
  const holdout = evaluateMonths(holdoutMonths, selected.config);
  const report = {
    generatedAt: new Date().toISOString(),
    costBps: args.costBps,
    symbols: dataset.map((row) => row.symbol),
    selected: selected.config,
    older,
    holdout,
    accepted: holdout.dailyPct >= 0.8 && holdout.positiveMonthsPct >= 75 && holdout.maxDrawdownPct < 70,
    topTraining: ranked.slice(0, 30),
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table([{ split: "older", ...older, months: older.months.length }, { split: "holdout", ...holdout, months: holdout.months.length }].map((row) => ({
    split: row.split,
    months: row.months,
    dailyPct: row.dailyPct,
    totalReturnPct: row.totalReturnPct,
    positiveMonthsPct: row.positiveMonthsPct,
    worstMonthPct: row.worstMonthPct,
    maxDrawdownPct: row.maxDrawdownPct,
  })));
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
