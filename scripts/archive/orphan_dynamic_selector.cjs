#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: path.join("data", "orphan_futures_top24_1h_lev2_20260618.json"),
    output: path.join("data", "orphan_dynamic_selector.json"),
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
      trades: row.summary?.trades || 0,
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
        if (historical) history.push(historical.daily);
      }
      if (history.length < cfg.lookback) continue;
      const mean = avg(history);
      const positiveRate = history.filter((value) => value > 0).length / history.length;
      if (mean >= cfg.minAvg && positiveRate >= cfg.minPos) {
        candidates.push({ profile, score: mean, positiveRate });
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.positiveRate - a.positiveRate);
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
    medianDaily: values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null,
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
    for (const count of [1, 2, 3, 4, 5]) {
      for (const minAvg of [-0.05, 0, 0.03, 0.06, 0.1]) {
        for (const minPos of [0.5, 0.67, 1]) {
          configs.push({ lookback, count, minAvg, minPos });
        }
      }
    }
  }
  const rows = configs
    .map((config) => simulate(byProfile, config))
    .filter((row) => row.periods >= 3)
    .sort((a, b) => b.avgDaily - a.avgDaily || b.medianDaily - a.medianDaily);

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(rows.slice(0, 50), null, 2)}\n`);
  console.table(rows.slice(0, 25).map((row) => ({
    lookback: row.lookback,
    count: row.count,
    minAvg: row.minAvg,
    minPos: row.minPos,
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
