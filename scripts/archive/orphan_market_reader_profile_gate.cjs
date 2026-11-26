#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_INPUT = path.join("data", "orphan_market_reader_wf_360_lev2.json");
const DEFAULT_OUTPUT = path.join("data", "orphan_market_reader_profile_gate.json");
const DEFAULT_MARKDOWN = path.join("data", "orphan_market_reader_profile_gate.md");

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    markdown: DEFAULT_MARKDOWN,
    maxProfiles: 5,
    minPositivePct: 50,
    minPrevDailyPct: 0,
    minLatestDailyPct: 0,
  };

  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const [key, value = "true"] = raw.slice(2).split("=");
    if (key === "input") args.input = value;
    else if (key === "output") args.output = value;
    else if (key === "markdown") args.markdown = value;
    else if (key === "maxProfiles") args.maxProfiles = Number(value);
    else if (key === "minPositivePct") args.minPositivePct = Number(value);
    else if (key === "minPrevDailyPct") args.minPrevDailyPct = Number(value);
    else if (key === "minLatestDailyPct") args.minLatestDailyPct = Number(value);
  }

  return args;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const mult = 10 ** digits;
  return Math.round(value * mult) / mult;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function profileKey(row) {
  return `${row.symbol}:${row.interval}`;
}

function strategyId(walkForward) {
  const file = String(walkForward.strategyFile || "orphan_market_reader.py");
  return path.basename(file, path.extname(file));
}

function dailyPct(row) {
  if (!row || !row.summary || !Number.isFinite(row.summary.totalReturnPct) || !Number.isFinite(row.windowDays)) {
    return null;
  }
  return (Math.pow(1 + row.summary.totalReturnPct / 100, 1 / row.windowDays) - 1) * 100;
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function groupResults(results) {
  const byProfile = new Map();
  for (const row of results) {
    const key = profileKey(row);
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push({ ...row, dailyPct: dailyPct(row) });
  }

  for (const rows of byProfile.values()) {
    rows.sort((a, b) => a.windowIndex - b.windowIndex);
  }

  return byProfile;
}

function findSummary(aggregate, key) {
  return aggregate?.profiles?.find((row) => row.profile === key) || null;
}

function selectCandidateProfiles(walkForward, args, byProfile) {
  const rows = Array.from(byProfile.keys()).map((key) => {
    const profileSummary = findSummary(walkForward.aggregate, key);
    const windows = byProfile.get(key);
    const latest = windows.find((row) => row.windowIndex === 0) || windows[0] || null;
    const previous = windows.find((row) => row.windowIndex === 1) || null;
    return {
      profile: key,
      symbol: latest?.symbol || key.split(":")[0],
      interval: latest?.interval || key.split(":")[1],
      avgDailyPct: profileSummary?.avgDailyPct ?? avg(windows.map((row) => row.dailyPct)),
      medianDailyPct: profileSummary?.medianDailyPct ?? median(windows.map((row) => row.dailyPct)),
      positivePct: profileSummary?.positivePct ?? null,
      worstDailyPct: profileSummary?.worstDailyPct ?? Math.min(...windows.map((row) => row.dailyPct).filter(Number.isFinite)),
      bestDailyPct: profileSummary?.bestDailyPct ?? Math.max(...windows.map((row) => row.dailyPct).filter(Number.isFinite)),
      avgMaxDrawdownPct: profileSummary?.avgMaxDrawdownPct ?? avg(windows.map((row) => row.summary?.maxDrawdownPct)),
      totalTrades: profileSummary?.totalTrades ?? windows.reduce((sum, row) => sum + (row.summary?.totalTrades || 0), 0),
      latestDailyPct: latest?.dailyPct ?? null,
      latestReturnPct: latest?.summary?.totalReturnPct ?? null,
      latestWindow: latest ? `${formatDate(latest.startMs)} - ${formatDate(latest.endMs)}` : "",
      previousDailyPct: previous?.dailyPct ?? null,
      previousReturnPct: previous?.summary?.totalReturnPct ?? null,
    };
  });

  return rows
    .filter((row) => row.positivePct === null || row.positivePct >= args.minPositivePct)
    .sort((a, b) => {
      const avgDiff = (b.avgDailyPct ?? -Infinity) - (a.avgDailyPct ?? -Infinity);
      if (avgDiff !== 0) return avgDiff;
      return (b.medianDailyPct ?? -Infinity) - (a.medianDailyPct ?? -Infinity);
    })
    .slice(0, args.maxProfiles);
}

function selectActiveProfiles(candidates, args) {
  return candidates.filter((row) => {
    const latestOk = Number.isFinite(row.latestDailyPct) && row.latestDailyPct >= args.minLatestDailyPct;
    const prevOk = row.previousDailyPct === null || row.previousDailyPct >= args.minPrevDailyPct;
    return latestOk && prevOk;
  });
}

function simulateGate(byProfile, candidates, args) {
  const candidateKeys = new Set(candidates.map((row) => row.profile));
  const maxIndex = Math.max(...Array.from(byProfile.values()).flatMap((rows) => rows.map((row) => row.windowIndex)));
  const periods = [];

  for (let windowIndex = 0; windowIndex < maxIndex; windowIndex += 1) {
    const active = [];
    for (const [key, rows] of byProfile.entries()) {
      if (!candidateKeys.has(key)) continue;
      const current = rows.find((row) => row.windowIndex === windowIndex);
      const previous = rows.find((row) => row.windowIndex === windowIndex + 1);
      if (!current || !previous) continue;
      if (!Number.isFinite(previous.dailyPct) || previous.dailyPct < args.minPrevDailyPct) continue;
      active.push({
        profile: key,
        dailyPct: current.dailyPct,
        returnPct: current.summary?.totalReturnPct ?? null,
        maxDrawdownPct: current.summary?.maxDrawdownPct ?? null,
        trades: current.summary?.totalTrades ?? 0,
        window: `${formatDate(current.startMs)} - ${formatDate(current.endMs)}`,
      });
    }

    if (!active.length) continue;
    periods.push({
      windowIndex,
      activeProfiles: active.length,
      avgDailyPct: avg(active.map((row) => row.dailyPct)),
      avgReturnPct: avg(active.map((row) => row.returnPct)),
      avgMaxDrawdownPct: avg(active.map((row) => row.maxDrawdownPct)),
      trades: active.reduce((sum, row) => sum + row.trades, 0),
      profiles: active,
    });
  }

  const dailyValues = periods.map((row) => row.avgDailyPct).filter(Number.isFinite);
  return {
    periods: periods.length,
    positivePeriods: dailyValues.filter((value) => value > 0).length,
    avgDailyPct: round(avg(dailyValues)),
    medianDailyPct: round(median(dailyValues)),
    worstDailyPct: dailyValues.length ? round(Math.min(...dailyValues)) : null,
    bestDailyPct: dailyValues.length ? round(Math.max(...dailyValues)) : null,
    avgActiveProfiles: round(avg(periods.map((row) => row.activeProfiles)), 2),
    periodsDetail: periods.map((row) => ({
      ...row,
      avgDailyPct: round(row.avgDailyPct),
      avgReturnPct: round(row.avgReturnPct),
      avgMaxDrawdownPct: round(row.avgMaxDrawdownPct, 2),
      profiles: row.profiles.map((profile) => ({
        ...profile,
        dailyPct: round(profile.dailyPct),
        returnPct: round(profile.returnPct, 2),
        maxDrawdownPct: round(profile.maxDrawdownPct, 2),
      })),
    })),
  };
}

function toMarkdown(report, args) {
  const lines = [];
  lines.push("# Strategy Profile Gate");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Source: ${report.source}`);
  lines.push(`Strategy: ${report.strategy}`);
  lines.push(`Rule: top ${args.maxProfiles} profiles by walk-forward average daily %, latest daily >= ${args.minLatestDailyPct}%, previous daily >= ${args.minPrevDailyPct}%, positive windows >= ${args.minPositivePct}%`);
  lines.push("");
  lines.push("## Active Profiles");
  lines.push("");
  lines.push("| Profile | Latest Window | Latest Daily % | Previous Daily % | WF Avg Daily % | WF Median Daily % | WF Worst Daily % | Avg DD % | Trades |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  if (!report.activeProfiles.length) {
    lines.push("| None | - | - | - | - | - | - | - | - |");
  } else {
    for (const row of report.activeProfiles) {
      lines.push(`| ${row.profile} | ${row.latestWindow} | ${round(row.latestDailyPct)} | ${round(row.previousDailyPct)} | ${round(row.avgDailyPct)} | ${round(row.medianDailyPct)} | ${round(row.worstDailyPct)} | ${round(row.avgMaxDrawdownPct, 2)} | ${row.totalTrades} |`);
    }
  }
  lines.push("");
  lines.push("## Candidate Ranking");
  lines.push("");
  lines.push("| Rank | Profile | Positive Windows % | WF Avg Daily % | WF Median Daily % | Latest Daily % | Previous Daily % | Best Daily % | Worst Daily % |");
  lines.push("|---:|---|---:|---:|---:|---:|---:|---:|---:|");
  report.candidates.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.profile} | ${round(row.positivePct, 2)} | ${round(row.avgDailyPct)} | ${round(row.medianDailyPct)} | ${round(row.latestDailyPct)} | ${round(row.previousDailyPct)} | ${round(row.bestDailyPct)} | ${round(row.worstDailyPct)} |`);
  });
  lines.push("");
  lines.push("## Gate Simulation");
  lines.push("");
  lines.push("| Periods | Positive | Avg Daily % | Median Daily % | Worst Daily % | Best Daily % | Avg Active Profiles |");
  lines.push("|---:|---:|---:|---:|---:|---:|---:|");
  lines.push(`| ${report.gateSimulation.periods} | ${report.gateSimulation.positivePeriods}/${report.gateSimulation.periods} | ${report.gateSimulation.avgDailyPct} | ${report.gateSimulation.medianDailyPct} | ${report.gateSimulation.worstDailyPct} | ${report.gateSimulation.bestDailyPct} | ${report.gateSimulation.avgActiveProfiles} |`);
  lines.push("");
  lines.push("## Bot Config Draft");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.botConfigDraft, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("Note: This is a selection gate, not a profit guarantee. It keeps the strategy off profiles whose recent walk-forward behavior is weak.");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.input);
  const walkForward = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const byProfile = groupResults(walkForward.results || []);
  const candidates = selectCandidateProfiles(walkForward, args, byProfile);
  const activeProfiles = selectActiveProfiles(candidates, args);
  const gateSimulation = simulateGate(byProfile, candidates, args);
  const strategy = strategyId(walkForward);

  const report = {
    generatedAt: new Date().toISOString(),
    source: path.relative(process.cwd(), inputPath),
    strategy,
    strategyFile: walkForward.strategyFile || `${strategy}.py`,
    rule: {
      maxProfiles: args.maxProfiles,
      minPositivePct: args.minPositivePct,
      minPrevDailyPct: args.minPrevDailyPct,
      minLatestDailyPct: args.minLatestDailyPct,
    },
    params: walkForward.params || {},
    candidates: candidates.map((row) => ({
      ...row,
      avgDailyPct: round(row.avgDailyPct),
      medianDailyPct: round(row.medianDailyPct),
      positivePct: round(row.positivePct, 2),
      worstDailyPct: round(row.worstDailyPct),
      bestDailyPct: round(row.bestDailyPct),
      avgMaxDrawdownPct: round(row.avgMaxDrawdownPct, 2),
      latestDailyPct: round(row.latestDailyPct),
      latestReturnPct: round(row.latestReturnPct, 2),
      previousDailyPct: round(row.previousDailyPct),
      previousReturnPct: round(row.previousReturnPct, 2),
    })),
    activeProfiles: activeProfiles.map((row) => ({
      ...row,
      avgDailyPct: round(row.avgDailyPct),
      medianDailyPct: round(row.medianDailyPct),
      positivePct: round(row.positivePct, 2),
      worstDailyPct: round(row.worstDailyPct),
      bestDailyPct: round(row.bestDailyPct),
      avgMaxDrawdownPct: round(row.avgMaxDrawdownPct, 2),
      latestDailyPct: round(row.latestDailyPct),
      latestReturnPct: round(row.latestReturnPct, 2),
      previousDailyPct: round(row.previousDailyPct),
      previousReturnPct: round(row.previousReturnPct, 2),
    })),
    gateSimulation,
    botConfigDraft: activeProfiles.map((row) => ({
      strategy,
      symbol: row.symbol,
      interval: row.interval,
      mode: "paper",
      max_position_pct: walkForward.params?.max_position_pct ?? 100,
      leverage: walkForward.params?.leverage ?? 1,
      stop_loss_mode: walkForward.params?.stop_loss_mode ?? "strategy",
      exit_on_opposite_signal: walkForward.params?.exit_on_opposite_signal ?? true,
    })),
  };

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report, args));

  console.log(`Profile gate written: ${args.output}`);
  console.log(`Markdown report written: ${args.markdown}`);
  console.log(`Active profiles: ${report.activeProfiles.map((row) => row.profile).join(", ") || "none"}`);
}

main();
