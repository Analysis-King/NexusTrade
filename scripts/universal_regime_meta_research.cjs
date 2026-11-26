#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    candidates: 160,
    interval: "4h",
    minCoveragePct: 70,
    windowDays: 45,
    minTrainWindows: 4,
    costBps: 7,
    output: path.join("data", "universal_regime_meta_research.json"),
    markdown: path.join("data", "universal_regime_meta_research.md"),
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

async function fetchTopUsdtSymbols(limit) {
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
  const tickers = await response.json();
  const ranked = tickers
    .filter((item) => {
      const symbol = String(item.symbol || "");
      if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
      const base = symbol.slice(0, -4);
      if (stableOrFiat.has(base) || nonCrypto.has(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
      return Number(item.quoteVolume || 0) > 0;
    })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .map((item) => item.symbol);
  if (!ranked.includes("BTCUSDT")) ranked.unshift("BTCUSDT");
  return [...new Set(ranked)].slice(0, limit);
}

async function fetchCandles(symbol, interval, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit: 1000 }).forEach(([key, value]) => {
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
    if (next <= cursor || rows.length < 1000) break;
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

function rollingHigh(values, period) {
  return values.map((_, index) => {
    const start = Math.max(0, index - period);
    return Math.max(...values.slice(start, index));
  });
}

function rollingLow(values, period) {
  return values.map((_, index) => {
    const start = Math.max(0, index - period);
    return Math.min(...values.slice(start, index));
  });
}

function prepareSeries(symbol, candles, interval) {
  const closes = candles.map((row) => row.c);
  const highs = candles.map((row) => row.h);
  const lows = candles.map((row) => row.l);
  const quoteVolumes = candles.map((row) => row.c * row.v);
  const logReturns = closes.map((close, index) => index ? Math.log(close / closes[index - 1]) : 0);
  return {
    symbol,
    interval,
    candles,
    closes,
    highs,
    lows,
    maps: new Map(candles.map((row, index) => [row.t, index])),
    volatility: rollingStd(logReturns, 30),
    liquidity: ema(quoteVolumes, 30),
    ema50: ema(closes, 50),
    ema100: ema(closes, 100),
    ema200: ema(closes, 200),
    high20: rollingHigh(highs, 20),
    high40: rollingHigh(highs, 40),
    high80: rollingHigh(highs, 80),
    low20: rollingLow(lows, 20),
    low40: rollingLow(lows, 40),
    low80: rollingLow(lows, 80),
  };
}

function commonTimes(dataset) {
  return [...new Set(dataset.flatMap((series) => series.candles.map((row) => row.t)))].sort((a, b) => a - b);
}

function buildWindows(times, windowDays) {
  const windows = [];
  let endTime = times.at(-1);
  let windowIndex = 0;
  while (endTime - windowDays * DAY >= times[0]) {
    windows.push({ windowIndex, startTime: endTime - windowDays * DAY, endTime });
    endTime -= windowDays * DAY;
    windowIndex += 1;
  }
  return windows;
}

function marketSnapshot(dataset, time, cfg) {
  const rows = [];
  for (const series of dataset) {
    const index = series.maps.get(time);
    if (!Number.isInteger(index) || index < 220) continue;
    const slowBase = series.closes[index - cfg.marketLookback];
    if (!slowBase) continue;
    rows.push({
      symbol: series.symbol,
      above200: series.closes[index] > series.ema200[index],
      above50: series.closes[index] > series.ema50[index],
      slowRet: series.closes[index] / slowBase - 1,
      dailyVolPct: series.volatility[index] * Math.sqrt(DAY / Math.max(1, series.candles[1].t - series.candles[0].t)) * 100,
    });
  }
  const btc = dataset.find((row) => row.symbol === "BTCUSDT");
  const btcIndex = btc?.maps.get(time);
  const btcAbove200 = Number.isInteger(btcIndex) ? btc.closes[btcIndex] > btc.ema200[btcIndex] : false;
  const btcRet = Number.isInteger(btcIndex) && btcIndex >= cfg.marketLookback
    ? btc.closes[btcIndex] / btc.closes[btcIndex - cfg.marketLookback] - 1
    : 0;
  const breadth200 = rows.length ? rows.filter((row) => row.above200).length / rows.length : 0.5;
  const breadth50 = rows.length ? rows.filter((row) => row.above50).length / rows.length : 0.5;
  const medianMarketRet = median(rows.map((row) => row.slowRet)) || 0;
  const medianDailyVolPct = median(rows.map((row) => row.dailyVolPct)) || 0;
  const breadthStrength = Math.abs(breadth200 - 0.5) * 2;
  return {
    btcAbove200,
    btcRet,
    breadth200,
    breadth50,
    breadthStrength,
    medianMarketRet,
    medianDailyVolPct,
    bull: btcAbove200 && breadth200 >= cfg.bullBreadth && medianMarketRet >= cfg.minMarketRet,
    bear: !btcAbove200 && breadth200 <= cfg.bearBreadth && medianMarketRet <= -cfg.minMarketRet,
    chop: breadthStrength <= cfg.maxChopStrength && Math.abs(medianMarketRet) <= cfg.maxChopRet,
  };
}

function normalizeWeights(rows, budget) {
  if (!rows.length || budget <= 0) return [];
  const rawTotal = rows.reduce((sum, row) => sum + 1 / Math.max(row.volatility, 0.0001), 0);
  return rows.map((row) => ({
    symbol: row.symbol,
    weight: budget * ((1 / Math.max(row.volatility, 0.0001)) / rawTotal) * row.side,
  }));
}

function desiredWeights(dataset, time, cfg) {
  const market = marketSnapshot(dataset, time, cfg);
  if (market.medianDailyVolPct > cfg.maxMarketVolPct) return new Map();
  if (cfg.regime === "trend" && !(market.bull || market.bear)) return new Map();
  if (cfg.regime === "bull" && !market.bull) return new Map();
  if (cfg.regime === "bear" && !market.bear) return new Map();
  if (cfg.regime === "chop" && !market.chop) return new Map();

  const candidates = [];
  for (const series of dataset) {
    const index = series.maps.get(time);
    if (!Number.isInteger(index) || index < Math.max(220, cfg.lookback + 1, cfg.breakout + 1)) continue;
    const close = series.closes[index];
    const lookbackClose = series.closes[index - cfg.lookback];
    if (!lookbackClose) continue;
    const mom = Math.log(close / lookbackClose);
    const vol = Math.max(series.volatility[index], 0.0001);
    const trendUp = close > series.ema200[index] && series.ema50[index] > series.ema200[index];
    const trendDown = close < series.ema200[index] && series.ema50[index] < series.ema200[index];
    const high = series[`high${cfg.breakout}`]?.[index];
    const low = series[`low${cfg.breakout}`]?.[index];
    const breakoutScore = high > 0 ? (close / high - 1) / vol : 0;
    const breakdownScore = low > 0 ? (close / low - 1) / vol : 0;
    candidates.push({
      symbol: series.symbol,
      liquidity: series.liquidity[index],
      volatility: vol,
      momentumScore: mom / vol,
      breakoutScore,
      breakdownScore,
      trendUp,
      trendDown,
    });
  }
  const liquid = candidates.sort((a, b) => b.liquidity - a.liquidity).slice(0, cfg.liquidityCount);
  let longs = [];
  let shorts = [];
  if (cfg.mode === "trend") {
    if (market.bull || cfg.regime === "always") {
      longs = liquid.filter((row) => row.trendUp && row.momentumScore > cfg.minScore)
        .sort((a, b) => b.momentumScore - a.momentumScore)
        .slice(0, cfg.count)
        .map((row) => ({ ...row, side: 1 }));
    }
    if (market.bear || cfg.regime === "always") {
      shorts = liquid.filter((row) => row.trendDown && row.momentumScore < -cfg.minScore)
        .sort((a, b) => a.momentumScore - b.momentumScore)
        .slice(0, cfg.count)
        .map((row) => ({ ...row, side: -1 }));
    }
  } else if (cfg.mode === "breakout") {
    if (market.bull || cfg.regime === "always") {
      longs = liquid.filter((row) => row.trendUp && row.breakoutScore > cfg.minScore)
        .sort((a, b) => b.breakoutScore - a.breakoutScore)
        .slice(0, cfg.count)
        .map((row) => ({ ...row, side: 1 }));
    }
    if (market.bear || cfg.regime === "always") {
      shorts = liquid.filter((row) => row.trendDown && row.breakdownScore < -cfg.minScore)
        .sort((a, b) => a.breakdownScore - b.breakdownScore)
        .slice(0, cfg.count)
        .map((row) => ({ ...row, side: -1 }));
    }
  } else {
    longs = liquid.filter((row) => row.momentumScore < -cfg.minScore)
      .sort((a, b) => a.momentumScore - b.momentumScore)
      .slice(0, cfg.count)
      .map((row) => ({ ...row, side: 1 }));
    shorts = liquid.filter((row) => row.momentumScore > cfg.minScore)
      .sort((a, b) => b.momentumScore - a.momentumScore)
      .slice(0, cfg.count)
      .map((row) => ({ ...row, side: -1 }));
  }

  let longBudget = cfg.gross * 0.5;
  let shortBudget = cfg.gross * 0.5;
  if (market.bull && !market.bear) {
    longBudget = cfg.gross * cfg.directionBias;
    shortBudget = cfg.gross * (1 - cfg.directionBias);
  } else if (market.bear && !market.bull) {
    longBudget = cfg.gross * (1 - cfg.directionBias);
    shortBudget = cfg.gross * cfg.directionBias;
  }
  return new Map([
    ...normalizeWeights(longs, longBudget),
    ...normalizeWeights(shorts, shortBudget),
  ].map((row) => [row.symbol, row.weight]));
}

function scaleWeights(weights, scale) {
  return new Map([...weights].map(([symbol, weight]) => [symbol, weight * scale]));
}

function simulate(dataset, times, cfg, startTime, endTime, costRate) {
  const seriesMap = new Map(dataset.map((series) => [series.symbol, series]));
  let equity = 1000;
  let peak = 1000;
  let maxDrawdownPct = 0;
  let weights = new Map();
  let previousTime = null;
  let barsSinceRebalance = cfg.rebalanceBars;
  let riskScale = 1;
  let turnover = 0;
  let activeBars = 0;
  const returns = [];
  const barDuration = Math.max(1, times[1] - times[0]);
  const barsPerDay = DAY / barDuration;
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
      returns.push(portfolioReturn);
      if (returns.length > 120) returns.shift();
      if (weights.size) activeBars += 1;
    }
    if (equity <= 0) break;
    barsSinceRebalance += 1;
    if (barsSinceRebalance >= cfg.rebalanceBars) {
      if (returns.length >= 24) {
        const dailyVolPct = stddev(returns) * Math.sqrt(barsPerDay) * 100;
        if (Number.isFinite(dailyVolPct) && dailyVolPct > 0.05) {
          const desired = riskScale * cfg.targetDailyVolPct / dailyVolPct;
          riskScale = Math.min(cfg.maxScale, Math.max(0.05, riskScale * 0.65 + desired * 0.35));
        }
      }
      const drawdownPct = peak > 0 ? (peak - equity) / peak * 100 : 0;
      let brake = 1;
      if (drawdownPct > cfg.hardBrakeDd) brake = 0;
      else if (drawdownPct > cfg.softBrakeDd) brake = cfg.softBrakeScale;
      if (cfg.recentBrakeBars && returns.length >= cfg.recentBrakeBars) {
        const recent = returns.slice(-cfg.recentBrakeBars);
        if ((avg(recent) || 0) <= 0) brake *= cfg.recentBrakeScale;
      }
      const nextWeights = scaleWeights(desiredWeights(dataset, time, cfg), riskScale * brake);
      const symbols = new Set([...weights.keys(), ...nextWeights.keys()]);
      const currentTurnover = [...symbols].reduce(
        (sum, symbol) => sum + Math.abs((nextWeights.get(symbol) || 0) - (weights.get(symbol) || 0)),
        0,
      );
      equity *= Math.max(0, 1 - currentTurnover * costRate);
      turnover += currentTurnover;
      weights = nextWeights;
      barsSinceRebalance = 0;
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
    activePct: round((activeBars / Math.max(1, (endTime - startTime) / barDuration)) * 100, 2),
  };
}

function buildConfigs() {
  const configs = [];
  const base = {
    liquidityCount: 50,
    marketLookback: 45,
    bullBreadth: 0.56,
    bearBreadth: 0.44,
    minMarketRet: 0.015,
    maxChopStrength: 0.25,
    maxChopRet: 0.02,
    directionBias: 0.8,
    softBrakeDd: 12,
    hardBrakeDd: 28,
    softBrakeScale: 0.35,
  };
  for (const mode of ["trend", "breakout"]) {
    for (const regime of ["trend", "always", "bull", "bear"]) {
      for (const lookback of [12, 30, 60, 120]) {
        for (const breakout of [20, 40, 80]) {
          for (const count of [3, 5, 8]) {
            for (const gross of [1.5, 2.5, 4]) {
              for (const targetDailyVolPct of [2.5, 4.5, 6.5]) {
                for (const maxMarketVolPct of [4.5, 7.5]) {
                  configs.push({
                    ...base,
                    name: `${mode}-${regime}-l${lookback}-b${breakout}-n${count}-g${gross}-v${targetDailyVolPct}-mv${maxMarketVolPct}`,
                    mode,
                    regime,
                    lookback,
                    breakout,
                    count,
                    gross,
                    minScore: 0.2,
                    targetDailyVolPct,
                    maxScale: 2.5,
                    maxMarketVolPct,
                    rebalanceBars: 2,
                    recentBrakeBars: 18,
                    recentBrakeScale: 0.35,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  for (const lookback of [6, 12, 30]) {
    for (const count of [3, 5, 8]) {
      for (const gross of [1, 1.5, 2.5]) {
        for (const targetDailyVolPct of [1.5, 2.5, 4]) {
          configs.push({
            ...base,
            name: `reversal-chop-l${lookback}-n${count}-g${gross}-v${targetDailyVolPct}`,
            mode: "reversal",
            regime: "chop",
            lookback,
            breakout: 20,
            count,
            gross,
            minScore: 0.8,
            targetDailyVolPct,
            maxScale: 2,
            maxMarketVolPct: 5,
            rebalanceBars: 1,
            recentBrakeBars: 18,
            recentBrakeScale: 0.25,
          });
        }
      }
    }
  }
  return configs;
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
    avgActivePct: round(avg(rows.map((row) => row.activePct))),
    lowerConfidenceDailyPct: values.length
      ? round(mean - 0.75 * deviation / Math.sqrt(values.length) + Math.min(0, worst) * 0.25)
      : null,
  };
}

function robustScore(summary) {
  if (!summary || summary.periods < 4) return -Infinity;
  if (summary.positivePct < 55 || summary.worstDailyPct < -0.75 || summary.avgMaxDrawdownPct > 35) return -Infinity;
  return (summary.lowerConfidenceDailyPct ?? -Infinity)
    + (summary.medianDailyPct ?? 0) * 0.35
    - (summary.avgMaxDrawdownPct ?? 0) * 0.01;
}

function nestedWalkForward(configResults, windows, minTrainWindows) {
  const periods = [];
  for (let windowIndex = windows.length - minTrainWindows - 1; windowIndex >= 0; windowIndex -= 1) {
    const ranked = configResults.map((item) => {
      const training = item.windows.filter((row) => row.windowIndex > windowIndex);
      return { item, training: summarize(training), score: robustScore(summarize(training)) };
    }).filter((row) => row.training.periods >= minTrainWindows)
      .sort((a, b) => b.score - a.score);
    const chosen = ranked[0];
    const current = chosen?.item.windows.find((row) => row.windowIndex === windowIndex);
    if (!chosen || !current || !Number.isFinite(chosen.score)) {
      periods.push({ windowIndex, dailyPct: 0, totalReturnPct: 0, maxDrawdownPct: 0, activePct: 0, selectedConfig: { name: "CASH" }, training: null });
      continue;
    }
    periods.push({ ...current, selectedConfig: chosen.item.config, training: chosen.training });
  }
  return { summary: summarize(periods), periods };
}

function toMarkdown(report) {
  const lines = [
    "# Universal Regime Meta Research",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} Binance USD-M perpetuals`,
    `Interval: ${report.interval}; window: ${report.windowDays} days; costs: ${report.costBps} bps per turnover`,
    `Configurations: ${report.configurations}`,
    "",
    "## Nested Walk-Forward",
    "",
    "| Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % | Worst DD % | Active % | Lower Confidence % |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${report.nested.summary.periods} | ${report.nested.summary.positivePeriods}/${report.nested.summary.periods} | ${report.nested.summary.avgDailyPct} | ${report.nested.summary.medianDailyPct} | ${report.nested.summary.worstDailyPct} | ${report.nested.summary.bestDailyPct} | ${report.nested.summary.avgMaxDrawdownPct} | ${report.nested.summary.worstMaxDrawdownPct} | ${report.nested.summary.avgActivePct} | ${report.nested.summary.lowerConfidenceDailyPct} |`,
    "",
    "## Blind Periods",
    "",
    "| Window | Daily % | Return % | DD % | Active % | Selected Config | Training Avg % |",
    "|---:|---:|---:|---:|---:|---|---:|",
    ...report.nested.periods.map((row) => `| ${row.windowIndex} | ${row.dailyPct} | ${row.totalReturnPct} | ${row.maxDrawdownPct} | ${row.activePct} | ${row.selectedConfig.name} | ${row.training?.avgDailyPct ?? "-"} |`),
    "",
    "## Best Fixed Configurations (diagnostic only)",
    "",
    "| Config | Avg Daily % | Median % | Positive % | Worst % | Avg DD % | Active % |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.fixed.slice(0, 20).map((row) => `| ${row.config.name} | ${row.summary.avgDailyPct} | ${row.summary.medianDailyPct} | ${row.summary.positivePct} | ${row.summary.worstDailyPct} | ${row.summary.avgMaxDrawdownPct} | ${row.summary.avgActivePct} |`),
    "",
    "This is a research estimate, not a profit guarantee.",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const candidates = await fetchTopUsdtSymbols(args.candidates);
  const dataset = [];
  for (const symbol of candidates) {
    if (dataset.length >= args.symbols) break;
    try {
      const candles = await fetchCandles(symbol, args.interval, args.days);
      const expected = args.days * DAY / intervalMs(args.interval);
      const coveragePct = candles.length / Math.max(1, expected) * 100;
      if (coveragePct >= args.minCoveragePct && candles.length >= 600) {
        dataset.push(prepareSeries(symbol, candles, args.interval));
        console.error(`loaded ${symbol}: ${candles.length}, coverage=${round(coveragePct, 1)}%`);
      } else {
        console.error(`skip ${symbol}: ${candles.length}, coverage=${round(coveragePct, 1)}%`);
      }
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  if (dataset.length < 20) throw new Error(`Only ${dataset.length} symbols passed coverage gate.`);
  const times = commonTimes(dataset);
  const windows = buildWindows(times, args.windowDays);
  const configs = buildConfigs();
  const costRate = args.costBps / 10000;
  const configResults = [];
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index];
    const rows = windows.map((window) => ({
      windowIndex: window.windowIndex,
      ...simulate(dataset, times, config, window.startTime, window.endTime, costRate),
    }));
    configResults.push({ config, windows: rows });
    if ((index + 1) % 50 === 0 || index + 1 === configs.length) console.error(`tested ${index + 1}/${configs.length}`);
  }
  const nested = nestedWalkForward(configResults, windows, args.minTrainWindows);
  const fixed = configResults.map((item) => ({ config: item.config, summary: summarize(item.windows) }))
    .sort((a, b) => robustScore(b.summary) - robustScore(a.summary));
  const report = {
    generatedAt: new Date().toISOString(),
    interval: args.interval,
    days: args.days,
    costBps: args.costBps,
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
