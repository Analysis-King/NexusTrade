#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  avg,
  buildProfiles,
  evaluatePlan,
  loadInputs,
  median,
  round,
  stddev,
} = require("./strategy_portfolio_blend.cjs");

function parseArgs(argv) {
  const args = {
    inputs: "",
    sourceReport: "",
    output: path.join("data", "nested_strategy_selector.json"),
    markdown: path.join("data", "nested_strategy_selector.md"),
    testWindows: 6,
    minValidationWindows: 4,
    targetDailyPct: 0.8,
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const option = raw.slice(2);
    const separator = option.indexOf("=");
    const key = separator >= 0 ? option.slice(0, separator) : option;
    const value = separator >= 0 ? option.slice(separator + 1) : "true";
    if (!(key in args)) continue;
    args[key] = ["inputs", "sourceReport", "output", "markdown"].includes(key) ? value : Number(value);
  }
  return args;
}

function inputsFromSourceReport(file) {
  const report = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  return (report.sources || []).map((row) => `${row.strategy}=${row.file}`).join(",");
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

function candidateScore(summary, riskLimitPct) {
  if (!summary || summary.periods < 1) return -Infinity;
  if (Number(summary.worstEstimatedMaxDrawdownPct || 0) > riskLimitPct) return -Infinity;
  const confidence = Number(summary.lowerConfidenceDailyPct ?? -Infinity);
  const positiveBonus = Number(summary.positivePct || 0) / 1000;
  const drawdownPenalty = Number(summary.avgEstimatedMaxDrawdownPct || 0) / 10000;
  return confidence + positiveBonus - drawdownPenalty;
}

function buildCandidates(profiles, args) {
  const plans = [
    "Equal profiles",
    "Previous momentum",
    "Historical robust",
    "Equal strategy sleeves",
    "Equal sleeves + momentum",
    "Equal sleeves + historical",
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
      candidates.push({
        plan,
        rule,
        periods: new Map(simulation.periodsDetail.map((row) => [row.windowIndex, row])),
        periodsDetail: simulation.periodsDetail,
      });
    }
  }
  return candidates;
}

function runNestedModel(candidates, args, riskLimitPct) {
  const periods = [];
  for (let windowIndex = args.testWindows - 1; windowIndex >= 0; windowIndex -= 1) {
    let chosen = null;
    for (const candidate of candidates) {
      const current = candidate.periods.get(windowIndex);
      if (!current) continue;
      const validation = summarize(candidate.periodsDetail.filter((row) => row.windowIndex > windowIndex));
      if (validation.periods < args.minValidationWindows) continue;
      const score = candidateScore(validation, riskLimitPct);
      if (!chosen || score > chosen.score) chosen = { candidate, current, validation, score };
    }
    if (!chosen) continue;
    periods.push({
      windowIndex,
      dailyPct: chosen.current.dailyPct,
      estimatedMaxDrawdownPct: chosen.current.estimatedMaxDrawdownPct,
      selectedPlan: chosen.candidate.plan,
      selectedRule: chosen.candidate.rule,
      validation: chosen.validation,
      selectedProfiles: chosen.current.profiles,
    });
  }
  return {
    riskLimitPct,
    summary: summarize(periods),
    periods,
  };
}

function toMarkdown(report) {
  const lines = [
    "# Nested Walk-Forward Strategy Selector",
    "",
    `Generated: ${report.generatedAt}`,
    `Candidates per decision: ${report.candidatesTested}`,
    `Newest blind windows tested: ${report.testWindows}`,
    `Minimum older validation windows: ${report.minValidationWindows}`,
    "",
    "Every blind window independently chooses its selector rule using only outcomes from older windows.",
    "",
    "## Model Comparison",
    "",
    "| Validation Worst DD Limit % | Periods | Positive | Avg Daily % | Median % | Worst % | Best % | Avg DD % | Worst DD % | Lower Confidence % |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const model of report.models) {
    const row = model.summary;
    lines.push(`| ${model.riskLimitPct} | ${row.periods} | ${row.positivePeriods}/${row.periods} | ${row.avgDailyPct} | ${row.medianDailyPct} | ${row.worstDailyPct} | ${row.bestDailyPct} | ${row.avgEstimatedMaxDrawdownPct} | ${row.worstEstimatedMaxDrawdownPct} | ${row.lowerConfidenceDailyPct} |`);
  }
  for (const model of report.models) {
    lines.push("", `## Risk Limit ${model.riskLimitPct}%`, "");
    lines.push("| Window | Blind Daily % | Blind DD % | Chosen Plan | Older Validation Avg % | Older Validation Worst % |");
    lines.push("|---:|---:|---:|---|---:|---:|");
    for (const row of model.periods) {
      lines.push(`| ${row.windowIndex} | ${row.dailyPct} | ${row.estimatedMaxDrawdownPct} | ${row.selectedPlan} | ${row.validation.avgDailyPct} | ${row.validation.worstDailyPct} |`);
    }
  }
  lines.push("", "This is nested walk-forward research evidence, not a profit guarantee.", "");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.inputs && args.sourceReport) args.inputs = inputsFromSourceReport(args.sourceReport);
  const inputs = loadInputs(args);
  const profiles = buildProfiles(inputs);
  const candidates = buildCandidates(profiles, args);
  const models = [20, 30, 40, 60, 1000000].map((riskLimitPct) => runNestedModel(candidates, args, riskLimitPct));
  const report = {
    generatedAt: new Date().toISOString(),
    sources: inputs.map((input) => ({ strategy: input.strategy, file: input.file })),
    targetDailyPct: args.targetDailyPct,
    candidatesTested: candidates.length,
    testWindows: args.testWindows,
    minValidationWindows: args.minValidationWindows,
    models,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table(models.map((model) => ({
    riskLimitPct: model.riskLimitPct,
    avgDailyPct: model.summary.avgDailyPct,
    medianDailyPct: model.summary.medianDailyPct,
    worstDailyPct: model.summary.worstDailyPct,
    positivePct: model.summary.positivePct,
    avgDdPct: model.summary.avgEstimatedMaxDrawdownPct,
  })));
  console.log(`Nested selector report: ${path.resolve(args.markdown)}`);
}

main();
