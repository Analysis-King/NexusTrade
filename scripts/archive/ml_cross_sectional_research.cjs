#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const COST_RATE = 0.0012;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1260,
    symbols: 50,
    interval: "4h",
    trainDays: 360,
    windowDays: 90,
    minSelectorWindows: 3,
    output: path.join("data", "ml_cross_sectional_research.json"),
    markdown: path.join("data", "ml_cross_sectional_research.md"),
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
    for (const row of raw) all.push({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) });
    const next = Number(raw.at(-1)[6]) + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(25);
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
    const window = values.slice(Math.max(0, index - period + 1), index + 1);
    const mean = avg(window);
    output.push(Math.sqrt(avg(window.map((value) => (value - mean) ** 2))));
  }
  return output;
}

function rsi(closes, period = 14) {
  const output = [];
  let gain = 0;
  let loss = 0;
  for (let index = 0; index < closes.length; index += 1) {
    const change = index ? closes[index] - closes[index - 1] : 0;
    gain = index ? (gain * (period - 1) + Math.max(0, change)) / period : 0;
    loss = index ? (loss * (period - 1) + Math.max(0, -change)) / period : 0;
    output.push(loss > 0 ? 100 - 100 / (1 + gain / loss) : (gain > 0 ? 100 : 50));
  }
  return output;
}

function prepareSeries(symbol, candles) {
  const closes = candles.map((row) => row.c);
  const logReturns = closes.map((close, index) => index ? Math.log(close / closes[index - 1]) : 0);
  const volumes = candles.map((row) => row.c * row.v);
  const volumeEma = ema(volumes, 24);
  return {
    symbol,
    candles,
    closes,
    maps: new Map(candles.map((row, index) => [row.t, index])),
    logReturns,
    vol6: rollingStd(logReturns, 6),
    vol24: rollingStd(logReturns, 24),
    vol72: rollingStd(logReturns, 72),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    volumeEma,
  };
}

function logReturn(series, index, lookback) {
  if (index < lookback || series.closes[index - lookback] <= 0) return 0;
  return Math.log(series.closes[index] / series.closes[index - lookback]);
}

function features(series, index) {
  if (index < 210) return null;
  const candle = series.candles[index];
  const close = series.closes[index];
  const volumeRatio = Math.log(Math.max(candle.c * candle.v, 1) / Math.max(series.volumeEma[index], 1));
  return [
    logReturn(series, index, 1),
    logReturn(series, index, 3),
    logReturn(series, index, 6),
    logReturn(series, index, 12),
    logReturn(series, index, 24),
    logReturn(series, index, 48),
    series.vol6[index],
    series.vol24[index],
    series.vol72[index],
    close / series.ema20[index] - 1,
    close / series.ema50[index] - 1,
    close / series.ema200[index] - 1,
    (series.rsi14[index] - 50) / 50,
    volumeRatio,
    (candle.h - candle.l) / close,
    (candle.c - candle.o) / candle.o,
  ];
}

function solveLinear(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column] || 1e-12;
    for (let item = column; item <= size; item += 1) augmented[column][item] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let item = column; item <= size; item += 1) augmented[row][item] -= factor * augmented[column][item];
    }
  }
  return augmented.map((row) => row[size]);
}

function trainRidge(dataset, startTime, endTime, horizonBars, alpha) {
  const samples = [];
  for (const series of dataset) {
    for (let index = 210; index < series.candles.length - horizonBars; index += 2) {
      const time = series.candles[index].t;
      const labelTime = series.candles[index + horizonBars].t;
      if (time < startTime || labelTime > endTime) continue;
      const x = features(series, index);
      const y = Math.log(series.closes[index + horizonBars] / series.closes[index]);
      if (x && Number.isFinite(y)) samples.push({ x, y });
    }
  }
  const featureCount = samples[0]?.x.length || 0;
  const means = Array(featureCount).fill(0);
  const deviations = Array(featureCount).fill(1);
  for (let column = 0; column < featureCount; column += 1) {
    const values = samples.map((row) => row.x[column]);
    means[column] = avg(values);
    deviations[column] = Math.max(stddev(values), 1e-9);
  }
  const size = featureCount + 1;
  const xtx = Array.from({ length: size }, () => Array(size).fill(0));
  const xty = Array(size).fill(0);
  for (const sample of samples) {
    const row = [1, ...sample.x.map((value, column) => (value - means[column]) / deviations[column])];
    for (let i = 0; i < size; i += 1) {
      xty[i] += row[i] * sample.y;
      for (let j = 0; j < size; j += 1) xtx[i][j] += row[i] * row[j];
    }
  }
  for (let index = 1; index < size; index += 1) xtx[index][index] += alpha * samples.length;
  return { coefficients: solveLinear(xtx, xty), means, deviations, samples: samples.length };
}

function predict(model, x) {
  let value = model.coefficients[0];
  for (let index = 0; index < x.length; index += 1) {
    value += model.coefficients[index + 1] * ((x[index] - model.means[index]) / model.deviations[index]);
  }
  return value;
}

function weightsFor(dataset, time, model, cfg) {
  const rows = [];
  for (const series of dataset) {
    const index = series.maps.get(time);
    if (!Number.isInteger(index)) continue;
    const x = features(series, index);
    if (!x) continue;
    rows.push({ symbol: series.symbol, prediction: predict(model, x), volatility: Math.max(series.vol24[index], 0.001) });
  }
  const longs = rows.filter((row) => row.prediction > 0).sort((a, b) => b.prediction - a.prediction).slice(0, cfg.count);
  const shorts = rows.filter((row) => row.prediction < 0).sort((a, b) => a.prediction - b.prediction).slice(0, cfg.count);
  const output = new Map();
  for (const [selected, side] of [[longs, 1], [shorts, -1]]) {
    const total = selected.reduce((sum, row) => sum + 1 / row.volatility, 0);
    for (const row of selected) output.set(row.symbol, side * cfg.leverage * 0.5 * ((1 / row.volatility) / total));
  }
  return output;
}

function simulate(dataset, times, model, cfg, startTime, endTime) {
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let weights = new Map();
  let previousTime = null;
  let bars = cfg.rebalanceBars;
  let turnover = 0;
  for (const time of times) {
    if (time < startTime || time > endTime) continue;
    if (previousTime != null) {
      let portfolioReturn = 0;
      for (const [symbol, weight] of weights) {
        const series = dataset.find((row) => row.symbol === symbol);
        const currentIndex = series?.maps.get(time);
        const previousIndex = series?.maps.get(previousTime);
        if (Number.isInteger(currentIndex) && Number.isInteger(previousIndex)) {
          portfolioReturn += weight * (series.closes[currentIndex] / series.closes[previousIndex] - 1);
        }
      }
      equity *= Math.max(0, 1 + portfolioReturn);
    }
    if (equity <= 0) break;
    bars += 1;
    if (bars >= cfg.rebalanceBars) {
      const next = weightsFor(dataset, time, model, cfg);
      const symbols = new Set([...weights.keys(), ...next.keys()]);
      const currentTurnover = [...symbols].reduce((sum, symbol) => sum + Math.abs((next.get(symbol) || 0) - (weights.get(symbol) || 0)), 0);
      equity *= Math.max(0, 1 - currentTurnover * COST_RATE);
      turnover += currentTurnover;
      weights = next;
      bars = 0;
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
    turnover: round(turnover, 2),
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
    windows.push({
      windowIndex,
      trainStart: endTime - (trainDays + windowDays) * DAY,
      trainEnd: endTime - windowDays * DAY,
      testStart: endTime - windowDays * DAY,
      testEnd: endTime,
    });
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

function buildConfigs() {
  const configs = [];
  for (const horizonBars of [3, 6, 12]) {
    for (const alpha of [0.01, 0.1, 1]) {
      for (const count of [3, 5, 8]) {
        for (const leverage of [1, 2, 3]) {
          configs.push({
            name: `h${horizonBars}-a${alpha}-n${count}-l${leverage}`,
            horizonBars,
            rebalanceBars: horizonBars,
            alpha,
            count,
            leverage,
          });
        }
      }
    }
  }
  return configs;
}

function toMarkdown(report) {
  const lines = [
    "# ML Cross-Sectional Nested Walk-Forward",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} current liquid Binance USDT pairs; interval: ${report.interval}`,
    `Each model trains on ${report.trainDays} older days and tests on an untouched ${report.windowDays}-day window.`,
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
    "| Window | Daily % | Return % | DD % | Selected Config | Older OOS Avg % |",
    "|---:|---:|---:|---:|---|---:|",
    ...report.nested.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.totalReturnPct} | ${row.maxDrawdownPct} | ${row.selectedConfig.name} | ${row.selectorTraining.avgDailyPct} |`),
    "",
    "## Best Fixed Models (diagnostic only)",
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
      if (candles.length >= 800) dataset.push(prepareSeries(symbol, candles));
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
    const modelCache = new Map();
    for (const config of configs) {
      const modelKey = `${config.horizonBars}:${config.alpha}`;
      if (!modelCache.has(modelKey)) {
        modelCache.set(modelKey, trainRidge(dataset, window.trainStart, window.trainEnd, config.horizonBars, config.alpha));
      }
      resultMap.get(config.name).windows.push({
        windowIndex: window.windowIndex,
        ...simulate(dataset, times, modelCache.get(modelKey), config, window.testStart, window.testEnd),
        trainingSamples: modelCache.get(modelKey).samples,
      });
    }
    console.error(`tested window ${window.windowIndex + 1}/${windows.length}`);
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
