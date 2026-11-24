#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  avg,
  buildProfiles,
  evaluatePlan,
  latestAllocation,
  loadInputs,
  median,
  round,
  stddev,
} = require("./strategy_portfolio_blend.cjs");

function parseArgs(argv) {
  const args = {
    inputs: "",
    output: path.join("data", "strategy_selector_holdout.json"),
    markdown: path.join("data", "strategy_selector_holdout.md"),
    holdoutWindows: 4,
    minValidationWindows: 3,
    targetDailyPct: 0.8,
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const option = raw.slice(2);
    const separator = option.indexOf("=");
    const key = separator >= 0 ? option.slice(0, separator) : option;
    const value = separator >= 0 ? option.slice(separator + 1) : "true";
    if (!(key in args)) continue;
    args[key] = ["inputs", "output", "markdown"].includes(key) ? value : Number(value);
  }
  return args;
}

function summarize(periods) {
  const values = periods.map((row) => row.dailyPct).filter(Number.isFinite);
  const drawdowns = periods.map((row) => row.estimatedMaxDrawdownPct).filter(Number.isFinite);
  const worst = values.length ? Math.min(...values) : null;
  const mean = avg(values);
  const deviation = stddev(values);
  return {
    periods: values.length,
    positivePeriods: values.filter((value) => value > 0).length,
    positivePct: values.length ? round((values.filter((value) => value > 0).length / values.length) * 100, 2) : null,
    avgDailyPct: round(mean),
    medianDailyPct: round(median(values)),
    worstDailyPct: round(worst),
    bestDailyPct: values.length ? round(Math.max(...values)) : null,
    stdDevDailyPct: round(deviation),
    avgEstimatedMaxDrawdownPct: round(avg(drawdowns)),
    worstEstimatedMaxDrawdownPct: drawdowns.length ? round(Math.max(...drawdowns)) : null,
    lowerConfidenceDailyPct: values.length
      ? round(mean - 0.75 * deviation / Math.sqrt(values.length) + Math.min(0, worst) * 0.25)
      : null,
  };
}

function cartesian(values) {
  return values.reduce((rows, options) => rows.flatMap((row) => options.map((value) => [...row, value])), [[]]);
}

function toMarkdown(report) {
  const chosen = report.chosen;
  const lines = [
    "# Strategy Selector Blind Holdout",
    "",
    `Generated: ${report.generatedAt}`,
    `Rule combinations tested: ${report.combinationsTested}`,
    `Holdout: newest ${report.holdoutWindows} windows; these windows were not used to choose the selector.`,
    "",
    "## Chosen Selector",
    "",
    `Plan: ${chosen.plan}`,
    "",
    "| Setting | Value |",
    "|---|---:|",
    ...Object.entries(chosen.rule).map(([key, value]) => `| ${key} | ${value} |`),
    "",
    "## Result",
    "",
    "| Split | Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Std Dev % | Avg DD % | Worst DD % | Lower Confidence % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| Older validation | ${chosen.validation.periods} | ${chosen.validation.positivePeriods}/${chosen.validation.periods} | ${chosen.validation.avgDailyPct} | ${chosen.validation.medianDailyPct} | ${chosen.validation.worstDailyPct} | ${chosen.validation.bestDailyPct} | ${chosen.validation.stdDevDailyPct} | ${chosen.validation.avgEstimatedMaxDrawdownPct} | ${chosen.validation.worstEstimatedMaxDrawdownPct} | ${chosen.validation.lowerConfidenceDailyPct} |`,
    `| Blind holdout | ${chosen.holdout.periods} | ${chosen.holdout.positivePeriods}/${chosen.holdout.periods} | ${chosen.holdout.avgDailyPct} | ${chosen.holdout.medianDailyPct} | ${chosen.holdout.worstDailyPct} | ${chosen.holdout.bestDailyPct} | ${chosen.holdout.stdDevDailyPct} | ${chosen.holdout.avgEstimatedMaxDrawdownPct} | ${chosen.holdout.worstEstimatedMaxDrawdownPct} | ${chosen.holdout.lowerConfidenceDailyPct} |`,
    "",
    `Latest expected daily: ${chosen.latest.expectedDailyPct}%`,
    `Multiplier required for ${report.targetDailyPct}% daily: ${chosen.latest.targetMultiplier}x.`,
    "",
    "## Latest Allocation",
    "",
    "| Strategy | Profile | Weight % | Latest Daily % | History Avg % | Positive History % |",
    "|---|---|---:|---:|---:|---:|",
    ...chosen.latest.profiles.map((row) => `| ${row.strategy} | ${row.symbol}:${row.interval} | ${row.capitalWeightPct} | ${row.latestDailyPct} | ${row.historyAvgDailyPct} | ${row.historyPositivePct} |`),
    "",
    "## Validation Risk Limits",
    "",
    "| Validation Worst DD Limit % | Plan | Validation Avg % | Holdout Avg % | Holdout Worst % | Holdout Worst DD % |",
    "|---:|---|---:|---:|---:|---:|",
    ...report.riskConstrained.map((row) => `| ${row.limitPct} | ${row.candidate?.plan || "-"} | ${row.candidate?.validation?.avgDailyPct ?? "-"} | ${row.candidate?.holdout?.avgDailyPct ?? "-"} | ${row.candidate?.holdout?.worstDailyPct ?? "-"} | ${row.candidate?.holdout?.worstEstimatedMaxDrawdownPct ?? "-"} |`),
    "",
    "This is research evidence, not a profit guarantee.",
    "",
  ];
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const inputs = loadInputs(args);
  const profiles = buildProfiles(inputs);
  const plans = [
    "Previous momentum",
    "Top strategy momentum",
    "Top 2 strategy momentum",
  ];
  const combinations = cartesian([
    [3, 4, 5, 6],
    [50, 55],
    [0, 0.05],
    [0, 0.1],
    [20],
    [20, 30, 40, 1000000],
    [20, 30, 40, 1000000],
    [1, 3],
    [0.6, 0.8, 1],
  ]);

  const candidates = [];
  for (const values of combinations) {
    const rule = {
      minHistoryWindows: values[0],
      minPositivePct: values[1],
      minHistoryAvgDailyPct: values[2],
      minPrevDailyPct: values[3],
      minHistoryTrades: values[4],
      maxHistoryAvgDrawdownPct: values[5],
      maxPrevDrawdownPct: values[6],
      maxProfilesPerStrategy: values[7],
      profileCap: values[8],
      targetDailyPct: args.targetDailyPct,
    };
    for (const plan of plans) {
      const simulation = evaluatePlan(plan, profiles, rule);
      const validationRows = simulation.periodsDetail.filter((row) => row.windowIndex >= args.holdoutWindows);
      const holdoutRows = simulation.periodsDetail.filter((row) => row.windowIndex < args.holdoutWindows);
      const validation = summarize(validationRows);
      if (validation.periods < args.minValidationWindows || holdoutRows.length < args.holdoutWindows) continue;
      candidates.push({
        plan,
        rule,
        validation,
        holdout: summarize(holdoutRows),
      });
    }
  }

  candidates.sort((a, b) => {
    const confidence = (b.validation.lowerConfidenceDailyPct ?? -Infinity)
      - (a.validation.lowerConfidenceDailyPct ?? -Infinity);
    if (Math.abs(confidence) > 0.0001) return confidence;
    return (b.validation.avgDailyPct ?? -Infinity) - (a.validation.avgDailyPct ?? -Infinity);
  });

  const chosen = candidates[0];
  if (!chosen) {
    const report = {
      generatedAt: new Date().toISOString(),
      sources: inputs.map((input) => ({ strategy: input.strategy, file: input.file })),
      targetDailyPct: args.targetDailyPct,
      holdoutWindows: args.holdoutWindows,
      combinationsTested: combinations.length * plans.length,
      chosen: null,
      riskConstrained: [],
      topValidationCandidates: [],
      error: "No selector satisfied the validation and holdout requirements.",
    };
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.resolve(args.markdown), [
      "# Strategy Selector Blind Holdout",
      "",
      `Generated: ${report.generatedAt}`,
      "",
      report.error,
      "",
    ].join("\n"));
    console.log(`Holdout report written: ${args.output}`);
    console.log(report.error);
    return;
  }
  chosen.latest = latestAllocation(chosen.plan, profiles, chosen.rule);
  const riskConstrained = [20, 30, 40, 50, 60].map((limitPct) => ({
    limitPct,
    candidate: candidates.find((candidate) => candidate.validation.worstEstimatedMaxDrawdownPct <= limitPct) || null,
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    sources: inputs.map((input) => ({ strategy: input.strategy, file: input.file })),
    targetDailyPct: args.targetDailyPct,
    holdoutWindows: args.holdoutWindows,
    combinationsTested: combinations.length * plans.length,
    chosen,
    riskConstrained,
    topValidationCandidates: candidates.slice(0, 20),
  };

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.log(`Holdout report written: ${args.output}`);
  console.log(`Chosen: ${chosen.plan}, validation=${chosen.validation.avgDailyPct}%, blind holdout=${chosen.holdout.avgDailyPct}%`);
}

main();
