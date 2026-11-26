#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const FEE_SLIP_RATE = 0.0012;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    days: 1080,
    symbols: 50,
    interval: "6h",
    windowDays: 90,
    minTrainWindows: 4,
    regimeOnly: 0,
    consistencyOnly: 0,
    refineOnly: 0,
    flipOnly: 0,
    output: path.join("data", "risk_targeted_momentum_research.json"),
    markdown: path.join("data", "risk_targeted_momentum_research.md"),
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

function correlation(left, right) {
  if (left.length !== right.length || left.length < 5) return null;
  const leftMean = avg(left);
  const rightMean = avg(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const denominator = Math.sqrt(
    left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0)
    * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0),
  );
  return denominator > 1e-12 ? numerator / denominator : null;
}

async function fetchTopUsdtSymbols(limit) {
  const stableOrFiat = new Set([
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDE", "USD1",
    "RLUSD", "XUSD", "EUR", "TRY", "BRL", "ARS", "AEUR", "PAXG", "XAUT",
  ]);
  const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  if (!response.ok) throw new Error(`Binance ticker ${response.status}: ${await response.text()}`);
  const tickers = await response.json();
  const ranked = tickers
    .filter((item) => {
      const symbol = String(item.symbol || "");
      if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
      const base = symbol.slice(0, -4);
      if (stableOrFiat.has(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
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
    const url = new URL("https://api.binance.com/api/v3/klines");
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit: 1000 }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} ${interval} Binance ${response.status}: ${await response.text()}`);
    const raw = await response.json();
    if (!raw.length) break;
    for (const row of raw) {
      all.push({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) });
    }
    const next = Number(raw.at(-1)[6]) + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(35);
  }
  return [...new Map(all.map((candle) => [candle.t, candle])).values()].sort((a, b) => a.t - b.t);
}

function ema(values, period) {
  const output = [];
  const alpha = 2 / (period + 1);
  for (const value of values) {
    output.push(output.length ? value * alpha + output.at(-1) * (1 - alpha) : value);
  }
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
    const variance = Math.max(0, sumSquares / size - (sum / size) ** 2);
    output.push(Math.sqrt(variance));
  }
  return output;
}

function prepareSeries(symbol, candles) {
  const closes = candles.map((row) => row.c);
  const logReturns = closes.map((close, index) => index ? Math.log(close / closes[index - 1]) : 0);
  const quoteVolumes = candles.map((row) => row.c * row.v);
  const maps = new Map(candles.map((row, index) => [row.t, index]));
  return {
    symbol,
    candles,
    closes,
    logReturns,
    volatility: rollingStd(logReturns, 28),
    liquidity: ema(quoteVolumes, 28),
    ema50: ema(closes, 50),
    ema100: ema(closes, 100),
    ema200: ema(closes, 200),
    maps,
  };
}

function buildConfigs(regimeOnly = false, consistencyOnly = false, refineOnly = false, flipOnly = false) {
  const configs = [];
  const adaptiveMomentum = [
    { name: "classic", lookbacks: [20, 60, 120], weights: [0.2, 0.45, 0.35], skip: 0 },
    { name: "slow", lookbacks: [12, 56, 112], weights: [0.2, 0.45, 0.35], skip: 0 },
  ];
  const adaptiveNeutral = { name: "neutral", bullLong: 0.5, bullShort: 0.5, bearLong: 0.5, bearShort: 0.5 };
  for (const momentum of adaptiveMomentum) {
    for (const count of [6, 10]) {
      for (const rebalanceBars of [4, 8]) {
        for (const trendPeriod of [0, 200]) {
          for (const targetDailyVolPct of [4, 6, 8]) {
            for (const maxGross of [8, 12]) {
              for (const icHorizonBars of [4, 8]) {
                for (const icLookback of [8, 16]) {
                  for (const minAbsIc of [0, 0.05]) {
                    configs.push({
                      name: `ic-${momentum.name}-n${count}-r${rebalanceBars}-t${trendPeriod}-v${targetDailyVolPct}-g${maxGross}-h${icHorizonBars}-w${icLookback}-i${minAbsIc}`,
                      momentum,
                      allocation: adaptiveNeutral,
                      count,
                      rebalanceBars,
                      leverage: 1,
                      trendPeriod,
                      liquidityCount: 35,
                      minAbsScore: 0,
                      scoreDirection: 1,
                      minSpread: 0,
                      centerComponents: true,
                      requireConsistency: false,
                      targetDailyVolPct,
                      maxGross,
                      equityBrake: 24,
                      riskOffScale: 0.25,
                      icHorizonBars,
                      icLookback,
                      minAbsIc,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return configs;
  const momentumSets = [
    { name: "fast", lookbacks: [4, 12, 28], weights: [0.5, 0.3, 0.2], skip: 0 },
    { name: "balanced", lookbacks: [4, 28, 84], weights: [0.25, 0.45, 0.3], skip: 0 },
    { name: "slow", lookbacks: [12, 56, 112], weights: [0.2, 0.45, 0.35], skip: 0 },
  ];
  const allocations = [
    { name: "asym", bullLong: 0.8, bullShort: 0.2, bearLong: 0.3, bearShort: 0.7 },
    { name: "neutral", bullLong: 0.5, bullShort: 0.5, bearLong: 0.5, bearShort: 0.5 },
    { name: "directional", bullLong: 1, bullShort: 0, bearLong: 0, bearShort: 1 },
  ];
  for (const momentum of momentumSets) {
    for (const allocation of allocations) {
      for (const count of [2, 4, 6]) {
        for (const rebalanceBars of [1, 2, 4]) {
          for (const leverage of [2, 3, 4]) {
            configs.push({
              name: `${momentum.name}-${allocation.name}-n${count}-r${rebalanceBars}-l${leverage}`,
              momentum,
              allocation,
              count,
              rebalanceBars,
              leverage,
              trendPeriod: 100,
              liquidityCount: 35,
              minAbsScore: 0,
              scoreDirection: 1,
              minSpread: 0,
            });
          }
        }
      }
    }
  }

  const focusedMomentum = [
    { name: "slow-skip2", lookbacks: [12, 56, 112], weights: [0.2, 0.45, 0.35], skip: 2 },
    { name: "slow-skip4", lookbacks: [12, 56, 112], weights: [0.2, 0.45, 0.35], skip: 4 },
    { name: "classic", lookbacks: [20, 60, 120], weights: [0.2, 0.45, 0.35], skip: 0 },
    { name: "classic-skip4", lookbacks: [20, 60, 120], weights: [0.2, 0.45, 0.35], skip: 4 },
    { name: "long", lookbacks: [28, 84, 168], weights: [0.15, 0.45, 0.4], skip: 0 },
  ];
  const focusedAllocations = [
    { name: "neutral", bullLong: 0.5, bullShort: 0.5, bearLong: 0.5, bearShort: 0.5 },
    { name: "mild-asym", bullLong: 0.65, bullShort: 0.35, bearLong: 0.35, bearShort: 0.65 },
  ];
  for (const momentum of focusedMomentum) {
    for (const allocation of focusedAllocations) {
      for (const count of [6, 10]) {
        for (const rebalanceBars of [4, 8, 12]) {
          for (const leverage of [1.5, 2, 2.5]) {
            for (const trendPeriod of [0, 100, 200]) {
              configs.push({
                name: `${momentum.name}-${allocation.name}-n${count}-r${rebalanceBars}-l${leverage}-t${trendPeriod}`,
                momentum,
                allocation,
                count,
                rebalanceBars,
                leverage,
                trendPeriod,
                liquidityCount: 35,
                minAbsScore: 0,
                scoreDirection: 1,
                minSpread: 0,
              });
            }
          }
        }
      }
    }
  }

  const reversalMomentum = [
    { name: "rev-1-2-4", lookbacks: [1, 2, 4], weights: [0.5, 0.3, 0.2], skip: 0 },
    { name: "rev-1-4-12", lookbacks: [1, 4, 12], weights: [0.45, 0.35, 0.2], skip: 0 },
    { name: "rev-2-8-20", lookbacks: [2, 8, 20], weights: [0.4, 0.4, 0.2], skip: 0 },
  ];
  const neutral = { name: "neutral", bullLong: 0.5, bullShort: 0.5, bearLong: 0.5, bearShort: 0.5 };
  for (const momentum of reversalMomentum) {
    for (const count of [2, 4, 6, 10]) {
      for (const rebalanceBars of [1, 2, 4]) {
        for (const leverage of [1, 1.5, 2, 3]) {
          configs.push({
            name: `${momentum.name}-neutral-n${count}-r${rebalanceBars}-l${leverage}`,
            momentum,
            allocation: neutral,
            count,
            rebalanceBars,
            leverage,
            trendPeriod: 0,
            liquidityCount: 35,
            minAbsScore: 0,
            scoreDirection: -1,
            minSpread: 0,
          });
        }
      }
    }
  }
  const selectiveMomentum = [
    { name: "slow", lookbacks: [12, 56, 112], weights: [0.2, 0.45, 0.35], skip: 0 },
    { name: "slow-skip2", lookbacks: [12, 56, 112], weights: [0.2, 0.45, 0.35], skip: 2 },
    { name: "classic", lookbacks: [20, 60, 120], weights: [0.2, 0.45, 0.35], skip: 0 },
  ];
  for (const momentum of selectiveMomentum) {
    for (const count of [6, 8]) {
      for (const rebalanceBars of [4, 8]) {
        for (const leverage of [1.5, 2, 2.5]) {
          for (const trendPeriod of [100, 200]) {
            for (const minAbsScore of [0, 1, 2]) {
              for (const minSpread of [0, 3, 5]) {
                configs.push({
                  name: `select-${momentum.name}-n${count}-r${rebalanceBars}-l${leverage}-t${trendPeriod}-a${minAbsScore}-d${minSpread}`,
                  momentum,
                  allocation: neutral,
                  count,
                  rebalanceBars,
                  leverage,
                  trendPeriod,
                  liquidityCount: 35,
                  minAbsScore,
                  scoreDirection: 1,
                  minSpread,
                });
              }
            }
          }
        }
      }
    }
  }

  const riskTargetedMomentum = [
    { name: "slow", lookbacks: [12, 56, 112], weights: [0.2, 0.45, 0.35], skip: 0 },
    { name: "classic", lookbacks: [20, 60, 120], weights: [0.2, 0.45, 0.35], skip: 0 },
  ];
  const riskTargetedAllocations = [
    { name: "neutral", bullLong: 0.5, bullShort: 0.5, bearLong: 0.5, bearShort: 0.5 },
    { name: "asym", bullLong: 0.7, bullShort: 0.3, bearLong: 0.3, bearShort: 0.7 },
  ];
  for (const momentum of riskTargetedMomentum) {
    for (const allocation of riskTargetedAllocations) {
      for (const count of [4, 6, 8]) {
        for (const rebalanceBars of [4, 8]) {
          for (const trendPeriod of [100, 200]) {
            for (const targetDailyVolPct of [4, 6, 8]) {
              for (const maxGross of [4, 8, 12]) {
                for (const minSpread of [0, 3]) {
                  for (const equityBrake of [0, 24]) {
                    configs.push({
                      name: `risk-${momentum.name}-${allocation.name}-n${count}-r${rebalanceBars}-t${trendPeriod}-v${targetDailyVolPct}-g${maxGross}-d${minSpread}-e${equityBrake}`,
                      momentum,
                      allocation,
                      count,
                      rebalanceBars,
                      leverage: 1,
                      trendPeriod,
                      liquidityCount: 35,
                      minAbsScore: 0,
                      scoreDirection: 1,
                      minSpread,
                      centerScores: true,
                      targetDailyVolPct,
                      maxGross,
                      equityBrake,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  const regimeConfigs = [];
  for (const momentum of riskTargetedMomentum) {
    for (const count of [4, 6, 8]) {
      for (const rebalanceBars of [4, 8]) {
        for (const trendPeriod of [100, 200]) {
          for (const targetDailyVolPct of [4, 6]) {
            for (const maxGross of [8, 12]) {
              for (const minBreadthStrength of [0, 0.2, 0.35]) {
                for (const minBtcTrendPct of [0, 3]) {
                  for (const maxBtcDailyVolPct of [0, 6]) {
                    regimeConfigs.push({
                      name: `regime-${momentum.name}-n${count}-r${rebalanceBars}-t${trendPeriod}-v${targetDailyVolPct}-g${maxGross}-b${minBreadthStrength}-m${minBtcTrendPct}-x${maxBtcDailyVolPct}`,
                      momentum,
                      allocation: riskTargetedAllocations[1],
                      count,
                      rebalanceBars,
                      leverage: 1,
                      trendPeriod,
                      liquidityCount: 35,
                      minAbsScore: 0,
                      scoreDirection: 1,
                      minSpread: 0,
                      centerScores: true,
                      targetDailyVolPct,
                      maxGross,
                      equityBrake: 0,
                      minBreadthStrength,
                      minBtcTrendPct,
                      maxBtcDailyVolPct,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  const consistencyConfigs = [];
  for (const momentum of riskTargetedMomentum) {
    for (const count of [3, 5, 8]) {
      for (const rebalanceBars of [4, 8]) {
        for (const trendPeriod of [100, 200]) {
          for (const targetDailyVolPct of [4, 6, 8]) {
            for (const maxGross of [8, 12]) {
              for (const minComponentScore of [0, 1, 2]) {
                for (const maxBtcDailyVolPct of [0, 6]) {
                  consistencyConfigs.push({
                    name: `consistent-${momentum.name}-n${count}-r${rebalanceBars}-t${trendPeriod}-v${targetDailyVolPct}-g${maxGross}-c${minComponentScore}-x${maxBtcDailyVolPct}`,
                    momentum,
                    allocation: riskTargetedAllocations[1],
                    count,
                    rebalanceBars,
                    leverage: 1,
                    trendPeriod,
                    liquidityCount: 35,
                    minAbsScore: 0,
                    scoreDirection: 1,
                    minSpread: 0,
                    centerComponents: true,
                    requireConsistency: true,
                    minComponentScore,
                    targetDailyVolPct,
                    maxGross,
                    equityBrake: 0,
                    maxBtcDailyVolPct,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  const refineConfigs = [];
  const brakes = [
    { equityBrake: 0, riskOffScale: 1 },
    { equityBrake: 24, riskOffScale: 0 },
    { equityBrake: 48, riskOffScale: 0 },
    { equityBrake: 24, riskOffScale: 0.25 },
  ];
  for (const count of [6, 8, 10]) {
    for (const rebalanceBars of [6, 8]) {
      for (const trendPeriod of [100, 200]) {
        for (const targetDailyVolPct of [8, 10]) {
          for (const maxGross of [12, 16]) {
            for (const minComponentScore of [0.5, 1, 1.5]) {
              for (const maxBtcDailyVolPct of [0, 6]) {
                for (const brake of brakes) {
                  refineConfigs.push({
                    name: `refine-classic-n${count}-r${rebalanceBars}-t${trendPeriod}-v${targetDailyVolPct}-g${maxGross}-c${minComponentScore}-x${maxBtcDailyVolPct}-e${brake.equityBrake}-o${brake.riskOffScale}`,
                    momentum: riskTargetedMomentum[1],
                    allocation: riskTargetedAllocations[1],
                    count,
                    rebalanceBars,
                    leverage: 1,
                    trendPeriod,
                    liquidityCount: 35,
                    minAbsScore: 0,
                    scoreDirection: 1,
                    minSpread: 0,
                    centerComponents: true,
                    requireConsistency: true,
                    minComponentScore,
                    targetDailyVolPct,
                    maxGross,
                    equityBrake: brake.equityBrake,
                    riskOffScale: brake.riskOffScale,
                    maxBtcDailyVolPct,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  const flipConfigs = [];
  for (const count of [5, 8, 10]) {
    for (const rebalanceBars of [4, 8]) {
      for (const trendPeriod of [100, 200]) {
        for (const targetDailyVolPct of [4, 6, 8]) {
          for (const maxGross of [8, 12]) {
            for (const minComponentScore of [0, 1]) {
              for (const equityBrake of [12, 24, 48, 96]) {
                for (const riskOffScale of [-1, -0.5, 0]) {
                  flipConfigs.push({
                    name: `flip-classic-n${count}-r${rebalanceBars}-t${trendPeriod}-v${targetDailyVolPct}-g${maxGross}-c${minComponentScore}-e${equityBrake}-o${riskOffScale}`,
                    momentum: riskTargetedMomentum[1],
                    allocation: riskTargetedAllocations[1],
                    count,
                    rebalanceBars,
                    leverage: 1,
                    trendPeriod,
                    liquidityCount: 35,
                    minAbsScore: 0,
                    scoreDirection: 1,
                    minSpread: 0,
                    centerComponents: true,
                    requireConsistency: true,
                    minComponentScore,
                    targetDailyVolPct,
                    maxGross,
                    equityBrake,
                    riskOffScale,
                    maxBtcDailyVolPct: 6,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  if (flipOnly) return flipConfigs;
  if (refineOnly) return refineConfigs;
  if (consistencyOnly) return consistencyConfigs;
  if (regimeOnly) return regimeConfigs;
  return [...configs, ...regimeConfigs, ...consistencyConfigs];
}

function momentumScore(series, index, momentum) {
  let score = 0;
  const skip = momentum.skip || 0;
  for (let item = 0; item < momentum.lookbacks.length; item += 1) {
    const lookback = momentum.lookbacks[item];
    if (index < lookback + skip || series.closes[index - lookback - skip] <= 0) return null;
    score += Math.log(series.closes[index - skip] / series.closes[index - lookback - skip]) * momentum.weights[item];
  }
  const volatility = Math.max(series.volatility[index], 0.0001);
  return score / volatility;
}

function momentumComponents(series, index, momentum) {
  const skip = momentum.skip || 0;
  const volatility = Math.max(series.volatility[index], 0.0001);
  const output = [];
  for (const lookback of momentum.lookbacks) {
    if (index < lookback + skip || series.closes[index - lookback - skip] <= 0) return null;
    output.push(Math.log(series.closes[index - skip] / series.closes[index - lookback - skip]) / volatility);
  }
  return output;
}

function rollingInformationCoefficient(dataset, time, cfg) {
  const observations = [];
  for (let sample = 0; sample < cfg.icLookback; sample += 1) {
    const offset = cfg.icHorizonBars + sample * cfg.rebalanceBars;
    const scores = [];
    const futureReturns = [];
    for (const series of dataset) {
      const currentIndex = series.maps.get(time);
      if (!Number.isInteger(currentIndex)) continue;
      const signalIndex = currentIndex - offset;
      const targetIndex = signalIndex + cfg.icHorizonBars;
      if (signalIndex < 210 || targetIndex > currentIndex || targetIndex >= series.closes.length) continue;
      const score = momentumScore(series, signalIndex, cfg.momentum);
      const start = series.closes[signalIndex];
      const end = series.closes[targetIndex];
      if (!Number.isFinite(score) || !(start > 0) || !(end > 0)) continue;
      scores.push(score);
      futureReturns.push(Math.log(end / start));
    }
    const value = correlation(scores, futureReturns);
    if (Number.isFinite(value)) observations.push(value);
  }
  return avg(observations);
}

function normalizeSide(rows, budget) {
  if (!rows.length || budget <= 0) return [];
  const rawTotal = rows.reduce((sum, row) => sum + 1 / Math.max(row.volatility, 0.0001), 0);
  return rows.map((row) => ({
    symbol: row.symbol,
    weight: budget * ((1 / Math.max(row.volatility, 0.0001)) / rawTotal) * row.side,
  }));
}

function desiredWeights(dataset, time, cfg, directionScale = 1) {
  const available = [];
  for (const series of dataset) {
    const index = series.maps.get(time);
    if (!Number.isInteger(index) || index < 210) continue;
    const rawScore = momentumScore(series, index, cfg.momentum);
    if (!Number.isFinite(rawScore)) continue;
    const components = momentumComponents(series, index, cfg.momentum);
    if (!components) continue;
    const score = rawScore * (cfg.scoreDirection || 1) * directionScale;
    const trend = cfg.trendPeriod === 0
      ? 0
      : (series.closes[index] > series[`ema${cfg.trendPeriod}`][index] ? 1 : -1);
    available.push({
      symbol: series.symbol,
      score,
      trend,
      volatility: series.volatility[index],
      liquidity: series.liquidity[index],
      components,
    });
  }
  const liquid = available.sort((a, b) => b.liquidity - a.liquidity).slice(0, cfg.liquidityCount);
  const btc = dataset.find((row) => row.symbol === "BTCUSDT");
  const btcIndex = btc?.maps.get(time);
  const btcTrendPct = Number.isInteger(btcIndex)
    ? Math.abs(btc.closes[btcIndex] / btc.ema200[btcIndex] - 1) * 100
    : 0;
  const btcDailyVolPct = Number.isInteger(btcIndex)
    ? btc.volatility[btcIndex] * Math.sqrt(DAY / Math.max(1, btc.candles[1].t - btc.candles[0].t)) * 100
    : 0;
  const breadth = liquid.length ? liquid.filter((row) => row.trend > 0).length / liquid.length : 0.5;
  const breadthStrength = Math.abs(breadth - 0.5) * 2;
  if ((cfg.minBreadthStrength || 0) > breadthStrength) return new Map();
  if ((cfg.minBtcTrendPct || 0) > btcTrendPct) return new Map();
  if ((cfg.maxBtcDailyVolPct || 0) > 0 && btcDailyVolPct > cfg.maxBtcDailyVolPct) return new Map();
  if (cfg.centerComponents && liquid.length) {
    const centers = cfg.momentum.lookbacks.map((_, componentIndex) => (
      median(liquid.map((row) => row.components[componentIndex])) || 0
    ));
    for (const row of liquid) {
      row.components = row.components.map((value, componentIndex) => (value - centers[componentIndex]) * directionScale);
      row.score = row.components.reduce(
        (sum, value, componentIndex) => sum + value * cfg.momentum.weights[componentIndex],
        0,
      );
    }
  }
  if (cfg.centerScores && liquid.length) {
    const center = median(liquid.map((row) => row.score)) || 0;
    for (const row of liquid) row.score -= center;
  }
  const scores = liquid.map((row) => row.score).filter(Number.isFinite);
  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
  if (spread < (cfg.minSpread || 0)) return new Map();
  const longs = liquid
    .filter((row) => row.trend >= 0
      && row.score > cfg.minAbsScore
      && (!cfg.requireConsistency || row.components.every((value) => value > (cfg.minComponentScore || 0))))
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.count)
    .map((row) => ({ ...row, side: 1 }));
  const shorts = liquid
    .filter((row) => row.trend <= 0
      && row.score < -cfg.minAbsScore
      && (!cfg.requireConsistency || row.components.every((value) => value < -(cfg.minComponentScore || 0))))
    .sort((a, b) => a.score - b.score)
    .slice(0, cfg.count)
    .map((row) => ({ ...row, side: -1 }));
  const bull = Number.isInteger(btcIndex) && btc.closes[btcIndex] >= btc.ema200[btcIndex];
  const longBudget = (bull ? cfg.allocation.bullLong : cfg.allocation.bearLong) * cfg.leverage;
  const shortBudget = (bull ? cfg.allocation.bullShort : cfg.allocation.bearShort) * cfg.leverage;
  return new Map([
    ...normalizeSide(longs, longBudget),
    ...normalizeSide(shorts, shortBudget),
  ].map((row) => [row.symbol, row.weight]));
}

function scaleWeights(weights, scale) {
  return new Map([...weights].map(([symbol, weight]) => [symbol, weight * scale]));
}

function simulate(dataset, times, cfg, startTime, endTime) {
  let equity = 1000;
  let peak = equity;
  let maxDrawdownPct = 0;
  let weights = new Map();
  let turnover = 0;
  let rebalances = 0;
  let activeBars = 0;
  let previousTime = null;
  let barsSinceRebalance = cfg.rebalanceBars;
  let riskScale = 1;
  let grossSum = 0;
  let grossSamples = 0;
  let momentumRebalances = 0;
  let reversalRebalances = 0;
  let idleRebalances = 0;
  const portfolioReturns = [];
  const barDuration = Math.max(1, times[1] - times[0]);
  const barsPerDay = DAY / barDuration;

  for (const time of times) {
    if (time < startTime || time > endTime) continue;
    if (previousTime != null) {
      let portfolioReturn = 0;
      for (const [symbol, weight] of weights) {
        const series = dataset.find((row) => row.symbol === symbol);
        const currentIndex = series?.maps.get(time);
        const previousIndex = series?.maps.get(previousTime);
        if (!Number.isInteger(currentIndex) || !Number.isInteger(previousIndex)) continue;
        portfolioReturn += weight * (series.closes[currentIndex] / series.closes[previousIndex] - 1);
      }
      equity *= Math.max(0, 1 + portfolioReturn);
      portfolioReturns.push(portfolioReturn);
      if (portfolioReturns.length > 160) portfolioReturns.shift();
      if (weights.size) activeBars += 1;
    }
    if (equity <= 0) break;

    barsSinceRebalance += 1;
    if (barsSinceRebalance >= cfg.rebalanceBars) {
      if (cfg.targetDailyVolPct && portfolioReturns.length >= 24) {
        const sample = portfolioReturns.slice(-Math.min(portfolioReturns.length, 80));
        const dailyVolPct = stddev(sample) * Math.sqrt(barsPerDay) * 100;
        if (Number.isFinite(dailyVolPct) && dailyVolPct > 0.05) {
          const desiredScale = riskScale * cfg.targetDailyVolPct / dailyVolPct;
          riskScale = Math.min(cfg.maxGross || 12, Math.max(0.25, riskScale * 0.7 + desiredScale * 0.3));
        }
      }

      let brake = 1;
      const drawdownPct = peak > 0 ? (peak - equity) / peak * 100 : 0;
      if (drawdownPct >= 35) brake *= 0.2;
      else if (drawdownPct >= 25) brake *= 0.4;
      else if (drawdownPct >= 15) brake *= 0.7;
      if (cfg.equityBrake && portfolioReturns.length >= cfg.equityBrake) {
        const recent = portfolioReturns.slice(-cfg.equityBrake);
        if (avg(recent) <= 0) brake *= cfg.riskOffScale ?? 0.35;
      }

      const informationCoefficient = rollingInformationCoefficient(dataset, time, cfg);
      const directionScale = !Number.isFinite(informationCoefficient) || Math.abs(informationCoefficient) < cfg.minAbsIc
        ? 0
        : (informationCoefficient >= 0 ? 1 : -1);
      if (directionScale > 0) momentumRebalances += 1;
      else if (directionScale < 0) reversalRebalances += 1;
      else idleRebalances += 1;
      const desired = directionScale === 0 ? new Map() : desiredWeights(dataset, time, cfg, directionScale);
      const nextWeights = scaleWeights(desired, riskScale * brake);
      const symbols = new Set([...weights.keys(), ...nextWeights.keys()]);
      const currentTurnover = [...symbols].reduce(
        (sum, symbol) => sum + Math.abs((nextWeights.get(symbol) || 0) - (weights.get(symbol) || 0)),
        0,
      );
      equity *= Math.max(0, 1 - currentTurnover * FEE_SLIP_RATE);
      turnover += currentTurnover;
      rebalances += 1;
      weights = nextWeights;
      barsSinceRebalance = 0;
      grossSum += [...weights.values()].reduce((sum, weight) => sum + Math.abs(weight), 0);
      grossSamples += 1;
    }

    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
    previousTime = time;
  }

  const days = Math.max(1, (endTime - startTime) / DAY);
  const totalReturnPct = (equity / 1000 - 1) * 100;
  const dailyPct = equity > 0 ? (Math.pow(equity / 1000, 1 / days) - 1) * 100 : -100;
  return {
    totalReturnPct: round(totalReturnPct),
    dailyPct: round(dailyPct),
    maxDrawdownPct: round(maxDrawdownPct),
    turnover: round(turnover, 2),
    rebalances,
    activeBars,
    avgGross: round(grossSamples ? grossSum / grossSamples : 0),
    momentumRebalances,
    reversalRebalances,
    idleRebalances,
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
  const newest = times.at(-1);
  const oldest = times[0];
  const windows = [];
  let end = newest;
  let index = 0;
  while (end - windowDays * DAY >= oldest) {
    windows.push({ windowIndex: index, startTime: end - windowDays * DAY, endTime: end });
    end -= windowDays * DAY;
    index += 1;
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
    periods.push({
      ...current,
      selectedConfig: chosen.item.config,
      training: chosen.training,
    });
  }
  return { summary: summarize(periods), periods };
}

function toMarkdown(report) {
  const lines = [
    "# Cross-Sectional Momentum Nested Walk-Forward",
    "",
    `Generated: ${report.generatedAt}`,
    `Universe: ${report.symbols.length} current liquid Binance USDT pairs`,
    `Interval: ${report.interval}; independent window: ${report.windowDays} days`,
    `Costs: 10 bps fee + 2 bps slippage per one-way turnover`,
    `Configurations: ${report.configurations}`,
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
    "## Best Fixed Configurations (diagnostic only)",
    "",
    "| Config | Avg Daily % | Median % | Positive % | Worst % | Avg DD % |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.fixed.slice(0, 20).map((row) => `| ${row.config.name} | ${row.summary.avgDailyPct} | ${row.summary.medianDailyPct} | ${row.summary.positivePct} | ${row.summary.worstDailyPct} | ${row.summary.avgMaxDrawdownPct} |`),
    "",
    "Current-liquid-symbol selection creates survivorship bias; nested results still require a future forward test.",
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
      if (candles.length >= 400) dataset.push(prepareSeries(symbol, candles));
      console.error(`loaded ${symbol}: ${candles.length}`);
    } catch (error) {
      console.error(`skip ${symbol}: ${error.message}`);
    }
  }
  const times = [...new Set(dataset.flatMap((series) => series.candles.map((row) => row.t)))].sort((a, b) => a - b);
  const windows = buildWindows(times, args.windowDays);
  const configs = buildConfigs(
    Boolean(args.regimeOnly),
    Boolean(args.consistencyOnly),
    Boolean(args.refineOnly),
    Boolean(args.flipOnly),
  );
  const configResults = [];
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index];
    const results = windows.map((window) => ({
      windowIndex: window.windowIndex,
      ...simulate(dataset, times, config, window.startTime, window.endTime),
    }));
    configResults.push({ config, windows: results });
    if ((index + 1) % 25 === 0 || index + 1 === configs.length) console.error(`tested ${index + 1}/${configs.length}`);
  }
  const nested = nestedWalkForward(configResults, windows, args.minTrainWindows);
  const fixed = configResults.map((item) => ({ config: item.config, summary: summarize(item.windows) }))
    .sort((a, b) => (b.summary.lowerConfidenceDailyPct ?? -Infinity) - (a.summary.lowerConfidenceDailyPct ?? -Infinity));
  const report = {
    generatedAt: new Date().toISOString(),
    interval: args.interval,
    days: args.days,
    windowDays: args.windowDays,
    minTrainWindows: args.minTrainWindows,
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
