#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    candidates: 120,
    interval: "6h",
    windowDays: 90,
    minTrainWindows: 4,
    minCoveragePct: 70,
    costBps: 7,
    output: path.join("data", "slow_trend_follow_research.json"),
    markdown: path.join("data", "slow_trend_follow_research.md"),
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
    "SKHYNIX", "DRAM", "CRCL", "NBIS", "RKLB", "IBM", "META", "COIN",
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
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit: 1500 }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} ${interval} futures ${response.status}: ${await response.text()}`);
    const rows = await response.json();
    if (!rows.length) break;
    for (const row of rows) {
      all.push({ t: Number(row[0]), c: Number(row[4]), q: Number(row[7]) });
    }
    const next = Number(rows.at(-1)[6]) + 1;
    if (next <= cursor || rows.length < 1500) break;
    cursor = next;
    await sleep(25);
  }
  return [...new Map(all.map((row) => [row.t, row])).values()].sort((a, b) => a.t - b.t);
}

function sma(values, period) {
  const output = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    output.push(index >= period - 1 ? sum / period : null);
  }
  return output;
}

function ema(values, period) {
  const output = [];
  const alpha = 2 / (period + 1);
  for (const value of values) output.push(output.length ? value * alpha + output.at(-1) * (1 - alpha) : value);
  return output;
}

function dema(values, period) {
  const first = ema(values, period);
  const second = ema(first, period);
  return first.map((value, index) => 2 * value - second[index]);
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

function prepareSeries(symbol, candles) {
  const closes = candles.map((row) => row.c);
  const returns = closes.map((close, index) => index ? close / closes[index - 1] - 1 : 0);
  const quoteVolumes = candles.map((row) => row.q);
  return {
    symbol,
    candles,
    closes,
    returns,
    volatility: rollingStd(returns, 28),
    liquidity: ema(quoteVolumes, 28),
    maps: new Map(candles.map((row, index) => [row.t, index])),
    maCache: new Map(),
  };
}

function barsForDays(days, barMs) {
  return Math.max(2, Math.round(days * DAY / barMs));
}

function ma(series, type, period) {
  const key = `${type}:${period}`;
  if (!series.maCache.has(key)) {
    const values = type === "sma" ? sma(series.closes, period) : type === "ema" ? ema(series.closes, period) : dema(series.closes, period);
    series.maCache.set(key, values);
  }
  return series.maCache.get(key);
}

function buildConfigs() {
  const configs = [];
  for (const maType of ["sma", "ema", "dema"]) {
    for (const shortDays of [5, 8, 10, 12, 15, 20]) {
      for (const longDays of [30, 40, 60, 90, 120]) {
        if (longDays <= shortDays) continue;
        for (const rebalanceBars of [1, 4, 8]) {
          for (const leverage of [0.75, 1, 1.5, 2]) {
            for (const mode of ["all", "balanced", "longBias"]) {
              configs.push({
                name: `${maType}-${shortDays}d-${longDays}d-r${rebalanceBars}-l${leverage}-${mode}`,
                maType,
                shortDays,
                longDays,
                rebalanceBars,
                leverage,
                mode,
              });
            }
          }
        }
      }
    }
  }
  return configs;
}

function normalize(rows, budget) {
  if (!rows.length || budget <= 0) return [];
  const total = rows.reduce((sum, row) => sum + 1 / Math.max(row.volatility, 0.0001), 0);
  return rows.map((row) => ({
    symbol: row.symbol,
    weight: budget * ((1 / Math.max(row.volatility, 0.0001)) / total) * row.side,
  }));
}

function desiredWeights(dataset, time, cfg, barMs) {
  const shortBars = barsForDays(cfg.shortDays, barMs);
  const longBars = barsForDays(cfg.longDays, barMs);
  const rows = [];
  let btcBull = true;
  for (const series of dataset) {
    const index = series.maps.get(time);
    if (!Number.isInteger(index) || index < longBars + 2) continue;
    const fast = ma(series, cfg.maType, shortBars)[index];
    const slow = ma(series, cfg.maType, longBars)[index];
    if (!Number.isFinite(fast) || !Number.isFinite(slow) || slow <= 0) continue;
    const side = fast > slow ? 1 : -1;
    if (series.symbol === "BTCUSDT") btcBull = side > 0;
    rows.push({ symbol: series.symbol, side, volatility: series.volatility[index], strength: Math.abs(fast / slow - 1) });
  }
  const liquid = rows.sort((a, b) => b.strength - a.strength).slice(0, 35);
  const longs = liquid.filter((row) => row.side > 0);
  const shorts = liquid.filter((row) => row.side < 0);
  if (cfg.mode === "balanced") {
    return new Map([
      ...normalize(longs, cfg.leverage * 0.5),
      ...normalize(shorts, cfg.leverage * 0.5),
    ].map((row) => [row.symbol, row.weight]));
  }
  if (cfg.mode === "longBias") {
    const longBudget = cfg.leverage * (btcBull ? 0.7 : 0.35);
    const shortBudget = cfg.leverage - longBudget;
    return new Map([
      ...normalize(longs, longBudget),
      ...normalize(shorts, shortBudget),
    ].map((row) => [row.symbol, row.weight]));
  }
  return new Map(normalize(liquid, cfg.leverage).map((row) => [row.symbol, row.weight]));
}

function simulate(dataset, times, cfg, startTime, endTime, costRate, barMs) {
  const seriesMap = new Map(dataset.map((row) => [row.symbol, row]));
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let weights = new Map();
  let previousTime = null;
  let barsSinceRebalance = cfg.rebalanceBars;
  let turnover = 0;
  let activeBars = 0;
  for (const time of times) {
    if (time < startTime || time > endTime) continue;
    if (previousTime != null) {
      let portfolioReturn = 0;
      for (const [symbol, weight] of weights) {
        const series = seriesMap.get(symbol);
        const current = series?.maps.get(time);
        const previous = series?.maps.get(previousTime);
        if (!Number.isInteger(current) || !Number.isInteger(previous)) continue;
        portfolioReturn += weight * (series.closes[current] / series.closes[previous] - 1);
      }
      equity *= Math.max(0, 1 + portfolioReturn);
      if (weights.size) activeBars += 1;
    }
    if (equity <= 0) break;
    barsSinceRebalance += 1;
    if (barsSinceRebalance >= cfg.rebalanceBars) {
      const next = desiredWeights(dataset, time, cfg, barMs);
      const symbols = new Set([...weights.keys(), ...next.keys()]);
      const currentTurnover = [...symbols].reduce(
        (sum, symbol) => sum + Math.abs((next.get(symbol) || 0) - (weights.get(symbol) || 0)),
        0,
      );
      equity *= Math.max(0, 1 - currentTurnover * costRate);
      turnover += currentTurnover;
      weights = next;
      barsSinceRebalance = 0;
    }
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
    previousTime = time;
  }
  const days = Math.max(1, (endTime - startTime) / DAY);
  return {
    totalReturnPct: round((equity / 1000 - 1) * 100),
    dailyPct: equity > 0 ? round((Math.pow(equity / 1000, 1 / days) - 1) * 100) : -100,
    maxDrawdownPct: round(maxDrawdownPct),
    turnover: round(turnover, 2),
    activeBars,
  };
}

function summarize(rows) {
  const values = rows.map((row) => row.dailyPct).filter(Number.isFinite);
  const mean = avg(values);
  const deviation = stddev(values);
  const worst = values.length ? Math.min(...values) : null;
  return {
    periods: values.length,
    positivePeriods: values.filter((value) => value > 0).length,
    positivePct: values.length ? round(values.filter((value) => value > 0).length / values.length * 100, 2) : null,
    avgDailyPct: round(mean),
    medianDailyPct: round(median(values)),
    worstDailyPct: round(worst),
    bestDailyPct: values.length ? round(Math.max(...values)) : null,
    avgMaxDrawdownPct: round(avg(rows.map((row) => row.maxDrawdownPct))),
    worstMaxDrawdownPct: rows.length ? round(Math.max(...rows.map((row) => row.maxDrawdownPct))) : null,
    lowerConfidenceDailyPct: values.length
      ? round(mean - 0.75 * deviation / Math.sqrt(values.length) + Math.min(0, worst) * 0.25)
      : null,
  };
}

function buildWindows(times, windowDays) {
  const windows = [];
  const oldest = times[0];
  let endTime = times.at(-1);
  let windowIndex = 0;
  while (endTime - windowDays * DAY >= oldest) {
    windows.push({ windowIndex, startTime: endTime - windowDays * DAY, endTime });
    endTime -= windowDays * DAY;
    windowIndex += 1;
  }
  return windows;
}

function nestedWalkForward(configResults, minTrainWindows) {
  const periods = [];
  const maxIndex = Math.max(...configResults.flatMap((item) => item.windows.map((row) => row.windowIndex)));
  for (let windowIndex = maxIndex - minTrainWindows; windowIndex >= 0; windowIndex -= 1) {
    const ranked = configResults.map((item) => {
      const training = item.windows.filter((row) => row.windowIndex > windowIndex);
      return { item, training: summarize(training) };
    }).filter((row) => row.training.periods >= minTrainWindows && row.training.worstDailyPct > -0.8)
      .sort((a, b) => (b.training.lowerConfidenceDailyPct ?? -Infinity) - (a.training.lowerConfidenceDailyPct ?? -Infinity));
    const chosen = ranked[0];
    const current = chosen?.item.windows.find((row) => row.windowIndex === windowIndex);
    if (chosen && current) periods.push({ ...current, selectedConfig: chosen.item.config, training: chosen.training });
  }
  return { summary: summarize(periods), periods };
}

function toMarkdown(report) {
  const lines = [
    "# Slow Trend Following Walk-Forward",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} Binance USD-M perpetuals`,
    `Interval: ${report.interval}; window: ${report.windowDays} days; one-way cost: ${report.costBps} bps`,
    "",
    "## Nested Walk-Forward",
    "",
    "| Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % | Worst DD % | Lower Confidence % |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.nested.summary.periods} | ${report.nested.summary.positivePeriods}/${report.nested.summary.periods} | ${report.nested.summary.avgDailyPct} | ${report.nested.summary.medianDailyPct} | ${report.nested.summary.worstDailyPct} | ${report.nested.summary.bestDailyPct} | ${report.nested.summary.avgMaxDrawdownPct} | ${report.nested.summary.worstMaxDrawdownPct} | ${report.nested.summary.lowerConfidenceDailyPct} |`,
    "",
    "## Blind Periods",
    "",
    "| Window | Daily % | Return % | DD % | Selected Config | Training Avg % |",
    "|---:|---:|---:|---:|---|---:|",
    ...report.nested.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.totalReturnPct} | ${row.maxDrawdownPct} | ${row.selectedConfig.name} | ${row.training.avgDailyPct} |`),
    "",
    "## Best Fixed Configurations",
    "",
    "| Config | Avg Daily % | Median % | Positive % | Worst % | Avg DD % | Worst DD % |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.fixed.slice(0, 20).map((row) => `| ${row.config.name} | ${row.summary.avgDailyPct} | ${row.summary.medianDailyPct} | ${row.summary.positivePct} | ${row.summary.worstDailyPct} | ${row.summary.avgMaxDrawdownPct} | ${row.summary.worstMaxDrawdownPct} |`),
    "",
  ];
  return lines.join("\n");
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
      if (candles.length >= 600 && coveragePct >= args.minCoveragePct) dataset.push(prepareSeries(symbol, candles));
      console.error(`${coveragePct >= args.minCoveragePct ? "loaded" : "skip coverage"} ${symbol}: ${candles.length}, coverage=${round(coveragePct, 1)}%`);
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  if (dataset.length < 10) throw new Error(`Only ${dataset.length} symbols loaded.`);
  const times = [...new Set(dataset.flatMap((series) => series.candles.map((row) => row.t)))].sort((a, b) => a - b);
  const barMs = times[1] - times[0];
  const windows = buildWindows(times, args.windowDays);
  const configs = buildConfigs();
  const costRate = args.costBps / 10000;
  const configResults = configs.map((config, index) => {
    const results = windows.map((window) => ({
      windowIndex: window.windowIndex,
      ...simulate(dataset, times, config, window.startTime, window.endTime, costRate, barMs),
    }));
    if ((index + 1) % 100 === 0 || index + 1 === configs.length) console.error(`tested ${index + 1}/${configs.length}`);
    return { config, windows: results };
  });
  const nested = nestedWalkForward(configResults, args.minTrainWindows);
  const fixed = configResults.map((item) => ({ config: item.config, summary: summarize(item.windows) }))
    .sort((a, b) => (b.summary.lowerConfidenceDailyPct ?? -Infinity) - (a.summary.lowerConfidenceDailyPct ?? -Infinity));
  const report = {
    generatedAt: new Date().toISOString(),
    interval: args.interval,
    windowDays: args.windowDays,
    costBps: args.costBps,
    symbols: dataset.map((row) => row.symbol),
    configurations: configs.length,
    nested,
    fixed,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table([nested.summary]);
  console.table(fixed.slice(0, 10).map((row) => ({
    config: row.config.name,
    avg: row.summary.avgDailyPct,
    median: row.summary.medianDailyPct,
    worst: row.summary.worstDailyPct,
    dd: row.summary.avgMaxDrawdownPct,
  })));
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
