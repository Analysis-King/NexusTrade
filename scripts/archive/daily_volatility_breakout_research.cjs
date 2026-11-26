#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const FEE_RATE = 0.001;
const SLIP_RATE = 0.0002;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    windowDays: 90,
    minTrainWindows: 4,
    output: path.join("data", "daily_volatility_breakout_research.json"),
    markdown: path.join("data", "daily_volatility_breakout_research.md"),
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

async function fetchCandles(symbol, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    Object.entries({ symbol, interval: "1h", startTime: cursor, endTime, limit: 1000 }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} Binance ${response.status}: ${await response.text()}`);
    const raw = await response.json();
    if (!raw.length) break;
    for (const row of raw) {
      all.push({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) });
    }
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

function buildDaily(symbol, candles, offsetHours) {
  const offset = offsetHours * 3_600_000;
  const grouped = new Map();
  for (const candle of candles) {
    const day = Math.floor((candle.t + offset) / DAY);
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push(candle);
  }
  const days = [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([day, bars]) => ({
    day,
    startTime: day * DAY - offset,
    bars,
    o: bars[0].o,
    h: Math.max(...bars.map((row) => row.h)),
    l: Math.min(...bars.map((row) => row.l)),
    c: bars.at(-1).c,
    quoteVolume: bars.reduce((sum, row) => sum + row.c * row.v, 0),
  }));
  const closes = days.map((row) => row.c);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  return { symbol, days, byDay: new Map(days.map((row, index) => [row.day, index])), ema20, ema50 };
}

function buildConfigs() {
  const configs = [];
  for (const offsetHours of [0, 8, 16]) {
    for (const triggerK of [0.2, 0.35, 0.5, 0.7]) {
      for (const stopRange of [0.35, 0.6, 1.0]) {
        for (const takeRange of [0, 1.5, 2.5]) {
          for (const trendPeriod of [0, 20, 50]) {
            for (const leverage of [1, 2, 3]) {
              configs.push({
                name: `o${offsetHours}-k${triggerK}-s${stopRange}-t${takeRange}-ema${trendPeriod}-l${leverage}`,
                offsetHours,
                triggerK,
                stopRange,
                takeRange,
                trendPeriod,
                leverage,
              });
            }
          }
        }
      }
    }
  }
  return configs;
}

function tradeDay(series, index, cfg) {
  if (index < 51) return null;
  const current = series.days[index];
  const previous = series.days[index - 1];
  const previousRange = previous.h - previous.l;
  if (!(previousRange > 0) || current.bars.length < 12) return null;
  const referenceEma = cfg.trendPeriod ? series[`ema${cfg.trendPeriod}`][index - 1] : null;
  const allowLong = !cfg.trendPeriod || previous.c >= referenceEma;
  const allowShort = !cfg.trendPeriod || previous.c < referenceEma;
  const longTrigger = current.o + previousRange * cfg.triggerK;
  const shortTrigger = current.o - previousRange * cfg.triggerK;
  let position = null;

  for (const bar of current.bars) {
    if (!position) {
      const longHit = allowLong && bar.h >= longTrigger;
      const shortHit = allowShort && bar.l <= shortTrigger;
      if (longHit && shortHit) return null;
      if (longHit) {
        position = {
          side: 1,
          entry: longTrigger * (1 + SLIP_RATE),
          stop: longTrigger - previousRange * cfg.stopRange,
          take: cfg.takeRange > 0 ? longTrigger + previousRange * cfg.takeRange : null,
        };
      } else if (shortHit) {
        position = {
          side: -1,
          entry: shortTrigger * (1 - SLIP_RATE),
          stop: shortTrigger + previousRange * cfg.stopRange,
          take: cfg.takeRange > 0 ? shortTrigger - previousRange * cfg.takeRange : null,
        };
      }
    }
    if (!position) continue;
    if (position.side > 0) {
      if (bar.l <= position.stop) return (position.stop * (1 - SLIP_RATE) / position.entry - 1) - FEE_RATE * 2;
      if (position.take != null && bar.h >= position.take) return (position.take * (1 - SLIP_RATE) / position.entry - 1) - FEE_RATE * 2;
    } else {
      if (bar.h >= position.stop) return (position.entry / (position.stop * (1 + SLIP_RATE)) - 1) - FEE_RATE * 2;
      if (position.take != null && bar.l <= position.take) return (position.entry / (position.take * (1 + SLIP_RATE)) - 1) - FEE_RATE * 2;
    }
  }
  if (!position) return null;
  const exit = current.c * (position.side > 0 ? (1 - SLIP_RATE) : (1 + SLIP_RATE));
  return (position.side > 0 ? exit / position.entry - 1 : position.entry / exit - 1) - FEE_RATE * 2;
}

function simulate(dataset, cfg, startDay, endDay) {
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let trades = 0;
  let winningDays = 0;
  const dayReturns = [];
  for (let day = startDay; day <= endDay; day += 1) {
    const returns = [];
    for (const series of dataset) {
      const index = series.byDay.get(day);
      if (!Number.isInteger(index)) continue;
      const result = tradeDay(series, index, cfg);
      if (Number.isFinite(result)) returns.push(result);
    }
    const portfolioReturn = returns.length ? avg(returns) * cfg.leverage : 0;
    equity *= Math.max(0, 1 + portfolioReturn);
    trades += returns.length;
    if (portfolioReturn > 0) winningDays += 1;
    dayReturns.push(portfolioReturn);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
    if (equity <= 0) break;
  }
  const days = Math.max(1, endDay - startDay + 1);
  const totalReturnPct = (equity / 1000 - 1) * 100;
  return {
    totalReturnPct: round(totalReturnPct),
    dailyPct: equity > 0 ? round((Math.pow(equity / 1000, 1 / days) - 1) * 100) : -100,
    maxDrawdownPct: round(maxDrawdownPct),
    trades,
    activeDays: dayReturns.filter((value) => value !== 0).length,
    winningDays,
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

function buildWindows(newestDay, oldestDay, windowDays) {
  const windows = [];
  let endDay = newestDay;
  let windowIndex = 0;
  while (endDay - windowDays + 1 >= oldestDay) {
    windows.push({ windowIndex, startDay: endDay - windowDays + 1, endDay });
    endDay -= windowDays;
    windowIndex += 1;
  }
  return windows;
}

function nestedWalkForward(configResults, windows, minTrainWindows) {
  const periods = [];
  for (let windowIndex = windows.length - minTrainWindows - 1; windowIndex >= 0; windowIndex -= 1) {
    const ranked = configResults.map((item) => {
      const training = item.windows.filter((row) => row.windowIndex > windowIndex);
      return { item, training: summarize(training) };
    }).filter((row) => row.training.periods >= minTrainWindows)
      .sort((a, b) => (b.training.lowerConfidenceDailyPct ?? -Infinity) - (a.training.lowerConfidenceDailyPct ?? -Infinity));
    const chosen = ranked[0];
    const current = chosen?.item.windows.find((row) => row.windowIndex === windowIndex);
    if (!chosen || !current) continue;
    periods.push({ ...current, selectedConfig: chosen.item.config, training: chosen.training });
  }
  return { summary: summarize(periods), periods };
}

function toMarkdown(report) {
  const lines = [
    "# Daily Volatility Breakout Nested Walk-Forward",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} current liquid Binance USDT pairs`,
    `Independent window: ${report.windowDays} days; configurations: ${report.configurations}`,
    "Costs: 10 bps fee + 2 bps slippage per side; same-bar SL/TP ambiguity is resolved pessimistically.",
    "",
    "## Nested Walk-Forward",
    "",
    "| Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % | Worst DD % | Lower Confidence % |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.nested.summary.periods} | ${report.nested.summary.positivePeriods}/${report.nested.summary.periods} | ${report.nested.summary.avgDailyPct} | ${report.nested.summary.medianDailyPct} | ${report.nested.summary.worstDailyPct} | ${report.nested.summary.bestDailyPct} | ${report.nested.summary.avgMaxDrawdownPct} | ${report.nested.summary.worstMaxDrawdownPct} | ${report.nested.summary.lowerConfidenceDailyPct} |`,
    "",
    "## Blind Periods",
    "",
    "| Window | Daily % | Return % | DD % | Trades | Selected Config | Training Avg % |",
    "|---:|---:|---:|---:|---:|---|---:|",
    ...report.nested.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.totalReturnPct} | ${row.maxDrawdownPct} | ${row.trades} | ${row.selectedConfig.name} | ${row.training.avgDailyPct} |`),
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
  const raw = [];
  for (const symbol of symbols) {
    try {
      const candles = await fetchCandles(symbol, args.days);
      if (candles.length >= 1200) raw.push({ symbol, candles });
      console.error(`loaded ${symbol}: ${candles.length}`);
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  const configs = buildConfigs();
  const offsets = [...new Set(configs.map((cfg) => cfg.offsetHours))];
  const byOffset = new Map(offsets.map((offset) => [offset, raw.map((row) => buildDaily(row.symbol, row.candles, offset))]));
  const allDays = [...new Set([...byOffset.values()].flatMap((dataset) => dataset.flatMap((series) => series.days.map((row) => row.day))))].sort((a, b) => a - b);
  const windows = buildWindows(allDays.at(-1), allDays[0], args.windowDays);
  const configResults = [];
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index];
    const dataset = byOffset.get(config.offsetHours);
    configResults.push({
      config,
      windows: windows.map((window) => ({
        windowIndex: window.windowIndex,
        ...simulate(dataset, config, window.startDay, window.endDay),
      })),
    });
    if ((index + 1) % 100 === 0 || index + 1 === configs.length) console.error(`tested ${index + 1}/${configs.length}`);
  }
  const nested = nestedWalkForward(configResults, windows, args.minTrainWindows);
  const fixed = configResults.map((item) => ({ config: item.config, summary: summarize(item.windows) }))
    .sort((a, b) => (b.summary.lowerConfidenceDailyPct ?? -Infinity) - (a.summary.lowerConfidenceDailyPct ?? -Infinity));
  const report = {
    generatedAt: new Date().toISOString(),
    symbols: raw.map((row) => row.symbol),
    days: args.days,
    windowDays: args.windowDays,
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
