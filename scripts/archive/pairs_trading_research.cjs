#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const COST_RATE = 0.0012;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1260,
    symbols: 40,
    interval: "4h",
    trainDays: 360,
    windowDays: 90,
    minSelectorWindows: 3,
    output: path.join("data", "pairs_trading_research.json"),
    markdown: path.join("data", "pairs_trading_research.md"),
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

function covariance(a, b) {
  const meanA = avg(a);
  const meanB = avg(b);
  return avg(a.map((value, index) => (value - meanA) * (b[index] - meanB)));
}

async function fetchTopUsdtSymbols(limit) {
  const stableOrFiat = new Set([
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDE", "USD1",
    "RLUSD", "XUSD", "EUR", "TRY", "BRL", "ARS", "AEUR", "PAXG", "XAUT",
  ]);
  const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  if (!response.ok) throw new Error(`Binance ticker ${response.status}: ${await response.text()}`);
  const rows = await response.json();
  return rows.filter((item) => {
    const symbol = String(item.symbol || "");
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
    const base = symbol.slice(0, -4);
    return !stableOrFiat.has(base) && !/(UP|DOWN|BULL|BEAR)$/.test(base) && Number(item.quoteVolume || 0) > 0;
  }).sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((item) => item.symbol);
}

async function fetchCandles(symbol, interval, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit: 1000 }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} Binance ${response.status}: ${await response.text()}`);
    const raw = await response.json();
    if (!raw.length) break;
    for (const row of raw) all.push({ t: Number(row[0]), c: Number(row[4]) });
    const next = Number(raw.at(-1)[6]) + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(25);
  }
  return [...new Map(all.map((row) => [row.t, row])).values()].sort((a, b) => a.t - b.t);
}

function prepareSeries(symbol, candles) {
  return {
    symbol,
    candles,
    maps: new Map(candles.map((row, index) => [row.t, index])),
    logPrices: candles.map((row) => Math.log(row.c)),
  };
}

function commonRows(first, second, startTime, endTime) {
  const rows = [];
  for (const candle of first.candles) {
    if (candle.t < startTime || candle.t > endTime) continue;
    const secondIndex = second.maps.get(candle.t);
    const firstIndex = first.maps.get(candle.t);
    if (Number.isInteger(secondIndex)) rows.push({ t: candle.t, a: first.logPrices[firstIndex], b: second.logPrices[secondIndex] });
  }
  return rows;
}

function trainPairs(dataset, startTime, endTime) {
  const pairs = [];
  for (let first = 0; first < dataset.length; first += 1) {
    for (let second = first + 1; second < dataset.length; second += 1) {
      const rows = commonRows(dataset[first], dataset[second], startTime, endTime);
      if (rows.length < 1000) continue;
      const a = rows.map((row) => row.a);
      const b = rows.map((row) => row.b);
      const varianceB = covariance(b, b);
      if (!(varianceB > 0)) continue;
      const beta = covariance(a, b) / varianceB;
      if (!(beta > 0.2 && beta < 5)) continue;
      const intercept = avg(a) - beta * avg(b);
      const residuals = rows.map((row) => row.a - intercept - beta * row.b);
      const residualStd = stddev(residuals);
      const correlation = covariance(a, b) / Math.max(stddev(a) * stddev(b), 1e-12);
      const previous = residuals.slice(0, -1);
      const current = residuals.slice(1);
      const ar1 = covariance(previous, current) / Math.max(covariance(previous, previous), 1e-12);
      if (!(correlation > 0.75 && ar1 > 0.2 && ar1 < 0.995 && residualStd > 0)) continue;
      const halfLife = -Math.log(2) / Math.log(ar1);
      if (!(halfLife > 0 && halfLife < 120)) continue;
      let crossings = 0;
      const mean = avg(residuals);
      for (let index = 1; index < residuals.length; index += 1) {
        if ((residuals[index - 1] - mean) * (residuals[index] - mean) < 0) crossings += 1;
      }
      if (crossings < 12) continue;
      pairs.push({
        first: dataset[first].symbol,
        second: dataset[second].symbol,
        beta,
        intercept,
        correlation,
        ar1,
        halfLife,
        crossings,
        score: crossings / Math.sqrt(halfLife),
      });
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}

function selectDisjointPairs(ranked, count) {
  const selected = [];
  const used = new Set();
  for (const pair of ranked) {
    if (used.has(pair.first) || used.has(pair.second)) continue;
    selected.push(pair);
    used.add(pair.first);
    used.add(pair.second);
    if (selected.length >= count) break;
  }
  return selected;
}

function zScore(pair, first, second, time, rollingBars) {
  const firstIndex = first.maps.get(time);
  const secondIndex = second.maps.get(time);
  if (!Number.isInteger(firstIndex) || !Number.isInteger(secondIndex)) return null;
  const values = [];
  for (let offset = rollingBars - 1; offset >= 0; offset -= 1) {
    const aIndex = firstIndex - offset;
    const bIndex = secondIndex - offset;
    if (aIndex < 0 || bIndex < 0 || first.candles[aIndex].t !== second.candles[bIndex].t) continue;
    values.push(first.logPrices[aIndex] - pair.intercept - pair.beta * second.logPrices[bIndex]);
  }
  if (values.length < rollingBars * 0.8) return null;
  const deviation = stddev(values);
  return deviation > 0 ? (values.at(-1) - avg(values)) / deviation : null;
}

function buildConfigs() {
  const configs = [];
  for (const pairCount of [2, 4, 6]) {
    for (const entryZ of [1, 1.5, 2]) {
      for (const exitZ of [0, 0.5]) {
        for (const stopZ of [3, 4]) {
          for (const rollingBars of [60, 120]) {
            for (const leverage of [1, 2, 3]) {
              configs.push({ name: `p${pairCount}-e${entryZ}-x${exitZ}-s${stopZ}-r${rollingBars}-l${leverage}`, pairCount, entryZ, exitZ, stopZ, rollingBars, leverage });
            }
          }
        }
      }
    }
  }
  return configs;
}

function simulate(dataset, times, rankedPairs, cfg, startTime, endTime) {
  const selected = selectDisjointPairs(rankedPairs, cfg.pairCount);
  const seriesMap = new Map(dataset.map((row) => [row.symbol, row]));
  const states = new Map(selected.map((pair) => [`${pair.first}:${pair.second}`, 0]));
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let previousTime = null;
  let trades = 0;
  for (const time of times) {
    if (time < startTime || time > endTime) continue;
    let portfolioReturn = 0;
    if (previousTime != null) {
      for (const pair of selected) {
        const key = `${pair.first}:${pair.second}`;
        const side = states.get(key);
        if (!side) continue;
        const first = seriesMap.get(pair.first);
        const second = seriesMap.get(pair.second);
        const firstNow = first.maps.get(time);
        const firstPrev = first.maps.get(previousTime);
        const secondNow = second.maps.get(time);
        const secondPrev = second.maps.get(previousTime);
        if (![firstNow, firstPrev, secondNow, secondPrev].every(Number.isInteger)) continue;
        const denominator = 1 + Math.abs(pair.beta);
        const pairReturn = side * (
          (first.logPrices[firstNow] - first.logPrices[firstPrev]) / denominator
          - pair.beta * (second.logPrices[secondNow] - second.logPrices[secondPrev]) / denominator
        );
        portfolioReturn += pairReturn * cfg.leverage / Math.max(1, selected.length);
      }
      equity *= Math.max(0, 1 + portfolioReturn);
    }
    if (equity <= 0) break;

    for (const pair of selected) {
      const key = `${pair.first}:${pair.second}`;
      const first = seriesMap.get(pair.first);
      const second = seriesMap.get(pair.second);
      const z = zScore(pair, first, second, time, cfg.rollingBars);
      if (!Number.isFinite(z)) continue;
      const state = states.get(key);
      if (state && (Math.abs(z) <= cfg.exitZ || Math.abs(z) >= cfg.stopZ)) {
        equity *= Math.max(0, 1 - COST_RATE * cfg.leverage / Math.max(1, selected.length));
        states.set(key, 0);
      } else if (!state && Math.abs(z) >= cfg.entryZ && Math.abs(z) < cfg.stopZ) {
        equity *= Math.max(0, 1 - COST_RATE * cfg.leverage / Math.max(1, selected.length));
        states.set(key, z > 0 ? -1 : 1);
        trades += 1;
      }
    }
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
    previousTime = time;
  }
  const days = Math.max(1, (endTime - startTime) / DAY);
  const totalReturnPct = (equity / 1000 - 1) * 100;
  return {
    totalReturnPct: round(totalReturnPct),
    dailyPct: equity > 0 ? round((Math.pow(equity / 1000, 1 / days) - 1) * 100) : -100,
    maxDrawdownPct: round(maxDrawdownPct),
    trades,
    pairs: selected.map((pair) => `${pair.first}/${pair.second}`),
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

function buildWindows(newest, oldest, trainDays, windowDays) {
  const windows = [];
  let endTime = newest;
  let windowIndex = 0;
  while (endTime - (trainDays + windowDays) * DAY >= oldest) {
    windows.push({ windowIndex, trainStart: endTime - (trainDays + windowDays) * DAY, trainEnd: endTime - windowDays * DAY, testStart: endTime - windowDays * DAY, testEnd: endTime });
    endTime -= windowDays * DAY;
    windowIndex += 1;
  }
  return windows;
}

function nestedSelector(configResults, minWindows) {
  const periods = [];
  const maxIndex = Math.max(...configResults.flatMap((item) => item.windows.map((row) => row.windowIndex)));
  for (let windowIndex = maxIndex - minWindows; windowIndex >= 0; windowIndex -= 1) {
    const ranked = configResults.map((item) => {
      const training = item.windows.filter((row) => row.windowIndex > windowIndex);
      return { item, training: summarize(training) };
    }).filter((row) => row.training.periods >= minWindows)
      .sort((a, b) => (b.training.lowerConfidenceDailyPct ?? -Infinity) - (a.training.lowerConfidenceDailyPct ?? -Infinity));
    const chosen = ranked[0];
    const current = chosen?.item.windows.find((row) => row.windowIndex === windowIndex);
    if (chosen && current) periods.push({ ...current, selectedConfig: chosen.item.config, selectorTraining: chosen.training });
  }
  return { summary: summarize(periods), periods };
}

function toMarkdown(report) {
  const lines = [
    "# Pairs Trading Nested Walk-Forward",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} current liquid Binance USDT pairs; interval: ${report.interval}`,
    `Each pair set trains on ${report.trainDays} older days and tests on an untouched ${report.windowDays}-day window.`,
    `Costs: 10 bps fee + 2 bps slippage per one-way turnover; configurations: ${report.configurations}`,
    "",
    "## Nested Selector",
    "",
    "| Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % | Worst DD % | Lower Confidence % |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.nested.summary.periods} | ${report.nested.summary.positivePeriods}/${report.nested.summary.periods} | ${report.nested.summary.avgDailyPct} | ${report.nested.summary.medianDailyPct} | ${report.nested.summary.worstDailyPct} | ${report.nested.summary.bestDailyPct} | ${report.nested.summary.avgMaxDrawdownPct} | ${report.nested.summary.worstMaxDrawdownPct} | ${report.nested.summary.lowerConfidenceDailyPct} |`,
    "",
    "## Blind Periods",
    "",
    "| Window | Daily % | Return % | DD % | Trades | Selected Config | Pairs |",
    "|---:|---:|---:|---:|---:|---|---|",
    ...report.nested.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.totalReturnPct} | ${row.maxDrawdownPct} | ${row.trades} | ${row.selectedConfig.name} | ${row.pairs.join(", ")} |`),
    "",
    "## Best Fixed Configurations (diagnostic only)",
    "",
    "| Config | Avg Daily % | Median % | Positive % | Worst % | Avg DD % |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.fixed.slice(0, 20).map((row) => `| ${row.config.name} | ${row.summary.avgDailyPct} | ${row.summary.medianDailyPct} | ${row.summary.positivePct} | ${row.summary.worstDailyPct} | ${row.summary.avgMaxDrawdownPct} |`),
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = await fetchTopUsdtSymbols(args.symbols);
  const dataset = [];
  for (const symbol of symbols) {
    try {
      const candles = await fetchCandles(symbol, args.interval, args.days);
      if (candles.length >= 1000) dataset.push(prepareSeries(symbol, candles));
      console.error(`loaded ${symbol}: ${candles.length}`);
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  const times = [...new Set(dataset.flatMap((series) => series.candles.map((row) => row.t)))].sort((a, b) => a - b);
  const windows = buildWindows(times.at(-1), times[0], args.trainDays, args.windowDays);
  const configs = buildConfigs();
  const resultMap = new Map(configs.map((config) => [config.name, { config, windows: [] }]));
  for (const window of windows) {
    const pairs = trainPairs(dataset, window.trainStart, window.trainEnd);
    for (const config of configs) {
      resultMap.get(config.name).windows.push({ windowIndex: window.windowIndex, ...simulate(dataset, times, pairs, config, window.testStart, window.testEnd) });
    }
    console.error(`tested window ${window.windowIndex + 1}/${windows.length}, eligible pairs=${pairs.length}`);
  }
  const configResults = [...resultMap.values()];
  const nested = nestedSelector(configResults, args.minSelectorWindows);
  const fixed = configResults.map((item) => ({ config: item.config, summary: summarize(item.windows) }))
    .sort((a, b) => (b.summary.lowerConfidenceDailyPct ?? -Infinity) - (a.summary.lowerConfidenceDailyPct ?? -Infinity));
  const report = {
    generatedAt: new Date().toISOString(),
    interval: args.interval,
    days: args.days,
    trainDays: args.trainDays,
    windowDays: args.windowDays,
    symbols: dataset.map((row) => row.symbol),
    configurations: configs.length,
    nested,
    fixed,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table([nested.summary]);
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
