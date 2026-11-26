#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    inputs: "",
    output: path.join("data", "strategy_portfolio_blend.json"),
    markdown: path.join("data", "strategy_portfolio_blend.md"),
    minHistoryWindows: 2,
    minPositivePct: 55,
    minHistoryAvgDailyPct: 0,
    minPrevDailyPct: 0,
    minHistoryTrades: 10,
    maxHistoryAvgDrawdownPct: 1000000,
    maxPrevDrawdownPct: 1000000,
    maxProfilesPerStrategy: 5,
    profileCap: 0.4,
    targetDailyPct: 0.8,
  };

  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const option = raw.slice(2);
    const separator = option.indexOf("=");
    const key = separator >= 0 ? option.slice(0, separator) : option;
    const value = separator >= 0 ? option.slice(separator + 1) : "true";
    if (key in args) args[key] = key === "inputs" || key === "output" || key === "markdown" ? value : Number(value);
  }
  return args;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const mult = 10 ** digits;
  return Math.round(value * mult) / mult;
}

function avg(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function stddev(values) {
  const mean = avg(values);
  if (!Number.isFinite(mean)) return null;
  return Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
}

function strategyId(report) {
  const file = String(report.strategyFile || "strategy.py");
  return path.basename(file, path.extname(file));
}

function profileId(strategy, row) {
  return `${strategy}|${row.symbol}:${row.interval}`;
}

function dailyPct(row) {
  const totalReturnPct = row?.summary?.totalReturnPct;
  if (!Number.isFinite(totalReturnPct) || !Number.isFinite(row.windowDays) || totalReturnPct <= -100) return null;
  return (Math.pow(1 + totalReturnPct / 100, 1 / row.windowDays) - 1) * 100;
}

function loadInputs(args) {
  const files = String(args.inputs).split(",").map((item) => item.trim()).filter(Boolean);
  if (files.length < 1) throw new Error("--inputs requires at least one walk-forward JSON report");

  return files.map((input) => {
    const separator = input.indexOf("=");
    const alias = separator > 0 ? input.slice(0, separator).trim() : "";
    const file = separator > 0 ? input.slice(separator + 1).trim() : input;
    const resolved = path.resolve(file);
    const report = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return {
      file: path.relative(process.cwd(), resolved),
      strategy: alias || strategyId(report),
      report,
    };
  });
}

function buildProfiles(inputs) {
  const profiles = new Map();
  for (const input of inputs) {
    for (const result of input.report.results || []) {
      if (result.error) continue;
      const id = profileId(input.strategy, result);
      if (!profiles.has(id)) {
        profiles.set(id, {
          id,
          strategy: input.strategy,
          symbol: result.symbol,
          interval: result.interval,
          windows: [],
        });
      }
      profiles.get(id).windows.push({ ...result, dailyPct: dailyPct(result) });
    }
  }
  for (const profile of profiles.values()) {
    profile.windows.sort((a, b) => a.windowIndex - b.windowIndex);
  }
  return profiles;
}

function summarizeHistory(windows) {
  const daily = windows.map((row) => row.dailyPct).filter(Number.isFinite);
  return {
    windows: daily.length,
    avgDailyPct: avg(daily),
    medianDailyPct: median(daily),
    positivePct: daily.length ? (daily.filter((value) => value > 0).length / daily.length) * 100 : null,
    worstDailyPct: daily.length ? Math.min(...daily) : null,
    avgMaxDrawdownPct: avg(windows.map((row) => row.summary?.maxDrawdownPct)),
    trades: windows.reduce((sum, row) => sum + Number(row.summary?.totalTrades || 0), 0),
  };
}

function eligibleRows(profiles, windowIndex, args, latest = false) {
  const candidates = [];
  for (const profile of profiles.values()) {
    const current = latest ? null : profile.windows.find((row) => row.windowIndex === windowIndex);
    const previous = latest
      ? profile.windows.find((row) => row.windowIndex === 0)
      : profile.windows.find((row) => row.windowIndex === windowIndex + 1);
    const history = latest
      ? profile.windows
      : profile.windows.filter((row) => row.windowIndex > windowIndex);
    const summary = summarizeHistory(history);

    if ((!latest && !current) || !previous) continue;
    if (summary.windows < args.minHistoryWindows) continue;
    if (!Number.isFinite(summary.positivePct) || summary.positivePct < args.minPositivePct) continue;
    if (!Number.isFinite(summary.avgDailyPct) || summary.avgDailyPct < args.minHistoryAvgDailyPct) continue;
    if (summary.trades < args.minHistoryTrades) continue;
    if (!Number.isFinite(summary.avgMaxDrawdownPct) || summary.avgMaxDrawdownPct > args.maxHistoryAvgDrawdownPct) continue;
    if (!Number.isFinite(previous.dailyPct) || previous.dailyPct < args.minPrevDailyPct) continue;
    if (Number(previous.summary?.maxDrawdownPct || 0) > args.maxPrevDrawdownPct) continue;

    candidates.push({
      ...profile,
      current,
      previous,
      history: summary,
    });
  }

  const byStrategy = new Map();
  for (const row of candidates) {
    if (!byStrategy.has(row.strategy)) byStrategy.set(row.strategy, []);
    byStrategy.get(row.strategy).push(row);
  }

  return Array.from(byStrategy.values()).flatMap((rows) => rows
    .sort((a, b) => b.history.avgDailyPct - a.history.avgDailyPct)
    .slice(0, args.maxProfilesPerStrategy));
}

function cappedNormalize(weightRows, cap) {
  const rows = weightRows.map((row) => ({ ...row, weight: 0, raw: Math.max(0, row.raw || 0), capped: false }));
  if (!rows.length) return [];
  if (rows.every((row) => row.raw === 0)) rows.forEach((row) => { row.raw = 1; });

  let budget = 1;
  while (budget > 1e-10 && rows.some((row) => !row.capped)) {
    const free = rows.filter((row) => !row.capped);
    const rawTotal = free.reduce((sum, row) => sum + row.raw, 0) || free.length;
    let cappedAny = false;
    for (const row of free) {
      const proposed = budget * ((row.raw || 1) / rawTotal);
      if (proposed > cap) {
        row.weight = cap;
        row.capped = true;
        budget -= cap;
        cappedAny = true;
      }
    }
    if (!cappedAny) {
      for (const row of free) row.weight = budget * ((row.raw || 1) / rawTotal);
      budget = 0;
    }
  }

  return rows.map(({ capped, raw, ...row }) => row);
}

function strategyEqualWeights(active, innerMetric, cap) {
  const byStrategy = new Map();
  for (const row of active) {
    if (!byStrategy.has(row.strategy)) byStrategy.set(row.strategy, []);
    byStrategy.get(row.strategy).push(row);
  }
  const strategyCount = byStrategy.size;
  const weights = [];
  for (const rows of byStrategy.values()) {
    const rawTotal = rows.reduce((sum, row) => sum + Math.max(0, innerMetric(row)), 0) || rows.length;
    for (const row of rows) {
      weights.push({
        id: row.id,
        raw: (1 / strategyCount) * ((Math.max(0, innerMetric(row)) || 1) / rawTotal),
      });
    }
  }
  return cappedNormalize(weights, cap);
}

function topStrategyMomentumWeights(active, cap, strategyLimit) {
  const byStrategy = new Map();
  for (const row of active) {
    if (!byStrategy.has(row.strategy)) byStrategy.set(row.strategy, []);
    byStrategy.get(row.strategy).push(row);
  }
  const selected = [...byStrategy.entries()]
    .map(([strategy, rows]) => ({
      strategy,
      rows,
      score: avg(rows.map((row) => Math.max(0, row.previous.dailyPct))),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, strategyLimit);

  if (strategyLimit === 1) {
    return cappedNormalize(
      (selected[0]?.rows || []).map((row) => ({ id: row.id, raw: Math.max(0, row.previous.dailyPct) })),
      cap,
    );
  }

  const weights = [];
  for (const sleeve of selected) {
    const rawTotal = sleeve.rows.reduce((sum, row) => sum + Math.max(0, row.previous.dailyPct), 0)
      || sleeve.rows.length;
    for (const row of sleeve.rows) {
      weights.push({
        id: row.id,
        raw: (1 / selected.length) * ((Math.max(0, row.previous.dailyPct) || 1) / rawTotal),
      });
    }
  }
  return cappedNormalize(weights, cap);
}

function weightsFor(plan, active, cap) {
  if (plan === "Equal profiles") {
    return cappedNormalize(active.map((row) => ({ id: row.id, raw: 1 })), cap);
  }
  if (plan === "Previous momentum") {
    return cappedNormalize(active.map((row) => ({ id: row.id, raw: Math.max(0, row.previous.dailyPct) })), cap);
  }
  if (plan === "Historical robust") {
    return cappedNormalize(active.map((row) => ({
      id: row.id,
      raw: Math.max(0, row.history.avgDailyPct) * (row.history.positivePct / 100)
        / Math.max(1, Math.abs(row.history.avgMaxDrawdownPct || 1)),
    })), cap);
  }
  if (plan === "Equal strategy sleeves") {
    return strategyEqualWeights(active, () => 1, cap);
  }
  if (plan === "Equal sleeves + momentum") {
    return strategyEqualWeights(active, (row) => Math.max(0, row.previous.dailyPct), cap);
  }
  if (plan === "Top strategy momentum") {
    return topStrategyMomentumWeights(active, cap, 1);
  }
  if (plan === "Top 2 strategy momentum") {
    return topStrategyMomentumWeights(active, cap, 2);
  }
  return strategyEqualWeights(active, (row) => Math.max(0, row.history.avgDailyPct), cap);
}

function evaluatePlan(plan, profiles, args) {
  const maxIndex = Math.max(...Array.from(profiles.values()).flatMap((profile) => profile.windows.map((row) => row.windowIndex)));
  const periods = [];
  for (let windowIndex = maxIndex - 1; windowIndex >= 0; windowIndex -= 1) {
    const active = eligibleRows(profiles, windowIndex, args);
    if (!active.length) continue;
    const weights = weightsFor(plan, active, args.profileCap);
    const activeMap = new Map(active.map((row) => [row.id, row]));
    const daily = weights.reduce((sum, row) => sum + row.weight * (activeMap.get(row.id)?.current?.dailyPct || 0), 0);
    const estimatedMaxDrawdownPct = weights.reduce(
      (sum, row) => sum + row.weight * Number(activeMap.get(row.id)?.current?.summary?.maxDrawdownPct || 0),
      0,
    );
    periods.push({
      windowIndex,
      dailyPct: round(daily),
      estimatedMaxDrawdownPct: round(estimatedMaxDrawdownPct),
      profiles: weights.map((row) => ({
        id: row.id,
        weight: round(row.weight, 4),
        previousDailyPct: round(activeMap.get(row.id)?.previous?.dailyPct),
        currentDailyPct: round(activeMap.get(row.id)?.current?.dailyPct),
        currentMaxDrawdownPct: round(activeMap.get(row.id)?.current?.summary?.maxDrawdownPct),
        currentTotalReturnPct: round(activeMap.get(row.id)?.current?.summary?.totalReturnPct),
        currentTrades: Number(activeMap.get(row.id)?.current?.summary?.totalTrades || 0),
      })),
    });
  }

  const values = periods.map((row) => row.dailyPct).filter(Number.isFinite);
  return {
    periods: periods.length,
    positivePeriods: values.filter((value) => value > 0).length,
    avgDailyPct: round(avg(values)),
    medianDailyPct: round(median(values)),
    worstDailyPct: values.length ? round(Math.min(...values)) : null,
    bestDailyPct: values.length ? round(Math.max(...values)) : null,
    stdDevDailyPct: round(stddev(values)),
    periodsDetail: periods,
  };
}

function latestAllocation(plan, profiles, args) {
  const active = eligibleRows(profiles, 0, args, true);
  const activeMap = new Map(active.map((row) => [row.id, row]));
  const weights = weightsFor(plan, active, args.profileCap);
  const expectedDailyPct = weights.reduce((sum, row) => sum + row.weight * (activeMap.get(row.id)?.previous?.dailyPct || 0), 0);
  return {
    expectedDailyPct: round(expectedDailyPct),
    targetMultiplier: expectedDailyPct > 0 ? round(args.targetDailyPct / expectedDailyPct, 3) : null,
    profiles: weights.map((row) => {
      const activeRow = activeMap.get(row.id);
      return {
        id: row.id,
        strategy: activeRow.strategy,
        symbol: activeRow.symbol,
        interval: activeRow.interval,
        capitalWeightPct: round(row.weight * 100, 2),
        latestDailyPct: round(activeRow.previous.dailyPct),
        historyAvgDailyPct: round(activeRow.history.avgDailyPct),
        historyPositivePct: round(activeRow.history.positivePct, 2),
        historyAvgMaxDrawdownPct: round(activeRow.history.avgMaxDrawdownPct),
      };
    }),
  };
}

function toMarkdown(report) {
  const lines = [
    "# Multi-Strategy Portfolio Blend",
    "",
    `Generated: ${report.generatedAt}`,
    `Sources: ${report.sources.map((row) => `${row.strategy} (${row.file})`).join(", ")}`,
    `Strict rule: every tested period is selected using older windows only; minimum ${report.rule.minHistoryWindows} history windows.`,
    "",
    "## Plan Comparison",
    "",
    "| Plan | Periods | Positive | Avg Daily % | Median Daily % | Worst Daily % | Best Daily % | Std Dev % | Latest Expected % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of report.plans) {
    lines.push(`| ${row.name} | ${row.simulation.periods} | ${row.simulation.positivePeriods}/${row.simulation.periods} | ${row.simulation.avgDailyPct} | ${row.simulation.medianDailyPct} | ${row.simulation.worstDailyPct} | ${row.simulation.bestDailyPct} | ${row.simulation.stdDevDailyPct} | ${row.latest.expectedDailyPct} |`);
  }
  lines.push("", "## Recommended", "", `Plan: ${report.recommended.name}`, "");
  lines.push("| Strategy | Profile | Weight % | Latest Daily % | History Avg Daily % | Positive History % |");
  lines.push("|---|---|---:|---:|---:|---:|");
  for (const row of report.recommended.latest.profiles) {
    lines.push(`| ${row.strategy} | ${row.symbol}:${row.interval} | ${row.capitalWeightPct} | ${row.latestDailyPct} | ${row.historyAvgDailyPct} | ${row.historyPositivePct} |`);
  }
  lines.push("", `Latest expected daily: ${report.recommended.latest.expectedDailyPct}%`);
  lines.push(`Multiplier required for ${report.targetDailyPct}% daily: ${report.recommended.latest.targetMultiplier}x.`);
  lines.push("", "Note: This is a strict walk-forward research estimate, not a profit guarantee.", "");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const inputs = loadInputs(args);
  const profiles = buildProfiles(inputs);
  const planNames = [
    "Equal profiles",
    "Previous momentum",
    "Historical robust",
    "Equal strategy sleeves",
    "Equal sleeves + momentum",
    "Equal sleeves + historical",
    "Top strategy momentum",
    "Top 2 strategy momentum",
  ];
  const plans = planNames.map((name) => ({
    name,
    simulation: evaluatePlan(name, profiles, args),
    latest: latestAllocation(name, profiles, args),
  }));
  const recommended = [...plans].sort((a, b) => {
    const worst = (b.simulation.worstDailyPct ?? -Infinity) - (a.simulation.worstDailyPct ?? -Infinity);
    if (Math.abs(worst) > 0.0001) return worst;
    return (b.simulation.avgDailyPct ?? -Infinity) - (a.simulation.avgDailyPct ?? -Infinity);
  })[0];

  const report = {
    generatedAt: new Date().toISOString(),
    sources: inputs.map((input) => ({ strategy: input.strategy, file: input.file })),
    targetDailyPct: args.targetDailyPct,
    rule: {
      minHistoryWindows: args.minHistoryWindows,
      minPositivePct: args.minPositivePct,
      minHistoryAvgDailyPct: args.minHistoryAvgDailyPct,
      minPrevDailyPct: args.minPrevDailyPct,
      minHistoryTrades: args.minHistoryTrades,
      maxHistoryAvgDrawdownPct: args.maxHistoryAvgDrawdownPct,
      maxPrevDrawdownPct: args.maxPrevDrawdownPct,
      maxProfilesPerStrategy: args.maxProfilesPerStrategy,
      profileCap: args.profileCap,
    },
    plans,
    recommended,
  };

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.log(`Blend report written: ${args.output}`);
  console.log(`Recommended: ${recommended.name}, WF avg=${recommended.simulation.avgDailyPct}%, worst=${recommended.simulation.worstDailyPct}%`);
}

if (require.main === module) main();

module.exports = {
  avg,
  buildProfiles,
  evaluatePlan,
  latestAllocation,
  loadInputs,
  median,
  round,
  stddev,
};
