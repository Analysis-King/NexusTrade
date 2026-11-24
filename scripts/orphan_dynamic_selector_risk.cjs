#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: path.join("data", "orphan_futures_mature12_abcd_long_1h_lev2_20260618.json"),
    output: path.join("data", "orphan_dynamic_selector_risk.json"),
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const [key, value = "true"] = raw.slice(2).split("=");
    if (key in args) args[key] = value;
  }
  return args;
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function dailyPct(row) {
  const ret = row.summary?.totalReturnPct;
  if (!row.windowDays || !Number.isFinite(ret)) return null;
  return (Math.pow(1 + ret / 100, 1 / row.windowDays) - 1) * 100;
}

function buildProfileMap(report) {
  const byProfile = new Map();
  for (const row of report.results || []) {
    const daily = dailyPct(row);
    if (!Number.isFinite(daily)) continue;
    const profile = `${row.symbol}:${row.interval}`;
    if (!byProfile.has(profile)) byProfile.set(profile, new Map());
    byProfile.get(profile).set(row.windowIndex, {
      daily,
      trades: row.summary?.totalTrades || 0,
      drawdown: row.summary?.maxDrawdownPct || 0,
    });
  }
  return byProfile;
}

function simulate(byProfile, cfg) {
  const maxWindow = Math.max(...[...byProfile.values()].flatMap((rows) => [...rows.keys()]));
  const periods = [];
  for (let windowIndex = 0; windowIndex < maxWindow; windowIndex += 1) {
    const candidates = [];
    for (const [profile, rows] of byProfile) {
      const history = [];
      for (let offset = 1; offset <= cfg.lookback; offset += 1) {
        const historical = rows.get(windowIndex + offset);
        if (historical) history.push(historical);
      }
      if (history.length < cfg.lookback) continue;
      const dailyValues = history.map((item) => item.daily);
      const drawdowns = history.map((item) => item.drawdown);
      const trades = history.map((item) => item.trades);
      const mean = avg(dailyValues);
      const worst = Math.min(...dailyValues);
      const positiveRate = dailyValues.filter((value) => value > 0).length / dailyValues.length;
      const avgDrawdown = avg(drawdowns);
      const totalTrades = trades.reduce((sum, value) => sum + value, 0);
      if (
        mean >= cfg.minAvg &&
        worst >= cfg.minWorst &&
        positiveRate >= cfg.minPos &&
        avgDrawdown <= cfg.maxAvgDrawdown &&
        totalTrades >= cfg.minTrades
      ) {
        const score = mean - avgDrawdown * cfg.drawdownPenalty + worst * cfg.worstWeight;
        candidates.push({ profile, score, mean, worst, positiveRate, avgDrawdown });
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.mean - a.mean || b.positiveRate - a.positiveRate);
    const selected = candidates
      .slice(0, cfg.count)
      .filter((candidate) => byProfile.get(candidate.profile).has(windowIndex));
    if (!selected.length) continue;
    periods.push({
      windowIndex,
      daily: avg(selected.map((candidate) => byProfile.get(candidate.profile).get(windowIndex).daily)),
      selected: selected.map((candidate) => candidate.profile),
    });
  }
  const values = periods.map((period) => period.daily);
  return {
    ...cfg,
    periods: periods.length,
    avgDaily: avg(values),
    medianDaily: median(values),
    worstDaily: values.length ? Math.min(...values) : null,
    bestDaily: values.length ? Math.max(...values) : null,
    positivePeriods: values.filter((value) => value > 0).length,
    periodsDetail: periods,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const report = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
  const byProfile = buildProfileMap(report);
  const configs = [];
  for (const lookback of [1, 2, 3, 4]) {
    for (const count of [1, 2, 3]) {
      for (const minAvg of [-0.03, 0, 0.03, 0.06, 0.1, 0.2]) {
        for (const minWorst of [-1.0, -0.5, -0.25, -0.1, 0]) {
          for (const minPos of [0.5, 0.67, 1]) {
            for (const maxAvgDrawdown of [20, 35, 50]) {
              for (const drawdownPenalty of [0, 0.005, 0.01, 0.02]) {
                for (const worstWeight of [0, 0.25, 0.5]) {
                  configs.push({
                    lookback,
                    count,
                    minAvg,
                    minWorst,
                    minPos,
                    maxAvgDrawdown,
                    minTrades: 1,
                    drawdownPenalty,
                    worstWeight,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  const rows = configs
    .map((config) => simulate(byProfile, config))
    .filter((row) => row.periods >= 3)
    .sort((a, b) =>
      b.avgDaily - a.avgDaily ||
      b.medianDaily - a.medianDaily ||
      b.worstDaily - a.worstDaily
    );

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(rows.slice(0, 100), null, 2)}\n`);
  console.table(rows.slice(0, 30).map((row) => ({
    lookback: row.lookback,
    count: row.count,
    minAvg: row.minAvg,
    minWorst: row.minWorst,
    minPos: row.minPos,
    maxDD: row.maxAvgDrawdown,
    ddPen: row.drawdownPenalty,
    worstW: row.worstWeight,
    periods: row.periods,
    avg: Number(row.avgDaily.toFixed(4)),
    median: Number(row.medianDaily.toFixed(4)),
    worst: Number(row.worstDaily.toFixed(4)),
    best: Number(row.bestDaily.toFixed(4)),
    positive: `${row.positivePeriods}/${row.periods}`,
  })));
  console.log(`Report: ${path.resolve(args.output)}`);
}

main();
