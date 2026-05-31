#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_WF = path.join("data", "orphan_market_reader_wf_360_lev2.json");
const DEFAULT_GATE = path.join("data", "orphan_market_reader_profile_gate.json");
const DEFAULT_OUT = path.join("data", "orphan_market_reader_portfolio_optimizer.json");
const DEFAULT_MD = path.join("data", "orphan_market_reader_portfolio_optimizer.md");

function parseArgs(argv) {
  const args = {
    wf: DEFAULT_WF,
    gate: DEFAULT_GATE,
    output: DEFAULT_OUT,
    markdown: DEFAULT_MD,
    targetDailyPct: 0.8,
    minPrevDailyPct: 0,
  };

  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const [key, value = "true"] = raw.slice(2).split("=");
    if (key === "wf") args.wf = value;
    else if (key === "gate") args.gate = value;
    else if (key === "output") args.output = value;
    else if (key === "markdown") args.markdown = value;
    else if (key === "targetDailyPct") args.targetDailyPct = Number(value);
    else if (key === "minPrevDailyPct") args.minPrevDailyPct = Number(value);
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
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function profileKey(row) {
  return `${row.symbol}:${row.interval}`;
}

function dailyPct(row) {
  if (!row?.summary || !Number.isFinite(row.summary.totalReturnPct) || !Number.isFinite(row.windowDays)) {
    return null;
  }
  return (Math.pow(1 + row.summary.totalReturnPct / 100, 1 / row.windowDays) - 1) * 100;
}

function groupResults(results) {
  const byProfile = new Map();
  for (const row of results) {
    const key = profileKey(row);
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push({ ...row, dailyPct: dailyPct(row) });
  }
  for (const rows of byProfile.values()) rows.sort((a, b) => a.windowIndex - b.windowIndex);
  return byProfile;
}

function normalizeWeights(weightPairs, cap = 1) {
  let weights = weightPairs.map((row) => ({
    profile: row.profile,
    raw: Math.max(0, Number.isFinite(row.raw) ? row.raw : 0),
  }));

  if (!weights.length) return [];
  if (weights.every((row) => row.raw <= 0)) {
    weights = weights.map((row) => ({ ...row, raw: 1 }));
  }

  let remaining = weights.map((row) => ({ ...row, weight: 0, capped: false }));
  let budget = 1;

  while (remaining.some((row) => !row.capped) && budget > 1e-10) {
    const free = remaining.filter((row) => !row.capped);
    const freeRaw = free.reduce((sum, row) => sum + row.raw, 0) || free.length;
    let changed = false;

    for (const row of free) {
      const proposed = budget * ((row.raw || 1) / freeRaw);
      if (proposed > cap) {
        row.weight = cap;
        row.capped = true;
        budget -= cap;
        changed = true;
      }
    }

    if (!changed) {
      for (const row of free) {
        row.weight = budget * ((row.raw || 1) / freeRaw);
      }
      budget = 0;
    }
  }

  const total = remaining.reduce((sum, row) => sum + row.weight, 0) || 1;
  return remaining.map((row) => ({
    profile: row.profile,
    weight: row.weight / total,
  }));
}

function buildWeights(strategy, profiles, metrics) {
  if (strategy.type === "equal") {
    return normalizeWeights(profiles.map((profile) => ({ profile, raw: 1 })), strategy.cap);
  }

  if (strategy.type === "momentum") {
    return normalizeWeights(
      profiles.map((profile) => {
        const metric = metrics.get(profile);
        const daily = Math.max(0, metric?.dailyPct ?? 0);
        return { profile, raw: Math.pow(daily, strategy.power || 1) };
      }),
      strategy.cap,
    );
  }

  if (strategy.type === "riskAdjusted") {
    return normalizeWeights(
      profiles.map((profile) => {
        const metric = metrics.get(profile);
        const daily = Math.max(0, metric?.dailyPct ?? 0);
        const drawdown = Math.max(1, Math.abs(metric?.maxDrawdownPct ?? 10));
        return { profile, raw: Math.pow(daily / drawdown, strategy.power || 1) };
      }),
      strategy.cap,
    );
  }

  return normalizeWeights(profiles.map((profile) => ({ profile, raw: 1 })), strategy.cap);
}

function weightedDaily(weights, metrics) {
  return weights.reduce((sum, row) => {
    const daily = metrics.get(row.profile)?.dailyPct;
    return sum + row.weight * (Number.isFinite(daily) ? daily : 0);
  }, 0);
}

function simulateStrategy(strategy, candidateProfiles, byProfile, minPrevDailyPct) {
  const maxIndex = Math.max(...Array.from(byProfile.values()).flatMap((rows) => rows.map((row) => row.windowIndex)));
  const periods = [];

  for (let windowIndex = 0; windowIndex < maxIndex; windowIndex += 1) {
    const previousMetrics = new Map();
    const currentMetrics = new Map();
    const active = [];

    for (const profile of candidateProfiles) {
      const rows = byProfile.get(profile) || [];
      const current = rows.find((row) => row.windowIndex === windowIndex);
      const previous = rows.find((row) => row.windowIndex === windowIndex + 1);
      if (!current || !previous) continue;
      if (!Number.isFinite(previous.dailyPct) || previous.dailyPct < minPrevDailyPct) continue;
      active.push(profile);
      previousMetrics.set(profile, {
        dailyPct: previous.dailyPct,
        maxDrawdownPct: previous.summary?.maxDrawdownPct,
      });
      currentMetrics.set(profile, {
        dailyPct: current.dailyPct,
        maxDrawdownPct: current.summary?.maxDrawdownPct,
      });
    }

    if (!active.length) continue;

    const weights = buildWeights(strategy, active, previousMetrics);
    periods.push({
      windowIndex,
      activeProfiles: active.length,
      dailyPct: weightedDaily(weights, currentMetrics),
      weights,
    });
  }

  const dailyValues = periods.map((period) => period.dailyPct).filter(Number.isFinite);
  return {
    periods: periods.length,
    positivePeriods: dailyValues.filter((value) => value > 0).length,
    avgDailyPct: round(avg(dailyValues)),
    medianDailyPct: round(median(dailyValues)),
    worstDailyPct: dailyValues.length ? round(Math.min(...dailyValues)) : null,
    bestDailyPct: dailyValues.length ? round(Math.max(...dailyValues)) : null,
    periodsDetail: periods.map((period) => ({
      ...period,
      dailyPct: round(period.dailyPct),
      weights: period.weights.map((row) => ({ ...row, weight: round(row.weight, 4) })),
    })),
  };
}

function latestPlan(strategy, activeProfiles, byProfile, targetDailyPct) {
  const latestMetrics = new Map();
  for (const profile of activeProfiles) {
    const latest = (byProfile.get(profile) || []).find((row) => row.windowIndex === 0);
    if (!latest) continue;
    latestMetrics.set(profile, {
      dailyPct: latest.dailyPct,
      maxDrawdownPct: latest.summary?.maxDrawdownPct,
    });
  }

  const weights = buildWeights(strategy, activeProfiles, latestMetrics);
  const expectedDailyPct = weightedDaily(weights, latestMetrics);
  return {
    expectedDailyPct: round(expectedDailyPct),
    targetDailyPct,
    targetMultiplier: expectedDailyPct > 0 ? round(targetDailyPct / expectedDailyPct, 3) : null,
    weights: weights.map((row) => {
      const metric = latestMetrics.get(row.profile);
      return {
        ...row,
        weight: round(row.weight, 4),
        latestDailyPct: round(metric?.dailyPct),
      };
    }),
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Orphan Market Reader Portfolio Optimizer");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target Daily %: ${report.targetDailyPct}`);
  lines.push(`Active Profiles: ${report.activeProfiles.join(", ")}`);
  lines.push("");
  lines.push("## Strategy Comparison");
  lines.push("");
  lines.push("| Plan | Latest Expected Daily % | Target Multiplier | WF Avg Daily % | WF Median Daily % | WF Worst Daily % | WF Best Daily % | Positive Periods |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of report.plans) {
    lines.push(`| ${row.name} | ${row.latest.expectedDailyPct} | ${row.latest.targetMultiplier} | ${row.simulation.avgDailyPct} | ${row.simulation.medianDailyPct} | ${row.simulation.worstDailyPct} | ${row.simulation.bestDailyPct} | ${row.simulation.positivePeriods}/${row.simulation.periods} |`);
  }
  lines.push("");
  lines.push("## Recommended Plan");
  lines.push("");
  lines.push(`Plan: ${report.recommended.name}`);
  lines.push("");
  lines.push("| Profile | Weight % | Latest Daily % | Weighted Daily Contribution % |");
  lines.push("|---|---:|---:|---:|");
  for (const row of report.recommended.latest.weights) {
    lines.push(`| ${row.profile} | ${round(row.weight * 100, 2)} | ${row.latestDailyPct} | ${round(row.weight * row.latestDailyPct)} |`);
  }
  lines.push("");
  lines.push(`Latest expected daily: ${report.recommended.latest.expectedDailyPct}%`);
  lines.push(`Multiplier needed for ${report.targetDailyPct}% daily: ${report.recommended.latest.targetMultiplier}x over this test profile.`);
  lines.push("");
  lines.push("## Allocation Draft");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.recommendedAllocation, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("Note: The multiplier is a risk estimate, not a recommendation. Higher leverage magnifies stop losses and drawdowns.");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const wf = JSON.parse(fs.readFileSync(path.resolve(args.wf), "utf8"));
  const gate = JSON.parse(fs.readFileSync(path.resolve(args.gate), "utf8"));
  const byProfile = groupResults(wf.results || []);
  const activeProfiles = (gate.activeProfiles || []).map((row) => row.profile);
  const candidateProfiles = (gate.candidates || []).map((row) => row.profile);

  const strategies = [
    { name: "Equal active profiles", type: "equal", cap: 1 },
    { name: "Momentum cap 40%", type: "momentum", power: 1, cap: 0.4 },
    { name: "Momentum cap 50%", type: "momentum", power: 1, cap: 0.5 },
    { name: "Momentum cap 60%", type: "momentum", power: 1, cap: 0.6 },
    { name: "Momentum cap 70%", type: "momentum", power: 1, cap: 0.7 },
    { name: "Momentum squared cap 70%", type: "momentum", power: 2, cap: 0.7 },
    { name: "Risk-adjusted cap 60%", type: "riskAdjusted", power: 1, cap: 0.6 },
  ];

  const plans = strategies.map((strategy) => ({
    name: strategy.name,
    strategy,
    latest: latestPlan(strategy, activeProfiles, byProfile, args.targetDailyPct),
    simulation: simulateStrategy(strategy, candidateProfiles, byProfile, args.minPrevDailyPct),
  }));

  const recommended = [...plans].sort((a, b) => {
    const worstDiff = (b.simulation.worstDailyPct ?? -Infinity) - (a.simulation.worstDailyPct ?? -Infinity);
    if (Math.abs(worstDiff) > 0.0001) return worstDiff;
    return (b.latest.expectedDailyPct ?? -Infinity) - (a.latest.expectedDailyPct ?? -Infinity);
  })[0];

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      walkForward: args.wf,
      gate: args.gate,
    },
    targetDailyPct: args.targetDailyPct,
    activeProfiles,
    candidateProfiles,
    baseParams: wf.params || {},
    plans,
    recommended,
    recommendedAllocation: {
      strategy: "orphan_market_reader",
      plan: recommended.name,
      leverage: wf.params?.leverage ?? null,
      max_position_pct: wf.params?.max_position_pct ?? null,
      expectedDailyPct: recommended.latest.expectedDailyPct,
      walkForwardAvgDailyPct: recommended.simulation.avgDailyPct,
      walkForwardMedianDailyPct: recommended.simulation.medianDailyPct,
      walkForwardWorstDailyPct: recommended.simulation.worstDailyPct,
      profiles: recommended.latest.weights.map((row) => {
        const [symbol, interval] = row.profile.split(":");
        return {
          symbol,
          interval,
          capital_weight_pct: round(row.weight * 100, 2),
          latest_daily_pct: row.latestDailyPct,
        };
      }),
    },
  };

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));

  console.log(`Portfolio optimizer written: ${args.output}`);
  console.log(`Markdown report written: ${args.markdown}`);
  console.log(`Recommended: ${recommended.name}, latest daily=${recommended.latest.expectedDailyPct}%`);
}

main();
