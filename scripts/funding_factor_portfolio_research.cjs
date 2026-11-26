#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const COST_RATE = 0.0012;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    candidates: 100,
    windowDays: 45,
    minSelectorWindows: 3,
    holdoutWindows: 4,
    holdoutSymbolPct: 40,
    minCoveragePct: 70,
    output: path.join("data", "funding_carry_research.json"),
    markdown: path.join("data", "funding_carry_research.md"),
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
  if (!Number.isFinite(mean)) return null;
  return Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
}

function rollingStd(values, period) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    output.push(stddev(values.slice(Math.max(0, index - period + 1), index + 1)) || 0);
  }
  return output;
}

async function fetchTopFuturesSymbols(limit) {
  const response = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  if (!response.ok) throw new Error(`Binance futures ticker ${response.status}: ${await response.text()}`);
  const rows = await response.json();
  return rows.filter((row) => /^[A-Z0-9]+USDT$/.test(String(row.symbol || "")) && Number(row.quoteVolume || 0) > 0)
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((row) => row.symbol);
}

async function fetchFunding(symbol, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
    Object.entries({ symbol, startTime: cursor, endTime, limit: 1000 }).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} funding ${response.status}: ${await response.text()}`);
    const rows = await response.json();
    if (!rows.length) break;
    for (const row of rows) all.push({ t: Number(row.fundingTime), rate: Number(row.fundingRate) });
    const next = Number(rows.at(-1).fundingTime) + 1;
    if (next <= cursor || rows.length < 1000) break;
    cursor = next;
    await sleep(20);
  }
  return [...new Map(all.map((row) => [row.t, row])).values()].sort((a, b) => a.t - b.t);
}

async function fetchKlines(symbol, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    Object.entries({ symbol, interval: "8h", startTime: cursor, endTime, limit: 1500 }).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} klines ${response.status}: ${await response.text()}`);
    const rows = await response.json();
    if (!rows.length) break;
    for (const row of rows) all.push({ t: Number(row[0]), c: Number(row[4]) });
    const next = Number(rows.at(-1)[6]) + 1;
    if (next <= cursor || rows.length < 1500) break;
    cursor = next;
    await sleep(20);
  }
  return [...new Map(all.map((row) => [row.t, row])).values()].sort((a, b) => a.t - b.t);
}

function prepare(symbol, funding, klines) {
  const fundingMap = new Map(funding.map((row) => [Math.floor(row.t / (8 * 3_600_000)), row.rate]));
  const closes = klines.map((row) => row.c);
  const logReturns = closes.map((close, index) => index ? Math.log(close / closes[index - 1]) : 0);
  return {
    symbol,
    klines,
    maps: new Map(klines.map((row, index) => [row.t, index])),
    rates: klines.map((row) => fundingMap.get(Math.floor((row.t + 8 * 3_600_000) / (8 * 3_600_000))) || 0),
    volatility: rollingStd(logReturns, 21),
  };
}

function buildConfigs() {
  const configs = [];
  for (const lookback of [1, 3, 6]) {
    for (const priceLookback of [6, 12, 24]) {
      for (const fundingWeight of [-1, 0, 0.5, 1]) {
        for (const count of [4, 6]) {
          for (const rebalancePeriods of [3, 6, 12]) {
            for (const targetDailyVolPct of [2, 4, 6]) {
              for (const maxGross of [4, 8, 12]) {
              configs.push({
                  name: `factor-f${lookback}-p${priceLookback}-w${fundingWeight}-n${count}-r${rebalancePeriods}-v${targetDailyVolPct}-g${maxGross}`,
                lookback,
                priceLookback,
                  fundingWeight,
                count,
                rebalancePeriods,
                  targetDailyVolPct,
                  maxGross,
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
  const holdoutCount = Math.max(4, Math.min(ordered.length - 4, Math.round(ordered.length * holdoutPct / 100)));
  return {
    tuning: ordered.slice(holdoutCount),
    symbolHoldout: ordered.slice(0, holdoutCount),
  };
}

function commonTimes(dataset) {
  return [...new Set(dataset.flatMap((series) => series.klines.map((row) => row.t)))].sort((a, b) => a - b);
}

function robustScore(summary) {
  if (!summary || summary.periods < 3 || summary.positivePct < 65 || summary.worstDailyPct < -0.5) return -Infinity;
  if (summary.avgMaxDrawdownPct > 35 || summary.worstMaxDrawdownPct > 60) return -Infinity;
  return (summary.lowerConfidenceDailyPct ?? -Infinity)
    - summary.avgMaxDrawdownPct * 0.02
    + Math.min(0, summary.worstDailyPct) * 0.5;
}

function evaluateConfig(dataset, config, windows) {
  const times = commonTimes(dataset);
  return windows.map((window) => ({
    windowIndex: window.windowIndex,
    startTime: window.startTime,
    endTime: window.endTime,
    ...simulate(dataset, times, config, window.startTime, window.endTime),
  }));
}

function strictValidation(dataset, configs, windows, holdoutWindows, holdoutSymbolPct) {
  const split = splitDataset(dataset, holdoutSymbolPct);
  const newestHoldout = windows.filter((window) => window.windowIndex < holdoutWindows);
  const olderTraining = windows.filter((window) => window.windowIndex >= holdoutWindows);
  const ranked = configs.map((config) => {
    const tuningOlder = evaluateConfig(split.tuning, config, olderTraining);
    const summary = summarize(tuningOlder);
    return { config, summary, score: robustScore(summary) };
  }).sort((a, b) => b.score - a.score);
  const selected = ranked[0];
  if (!selected || !Number.isFinite(selected.score)) {
    return {
      selected: null,
      tuningSymbols: split.tuning.map((row) => row.symbol),
      holdoutSymbols: split.symbolHoldout.map((row) => row.symbol),
      reason: "Risk ve dayaniklilik kosullarini gecen ayar bulunamadi.",
    };
  }
  const sections = {
    tuningOlder: evaluateConfig(split.tuning, selected.config, olderTraining),
    tuningNewestHoldout: evaluateConfig(split.tuning, selected.config, newestHoldout),
    symbolHoldoutOlder: evaluateConfig(split.symbolHoldout, selected.config, olderTraining),
    strictJointHoldout: evaluateConfig(split.symbolHoldout, selected.config, newestHoldout),
  };
  return {
    selected,
    tuningSymbols: split.tuning.map((row) => row.symbol),
    holdoutSymbols: split.symbolHoldout.map((row) => row.symbol),
    sections: Object.fromEntries(Object.entries(sections).map(([key, rows]) => [key, { summary: summarize(rows), periods: rows }])),
    accepted: sections.strictJointHoldout.length >= 3
      && summarize(sections.strictJointHoldout).avgDailyPct >= 0.8
      && summarize(sections.strictJointHoldout).positivePct >= 75
      && summarize(sections.strictJointHoldout).worstDailyPct > -0.5,
  };
}

function desiredWeights(dataset, time, cfg) {
  const rows = [];
  for (const series of dataset) {
    const index = series.maps.get(time);
    if (!Number.isInteger(index) || index < Math.max(cfg.lookback, cfg.priceLookback || 1)) continue;
    const funding = avg(series.rates.slice(index - cfg.lookback + 1, index + 1));
    const momentum = Math.log(series.klines[index].c / series.klines[index - cfg.priceLookback].c);
    rows.push({ symbol: series.symbol, funding, momentum, volatility: Math.max(series.volatility[index], 0.0005) });
  }
  const momentumMean = avg(rows.map((row) => row.momentum)) || 0;
  const momentumStd = Math.max(stddev(rows.map((row) => row.momentum)) || 0, 1e-9);
  const fundingMean = avg(rows.map((row) => row.funding)) || 0;
  const fundingStd = Math.max(stddev(rows.map((row) => row.funding)) || 0, 1e-9);
  for (const row of rows) {
    row.score = (row.momentum - momentumMean) / momentumStd
      + cfg.fundingWeight * (row.funding - fundingMean) / fundingStd;
  }
  const longs = rows.sort((a, b) => b.score - a.score).slice(0, cfg.count);
  const shorts = rows.sort((a, b) => a.score - b.score).slice(0, cfg.count);
  const weights = new Map();
  for (const [selected, side] of [[longs, 1], [shorts, -1]]) {
    if (!selected.length) continue;
    const denominator = selected.reduce((sum, row) => sum + 1 / row.volatility, 0);
    for (const row of selected) weights.set(row.symbol, side * 0.5 * (1 / row.volatility) / denominator);
  }
  return weights;
}

function simulate(dataset, times, cfg, startTime, endTime) {
  const seriesMap = new Map(dataset.map((row) => [row.symbol, row]));
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let weights = new Map();
  let previousTime = null;
  let periods = cfg.rebalancePeriods;
  let fundingContribution = 0;
  let priceContribution = 0;
  let turnover = 0;
  let riskScale = 1;
  const portfolioReturns = [];
  let grossSum = 0;
  let grossSamples = 0;
  for (const time of times) {
    if (time < startTime || time > endTime) continue;
    if (previousTime != null) {
      let priceReturn = 0;
      let fundingReturn = 0;
      for (const [symbol, weight] of weights) {
        const series = seriesMap.get(symbol);
        const current = series?.maps.get(time);
        const previous = series?.maps.get(previousTime);
        if (!Number.isInteger(current) || !Number.isInteger(previous)) continue;
        priceReturn += weight * (series.klines[current].c / series.klines[previous].c - 1);
        fundingReturn += -weight * series.rates[current];
      }
      equity *= Math.max(0, 1 + priceReturn + fundingReturn);
      portfolioReturns.push(priceReturn + fundingReturn);
      if (portfolioReturns.length > 90) portfolioReturns.shift();
      priceContribution += priceReturn;
      fundingContribution += fundingReturn;
    }
    if (equity <= 0) break;
    periods += 1;
    if (periods >= cfg.rebalancePeriods) {
      if (portfolioReturns.length >= 21) {
        const dailyVolPct = (stddev(portfolioReturns.slice(-60)) || 0) * Math.sqrt(3) * 100;
        if (dailyVolPct > 0.05) {
          const desiredScale = riskScale * cfg.targetDailyVolPct / dailyVolPct;
          riskScale = Math.min(cfg.maxGross, Math.max(0.25, riskScale * 0.7 + desiredScale * 0.3));
        }
      }
      const drawdownPct = peak > 0 ? (peak - equity) / peak * 100 : 0;
      const brake = drawdownPct >= 35 ? 0.2 : drawdownPct >= 25 ? 0.4 : drawdownPct >= 15 ? 0.7 : 1;
      const next = new Map([...desiredWeights(dataset, time, cfg)].map(([symbol, weight]) => [symbol, weight * riskScale * brake]));
      const symbols = new Set([...weights.keys(), ...next.keys()]);
      const currentTurnover = [...symbols].reduce((sum, symbol) => sum + Math.abs((next.get(symbol) || 0) - (weights.get(symbol) || 0)), 0);
      equity *= Math.max(0, 1 - currentTurnover * COST_RATE);
      turnover += currentTurnover;
      weights = next;
      grossSum += [...weights.values()].reduce((sum, weight) => sum + Math.abs(weight), 0);
      grossSamples += 1;
      periods = 0;
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
    priceContributionPct: round(priceContribution * 100),
    fundingContributionPct: round(fundingContribution * 100),
    turnover: round(turnover, 2),
    avgGross: round(grossSamples ? grossSum / grossSamples : 0),
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

function buildWindows(newest, oldest, windowDays) {
  const windows = [];
  let endTime = newest;
  let windowIndex = 0;
  while (endTime - windowDays * DAY >= oldest) {
    windows.push({ windowIndex, startTime: endTime - windowDays * DAY, endTime });
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
  const strict = report.strict;
  const lines = [
    "# Funding-Confirmed Momentum Strict Walk-Forward",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} liquid Binance USDT perpetuals; independent window: ${report.windowDays} days`,
    `Funding history: ${report.days} days; costs: 10 bps fee + 2 bps slippage per one-way turnover`,
    "",
    "## Strict Validation",
    "",
    strict.selected
      ? `Selected only on older tuning-symbol data: **${strict.selected.config.name}**`
      : `No configuration passed the training risk gate: ${strict.reason}`,
    "",
    "| Section | Periods | Positive | Avg Daily % | Median % | Worst % | Avg DD % | Worst DD % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...(strict.sections
      ? Object.entries(strict.sections).map(([name, section]) => `| ${name} | ${section.summary.periods} | ${section.summary.positivePeriods}/${section.summary.periods} | ${section.summary.avgDailyPct} | ${section.summary.medianDailyPct} | ${section.summary.worstDailyPct} | ${section.summary.avgMaxDrawdownPct} | ${section.summary.worstMaxDrawdownPct} |`)
      : []),
    "",
    `Strict acceptance: **${strict.accepted ? "PASS" : "FAIL"}**`,
    "",
    "## Nested Selector",
    "",
    "| Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % | Worst DD % | Lower Confidence % |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.nested.summary.periods} | ${report.nested.summary.positivePeriods}/${report.nested.summary.periods} | ${report.nested.summary.avgDailyPct} | ${report.nested.summary.medianDailyPct} | ${report.nested.summary.worstDailyPct} | ${report.nested.summary.bestDailyPct} | ${report.nested.summary.avgMaxDrawdownPct} | ${report.nested.summary.worstMaxDrawdownPct} | ${report.nested.summary.lowerConfidenceDailyPct} |`,
    "",
    "## Blind Periods",
    "",
    "| Window | Daily % | Return % | DD % | Funding Contribution % | Price Contribution % | Selected Config |",
    "|---:|---:|---:|---:|---:|---:|---|",
    ...report.nested.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.totalReturnPct} | ${row.maxDrawdownPct} | ${row.fundingContributionPct} | ${row.priceContributionPct} | ${row.selectedConfig.name} |`),
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
  const symbols = await fetchTopFuturesSymbols(Math.max(args.symbols, args.candidates));
  const dataset = [];
  for (const symbol of symbols) {
    if (dataset.length >= args.symbols) break;
    try {
      const [funding, klines] = await Promise.all([fetchFunding(symbol, args.days), fetchKlines(symbol, args.days)]);
      const now = Date.now();
      const fundingDays = funding.length ? (now - funding[0].t) / DAY : 0;
      const klineDays = klines.length ? (now - klines[0].t) / DAY : 0;
      const coveragePct = Math.min(fundingDays, klineDays) / args.days * 100;
      if (funding.length >= 200 && klines.length >= 500 && coveragePct >= args.minCoveragePct) {
        dataset.push(prepare(symbol, funding, klines));
      }
      console.error(`${coveragePct >= args.minCoveragePct ? "loaded" : "skip coverage"} ${symbol}: funding=${funding.length}, bars=${klines.length}, coverage=${round(coveragePct, 1)}%`);
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  if (dataset.length < 10) throw new Error(`Only ${dataset.length} symbols passed the history gate.`);
  const times = commonTimes(dataset);
  const newest = Math.min(...dataset.map((series) => series.klines.at(-1).t));
  const oldest = Math.max(...dataset.map((series) => series.klines[0].t));
  const windows = buildWindows(newest, oldest, args.windowDays);
  const configs = buildConfigs();
  const configResults = configs.map((config) => ({
    config,
    windows: windows.map((window) => ({ windowIndex: window.windowIndex, ...simulate(dataset, times, config, window.startTime, window.endTime) })),
  }));
  const nested = nestedSelector(configResults, args.minSelectorWindows);
  const fixed = configResults.map((item) => ({ config: item.config, summary: summarize(item.windows) }))
    .sort((a, b) => (b.summary.lowerConfidenceDailyPct ?? -Infinity) - (a.summary.lowerConfidenceDailyPct ?? -Infinity));
  const fixedDetails = fixed.slice(0, 10).map((row) => ({
    ...row,
    windows: configResults.find((item) => item.config.name === row.config.name).windows,
  }));
  const strict = strictValidation(dataset, configs, windows, args.holdoutWindows, args.holdoutSymbolPct);
  const report = {
    generatedAt: new Date().toISOString(),
    days: args.days,
    windowDays: args.windowDays,
    symbols: dataset.map((row) => row.symbol),
    configurations: configs.length,
    commonHistory: {
      oldest: new Date(oldest).toISOString(),
      newest: new Date(newest).toISOString(),
      windows: windows.length,
    },
    strict,
    nested,
    fixed,
    fixedDetails,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  if (strict.sections) {
    console.table(Object.entries(strict.sections).map(([section, value]) => ({ section, ...value.summary })));
  }
  console.table([nested.summary]);
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
