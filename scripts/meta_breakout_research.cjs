#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const ROUND_TRIP_COST = 0.0024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    candidates: 110,
    interval: "4h",
    minCoveragePct: 70,
    holdoutDays: 180,
    holdoutSymbolPct: 40,
    output: path.join("data", "meta_breakout_research.json"),
    markdown: path.join("data", "meta_breakout_research.md"),
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

function stddev(values) {
  const mean = avg(values);
  return Number.isFinite(mean) ? Math.sqrt(avg(values.map((value) => (value - mean) ** 2))) : null;
}

function quantile(values, q) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = (clean.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return clean[lower] + (clean[upper] - clean[lower]) * (index - lower);
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
      all.push({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) });
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

function rollingMean(values, period) {
  const output = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    output.push(sum / Math.min(period, index + 1));
  }
  return output;
}

function prepare(symbol, candles) {
  const closes = candles.map((row) => row.c);
  const volumes = candles.map((row) => row.c * row.v);
  const tr = candles.map((row, index) => index
    ? Math.max(row.h - row.l, Math.abs(row.h - candles[index - 1].c), Math.abs(row.l - candles[index - 1].c))
    : row.h - row.l);
  const plusDm = candles.map((row, index) => {
    if (!index) return 0;
    const up = row.h - candles[index - 1].h;
    const down = candles[index - 1].l - row.l;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm = candles.map((row, index) => {
    if (!index) return 0;
    const up = row.h - candles[index - 1].h;
    const down = candles[index - 1].l - row.l;
    return down > up && down > 0 ? down : 0;
  });
  const atr = ema(tr, 14);
  const smoothPlus = ema(plusDm, 14);
  const smoothMinus = ema(minusDm, 14);
  const plusDi = smoothPlus.map((value, index) => 100 * value / Math.max(atr[index], 1e-12));
  const minusDi = smoothMinus.map((value, index) => 100 * value / Math.max(atr[index], 1e-12));
  const dx = plusDi.map((value, index) => 100 * Math.abs(value - minusDi[index]) / Math.max(value + minusDi[index], 1e-12));
  return {
    symbol,
    candles,
    closes,
    atr,
    plusDi,
    minusDi,
    adx: ema(dx, 14),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    volumeMean: rollingMean(volumes, 30),
  };
}

function directionalReturn(series, index, lookback, direction) {
  return index >= lookback ? direction * Math.log(series.closes[index] / series.closes[index - lookback]) : 0;
}

function eventFeatures(series, index, direction, breakoutDistanceAtr) {
  const candle = series.candles[index];
  const close = candle.c;
  return [
    directionalReturn(series, index, 1, direction),
    directionalReturn(series, index, 3, direction),
    directionalReturn(series, index, 6, direction),
    directionalReturn(series, index, 12, direction),
    directionalReturn(series, index, 24, direction),
    directionalReturn(series, index, 48, direction),
    direction * (close / series.ema20[index] - 1),
    direction * (close / series.ema50[index] - 1),
    direction * (close / series.ema200[index] - 1),
    series.atr[index] / close,
    series.adx[index] / 100,
    direction * (series.plusDi[index] - series.minusDi[index]) / 100,
    Math.log(Math.max(close * candle.v, 1) / Math.max(series.volumeMean[index], 1)),
    direction * (candle.c - candle.o) / Math.max(candle.o, 1e-12),
    (candle.h - candle.l) / Math.max(close, 1e-12),
    breakoutDistanceAtr,
  ];
}

function buildEvents(series, cfg) {
  const events = [];
  let blockedUntil = 0;
  for (let index = Math.max(220, cfg.breakout + 2); index < series.candles.length - 1; index += 1) {
    if (index <= blockedUntil) continue;
    const candle = series.candles[index];
    const previousHigh = Math.max(...series.candles.slice(index - cfg.breakout, index).map((row) => row.h));
    const previousLow = Math.min(...series.candles.slice(index - cfg.breakout, index).map((row) => row.l));
    const direction = candle.c > previousHigh ? 1 : (candle.c < previousLow ? -1 : 0);
    if (!direction || series.atr[index] <= 0) continue;
    const breakoutDistanceAtr = direction > 0
      ? (candle.c - previousHigh) / series.atr[index]
      : (previousLow - candle.c) / series.atr[index];
    const entryIndex = index + 1;
    const entry = series.candles[entryIndex].o;
    const stopDistance = series.atr[index] * cfg.stopAtr;
    const stop = entry - direction * stopDistance;
    const target = entry + direction * stopDistance * cfg.rewardRisk;
    let exitIndex = Math.min(series.candles.length - 1, entryIndex + cfg.maxHold);
    let exit = series.candles[exitIndex].c;
    let reason = "time";
    for (let cursor = entryIndex; cursor <= exitIndex; cursor += 1) {
      const row = series.candles[cursor];
      const stopHit = direction > 0 ? row.l <= stop : row.h >= stop;
      const targetHit = direction > 0 ? row.h >= target : row.l <= target;
      if (stopHit) {
        exitIndex = cursor;
        exit = stop;
        reason = "stop";
        break;
      }
      if (targetHit) {
        exitIndex = cursor;
        exit = target;
        reason = "target";
        break;
      }
    }
    const grossReturn = direction * (exit / entry - 1);
    const netReturn = grossReturn - ROUND_TRIP_COST;
    const stopPct = stopDistance / entry;
    events.push({
      symbol: series.symbol,
      signalTime: candle.t,
      entryTime: series.candles[entryIndex].t,
      exitTime: series.candles[exitIndex].t,
      direction,
      stopPct,
      netReturn,
      rMultiple: netReturn / Math.max(stopPct, 1e-9),
      reason,
      x: eventFeatures(series, index, direction, breakoutDistanceAtr),
    });
    blockedUntil = exitIndex;
  }
  return events;
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

function trainRidge(events, alpha) {
  const samples = events.filter((event) => event.x.every(Number.isFinite) && Number.isFinite(event.rMultiple));
  const featureCount = samples[0]?.x.length || 0;
  if (samples.length < 100 || !featureCount) return null;
  const means = Array(featureCount).fill(0);
  const deviations = Array(featureCount).fill(1);
  for (let column = 0; column < featureCount; column += 1) {
    means[column] = avg(samples.map((row) => row.x[column]));
    deviations[column] = Math.max(stddev(samples.map((row) => row.x[column])), 1e-9);
  }
  const size = featureCount + 1;
  const xtx = Array.from({ length: size }, () => Array(size).fill(0));
  const xty = Array(size).fill(0);
  for (const sample of samples) {
    const row = [1, ...sample.x.map((value, column) => (value - means[column]) / deviations[column])];
    const target = Math.max(-1.5, Math.min(4, sample.rMultiple));
    for (let i = 0; i < size; i += 1) {
      xty[i] += row[i] * target;
      for (let j = 0; j < size; j += 1) xtx[i][j] += row[i] * row[j];
    }
  }
  for (let index = 1; index < size; index += 1) xtx[index][index] += alpha * samples.length;
  return { coefficients: solveLinear(xtx, xty), means, deviations, samples: samples.length };
}

function predict(model, x) {
  return model.coefficients[0] + x.reduce((sum, value, index) => (
    sum + model.coefficients[index + 1] * ((value - model.means[index]) / model.deviations[index])
  ), 0);
}

function simulate(events, model, cfg, startTime, endTime, threshold) {
  const selected = events.filter((event) => event.entryTime >= startTime && event.exitTime <= endTime)
    .map((event) => ({ ...event, prediction: predict(model, event.x) }))
    .filter((event) => event.prediction >= threshold)
    .sort((a, b) => a.entryTime - b.entryTime);
  const actions = [];
  for (const event of selected) {
    actions.push({ time: event.entryTime, type: "entry", event });
    actions.push({ time: event.exitTime, type: "exit", event });
  }
  actions.sort((a, b) => a.time - b.time || (a.type === "exit" ? -1 : 1));
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let trades = 0;
  let wins = 0;
  const active = new Map();
  for (const action of actions) {
    if (action.type === "exit") {
      const position = active.get(action.event);
      if (!position) continue;
      equity += position.notional * action.event.netReturn;
      if (action.event.netReturn > 0) wins += 1;
      trades += 1;
      active.delete(action.event);
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / Math.max(peak, 1e-12) * 100);
      continue;
    }
    if (active.size >= cfg.maxPositions || [...active.keys()].some((event) => event.symbol === action.event.symbol)) continue;
    const gross = [...active.values()].reduce((sum, position) => sum + position.notional, 0);
    const riskNotional = equity * (cfg.riskPct / 100) / Math.max(action.event.stopPct, 0.001);
    const capacity = Math.max(0, equity * cfg.maxGross - gross);
    const notional = Math.min(riskNotional, equity * cfg.maxPerTrade, capacity);
    if (notional > equity * 0.05) active.set(action.event, { notional });
  }
  const days = Math.max(1, (endTime - startTime) / DAY);
  return {
    totalReturnPct: round((equity / 1000 - 1) * 100),
    dailyPct: equity > 0 ? round((Math.pow(equity / 1000, 1 / days) - 1) * 100) : -100,
    maxDrawdownPct: round(maxDrawdownPct),
    trades,
    winRatePct: trades ? round(wins / trades * 100, 2) : 0,
  };
}

function combineSegments(segments, startTime, endTime) {
  let growth = 1;
  let trades = 0;
  let weightedWins = 0;
  for (const segment of segments) {
    growth *= Math.max(0, 1 + segment.totalReturnPct / 100);
    trades += segment.trades;
    weightedWins += segment.trades * segment.winRatePct / 100;
  }
  const days = Math.max(1, (endTime - startTime) / DAY);
  return {
    totalReturnPct: round((growth - 1) * 100),
    dailyPct: growth > 0 ? round((Math.pow(growth, 1 / days) - 1) * 100) : -100,
    maxDrawdownPct: segments.length ? round(Math.max(...segments.map((row) => row.maxDrawdownPct))) : 0,
    trades,
    winRatePct: trades ? round(weightedWins / trades * 100, 2) : 0,
    segments: segments.length,
  };
}

function rollingEvaluate(trainPool, testPool, selected, cfg, startTime, endTime, trainDays, stepDays) {
  const segments = [];
  let segmentStart = startTime;
  while (segmentStart < endTime) {
    const segmentEnd = Math.min(endTime, segmentStart + stepDays * DAY);
    const trainEvents = trainPool.filter((event) => (
      event.exitTime < segmentStart && event.exitTime >= segmentStart - trainDays * DAY
    ));
    const model = trainRidge(trainEvents, selected.alpha);
    if (model) {
      const threshold = quantile(trainEvents.map((event) => predict(model, event.x)), selected.quantile);
      segments.push(simulate(testPool, model, cfg, segmentStart, segmentEnd, threshold));
    }
    segmentStart = segmentEnd;
  }
  return combineSegments(segments, startTime, endTime);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function splitSymbols(series, holdoutPct) {
  const ordered = [...series].sort((a, b) => stableHash(a.symbol) - stableHash(b.symbol));
  const count = Math.max(4, Math.min(ordered.length - 4, Math.round(ordered.length * holdoutPct / 100)));
  return { holdout: ordered.slice(0, count), tuning: ordered.slice(count) };
}

function summarize(rows) {
  return {
    tests: rows.length,
    avgDailyPct: round(avg(rows.map((row) => row.dailyPct))),
    worstDailyPct: rows.length ? round(Math.min(...rows.map((row) => row.dailyPct))) : null,
    avgMaxDrawdownPct: round(avg(rows.map((row) => row.maxDrawdownPct))),
    worstMaxDrawdownPct: rows.length ? round(Math.max(...rows.map((row) => row.maxDrawdownPct))) : null,
    trades: rows.reduce((sum, row) => sum + row.trades, 0),
    avgWinRatePct: round(avg(rows.map((row) => row.winRatePct))),
  };
}

function toMarkdown(report) {
  const lines = [
    "# Universal Meta-Filtered Breakout",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} Binance perpetual symbols; ${report.interval}; round-trip costs: 24 bps`,
    "",
    "## Selected Configuration",
    "",
    `Base: ${report.selected.base.name}; alpha=${report.selected.alpha}; score quantile=${report.selected.quantile}; risk=${report.selected.riskPct}%; max positions=${report.selected.maxPositions}; max gross=${report.selected.maxGross}x`,
    "",
    "## Strict Validation",
    "",
    "| Split | Daily % | Return % | DD % | Trades | Win Rate % |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(report.strict).map(([name, row]) => `| ${name} | ${row.dailyPct} | ${row.totalReturnPct} | ${row.maxDrawdownPct} | ${row.trades} | ${row.winRatePct} |`),
    "",
    `Strict joint holdout target: **${report.accepted ? "PASS" : "FAIL"}**`,
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const candidates = await fetchTopFuturesSymbols(args.candidates);
  const series = [];
  for (const symbol of candidates) {
    if (series.length >= args.symbols) break;
    try {
      const candles = await fetchCandles(symbol, args.interval, args.days);
      const coveragePct = candles.length ? (Date.now() - candles[0].t) / (args.days * DAY) * 100 : 0;
      if (candles.length >= 1000 && coveragePct >= args.minCoveragePct) series.push(prepare(symbol, candles));
      console.error(`${coveragePct >= args.minCoveragePct ? "loaded" : "skip"} ${symbol}: bars=${candles.length}, coverage=${round(coveragePct, 1)}%`);
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  if (series.length < 12) throw new Error(`Only ${series.length} symbols passed coverage gate.`);
  const newest = Math.min(...series.map((row) => row.candles.at(-1).t));
  const oldest = Math.max(...series.map((row) => row.candles[0].t));
  const holdoutStart = newest - args.holdoutDays * DAY;
  const tuneValidationStart = oldest + (holdoutStart - oldest) * 0.65;
  const split = splitSymbols(series, args.holdoutSymbolPct);
  const bases = [
    { name: "b20-s1.5-r2-h42", breakout: 20, stopAtr: 1.5, rewardRisk: 2, maxHold: 42 },
    { name: "b20-s2-r3-h60", breakout: 20, stopAtr: 2, rewardRisk: 3, maxHold: 60 },
    { name: "b55-s1.5-r2-h60", breakout: 55, stopAtr: 1.5, rewardRisk: 2, maxHold: 60 },
    { name: "b55-s2-r3-h90", breakout: 55, stopAtr: 2, rewardRisk: 3, maxHold: 90 },
    { name: "b89-s2-r2-h90", breakout: 89, stopAtr: 2, rewardRisk: 2, maxHold: 90 },
    { name: "b89-s2.5-r3-h120", breakout: 89, stopAtr: 2.5, rewardRisk: 3, maxHold: 120 },
  ];
  const eventsByBase = new Map();
  for (const base of bases) {
    eventsByBase.set(base.name, new Map(series.map((row) => [row.symbol, buildEvents(row, base)])));
  }
  const eventsFor = (base, selectedSeries) => selectedSeries.flatMap((row) => eventsByBase.get(base.name).get(row.symbol));
  const candidatesResult = [];
  for (const base of bases) {
    const tuneEvents = eventsFor(base, split.tuning);
    const trainEvents = tuneEvents.filter((event) => event.exitTime < tuneValidationStart);
    const validationEvents = tuneEvents.filter((event) => event.entryTime >= tuneValidationStart && event.exitTime < holdoutStart);
    for (const alpha of [0.01, 0.1, 1]) {
      const model = trainRidge(trainEvents, alpha);
      if (!model) continue;
      const predictions = trainEvents.map((event) => predict(model, event.x));
      for (const q of [0.5, 0.65, 0.75, 0.85, 0.9]) {
        const threshold = quantile(predictions, q);
        for (const riskPct of [0.25, 0.5, 0.75, 1]) {
          for (const maxPositions of [4, 8, 12]) {
            for (const maxGross of [2, 4, 6]) {
              const cfg = { riskPct, maxPositions, maxGross, maxPerTrade: 2 };
              const validation = simulate(validationEvents, model, cfg, tuneValidationStart, holdoutStart, threshold);
              const score = validation.dailyPct - validation.maxDrawdownPct * 0.015 + Math.min(0, validation.totalReturnPct) * 0.01;
              candidatesResult.push({ base, alpha, quantile: q, threshold, riskPct, maxPositions, maxGross, validation, score });
            }
          }
        }
      }
    }
  }
  candidatesResult.sort((a, b) => b.score - a.score);
  const selected = candidatesResult.find((row) => row.validation.trades >= 20 && row.validation.maxDrawdownPct <= 45) || candidatesResult[0];
  const allTuneOlder = eventsFor(selected.base, split.tuning).filter((event) => event.exitTime < holdoutStart);
  const cfg = { riskPct: selected.riskPct, maxPositions: selected.maxPositions, maxGross: selected.maxGross, maxPerTrade: 2 };
  const allTuneEvents = eventsFor(selected.base, split.tuning);
  const allHoldoutEvents = eventsFor(selected.base, split.holdout);
  const rollingCandidates = [];
  for (const trainDays of [180, 360, 540]) {
    for (const stepDays of [30, 60]) {
      const validation = rollingEvaluate(
        allTuneEvents,
        allTuneEvents,
        selected,
        cfg,
        tuneValidationStart,
        holdoutStart,
        trainDays,
        stepDays,
      );
      rollingCandidates.push({
        trainDays,
        stepDays,
        validation,
        score: validation.dailyPct - validation.maxDrawdownPct * 0.015,
      });
    }
  }
  rollingCandidates.sort((a, b) => b.score - a.score);
  const rolling = rollingCandidates[0];
  const strict = {
    tuningNewestTime: rollingEvaluate(allTuneEvents, allTuneEvents, selected, cfg, holdoutStart, newest, rolling.trainDays, rolling.stepDays),
    holdoutSymbolsOlderTime: rollingEvaluate(allTuneEvents, allHoldoutEvents, selected, cfg, tuneValidationStart, holdoutStart, rolling.trainDays, rolling.stepDays),
    strictJointHoldout: rollingEvaluate(allTuneEvents, allHoldoutEvents, selected, cfg, holdoutStart, newest, rolling.trainDays, rolling.stepDays),
  };
  const report = {
    generatedAt: new Date().toISOString(),
    interval: args.interval,
    days: args.days,
    symbols: series.map((row) => row.symbol),
    tuningSymbols: split.tuning.map((row) => row.symbol),
    holdoutSymbols: split.holdout.map((row) => row.symbol),
    selected,
    rolling,
    rollingCandidates,
    strict,
    accepted: strict.strictJointHoldout.dailyPct >= 0.8
      && strict.strictJointHoldout.totalReturnPct > 0
      && strict.tuningNewestTime.totalReturnPct > 0
      && strict.holdoutSymbolsOlderTime.totalReturnPct > 0,
    topValidation: candidatesResult.slice(0, 20),
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table(Object.entries(strict).map(([name, row]) => ({ name, ...row })));
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
