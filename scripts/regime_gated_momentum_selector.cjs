#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    reports: path.join("data", "perp_consistency_full_50_1080d_20260619.json"),
    days: 1080,
    interval: "6h",
    minTrainWindows: 4,
    minBucketWindows: 2,
    fallback: "global",
    output: path.join("data", "regime_gated_momentum_selector.json"),
    markdown: path.join("data", "regime_gated_momentum_selector.md"),
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const option = raw.slice(2);
    const separator = option.indexOf("=");
    const key = separator >= 0 ? option.slice(0, separator) : option;
    const value = separator >= 0 ? option.slice(separator + 1) : "true";
    if (!(key in args)) continue;
    args[key] = ["reports", "interval", "fallback", "output", "markdown"].includes(key) ? value : Number(value);
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

function summarize(rows) {
  const values = rows.map((row) => row.dailyPct).filter(Number.isFinite);
  const mean = avg(values);
  const deviation = stddev(values);
  const worst = values.length ? Math.min(...values) : null;
  return {
    periods: values.length,
    activePeriods: rows.filter((row) => row.mode !== "flat").length,
    positivePeriods: values.filter((value) => value > 0).length,
    positivePct: values.length ? round(values.filter((value) => value > 0).length / values.length * 100, 2) : null,
    avgDailyPct: round(mean),
    medianDailyPct: round(median(values)),
    worstDailyPct: round(worst),
    bestDailyPct: values.length ? round(Math.max(...values)) : null,
    avgMaxDrawdownPct: round(avg(rows.map((row) => row.maxDrawdownPct))),
    worstMaxDrawdownPct: rows.length ? round(Math.max(...rows.map((row) => row.maxDrawdownPct || 0))) : null,
    lowerConfidenceDailyPct: values.length
      ? round(mean - 0.75 * deviation / Math.sqrt(values.length) + Math.min(0, worst) * 0.25)
      : null,
    activeAvgDailyPct: round(avg(rows.filter((row) => row.mode !== "flat").map((row) => row.dailyPct))),
  };
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
    if (!response.ok) throw new Error(`${symbol} ${interval} Binance futures ${response.status}: ${await response.text()}`);
    const raw = await response.json();
    if (!raw.length) break;
    for (const row of raw) {
      all.push({ t: Number(row[0]), c: Number(row[4]) });
    }
    const next = Number(raw.at(-1)[6]) + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(35);
  }
  return [...new Map(all.map((row) => [row.t, row])).values()].sort((a, b) => a.t - b.t);
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
    output.push(Math.sqrt(Math.max(0, sumSquares / size - (sum / size) ** 2)));
  }
  return output;
}

function buildWindows(times, windowDays, count) {
  const newest = times.at(-1);
  const windows = [];
  let end = newest;
  for (let index = 0; index < count; index += 1) {
    windows.push({ windowIndex: index, startTime: end - windowDays * DAY, endTime: end });
    end -= windowDays * DAY;
  }
  return windows;
}

function nearestIndex(candles, time) {
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].t <= time) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, Math.min(candles.length - 1, high));
}

function addBtcFeatures(windows, btc, interval) {
  const closes = btc.map((row) => row.c);
  const btcEma200 = ema(closes, 200);
  const returns = closes.map((close, index) => index ? Math.log(close / closes[index - 1]) : 0);
  const vol = rollingStd(returns, 28);
  const barsPerDay = DAY / Math.max(1, btc[1].t - btc[0].t);
  const barLookback = (days) => Math.max(1, Math.round(days * barsPerDay));
  return windows.map((window) => {
    const index = nearestIndex(btc, window.startTime);
    const pct = (bars) => {
      const before = Math.max(0, index - bars);
      return before === index ? 0 : (btc[index].c / btc[before].c - 1) * 100;
    };
    return {
      ...window,
      btc: {
        price: round(btc[index].c, 2),
        r30: round(pct(barLookback(30))),
        r60: round(pct(barLookback(60))),
        r90: round(pct(barLookback(90))),
        aboveEma200: btc[index].c >= btcEma200[index],
        dailyVolPct: round((vol[index] || 0) * Math.sqrt(barsPerDay) * 100),
        interval,
      },
    };
  });
}

const regimePolicies = [
  {
    name: "btc60-four-zone",
    bucket: (btc) => (btc.r60 > 25 ? "strong-up" : btc.r60 > 0 ? "up" : btc.r60 > -15 ? "soft-down" : "down"),
  },
  {
    name: "btc90-four-zone",
    bucket: (btc) => (btc.r90 > 30 ? "strong-up" : btc.r90 > 0 ? "up" : btc.r90 > -15 ? "soft-down" : "down"),
  },
  {
    name: "btc30-turning",
    bucket: (btc) => (btc.r30 > 8 ? "fast-up" : btc.r30 > 0 ? "mild-up" : btc.r30 > -8 ? "mild-down" : "fast-down"),
  },
  {
    name: "btc30x60-combo",
    bucket: (btc) => {
      if (btc.r30 >= 0 && btc.r60 >= 0) return "up-confirmed";
      if (btc.r30 >= 0 && btc.r60 < 0) return "rebound";
      if (btc.r30 < 0 && btc.r60 >= 0) return "pullback";
      return "down-confirmed";
    },
  },
  {
    name: "btc-ema-vol",
    bucket: (btc) => {
      const side = btc.aboveEma200 ? "above" : "below";
      const vol = btc.dailyVolPct > 4 ? "highvol" : "normalvol";
      return `${side}-${vol}`;
    },
  },
];

function mergeReports(reportPaths) {
  const merged = [];
  const meta = [];
  for (const reportPath of reportPaths) {
    const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), "utf8"));
    if (!Array.isArray(report.configResults)) {
      throw new Error(`${reportPath} does not include configResults. Re-run source research with --fullResults=1.`);
    }
    const source = path.basename(reportPath, ".json");
    meta.push({ source, interval: report.interval, windowDays: report.windowDays, symbols: report.symbols?.length || 0 });
    for (const item of report.configResults) {
      merged.push({
        source,
        config: { ...item.config, source, name: `${source}:${item.config.name}` },
        windows: item.windows,
      });
    }
  }
  return { configResults: merged, meta };
}

function chooseConfig(configResults, trainWindowIndexes) {
  const ranked = configResults.map((item) => {
    const windows = item.windows.filter((row) => trainWindowIndexes.includes(row.windowIndex));
    return { item, summary: summarize(windows) };
  }).filter((row) => row.summary.periods > 0)
    .sort((a, b) => (b.summary.lowerConfidenceDailyPct ?? -Infinity) - (a.summary.lowerConfidenceDailyPct ?? -Infinity));
  return ranked[0] || null;
}

function walkForwardPolicy(configResults, windows, policy, minTrainWindows, minBucketWindows, fallbackMode) {
  const periods = [];
  for (let windowIndex = windows.length - minTrainWindows - 1; windowIndex >= 0; windowIndex -= 1) {
    const current = windows.find((row) => row.windowIndex === windowIndex);
    const currentBucket = policy.bucket(current.btc);
    const olderWindows = windows.filter((row) => row.windowIndex > windowIndex);
    const sameBucket = olderWindows.filter((row) => policy.bucket(row.btc) === currentBucket);
    const bucketTrain = sameBucket.map((row) => row.windowIndex);
    const allTrain = olderWindows.map((row) => row.windowIndex);
    const bucketChoice = bucketTrain.length >= minBucketWindows ? chooseConfig(configResults, bucketTrain) : null;
    const fallbackChoice = fallbackMode === "global" ? chooseConfig(configResults, allTrain) : null;
    const chosen = bucketChoice || fallbackChoice;
    const currentResult = chosen?.item.windows.find((row) => row.windowIndex === windowIndex);
    if (!chosen || !currentResult) {
      periods.push({ windowIndex, dailyPct: 0, totalReturnPct: 0, maxDrawdownPct: 0, mode: "flat", bucket: currentBucket, btc: current.btc });
      continue;
    }
    periods.push({
      ...currentResult,
      mode: bucketChoice ? "bucket" : "fallback",
      bucket: currentBucket,
      btc: current.btc,
      selectedConfig: chosen.item.config.name,
      training: chosen.summary,
      bucketTrainWindows: bucketTrain.length,
    });
  }
  return { policy: policy.name, summary: summarize(periods), periods };
}

function fixedRegimeDiagnostics(configResults, windows, policy) {
  const rows = [];
  const buckets = [...new Set(windows.map((window) => policy.bucket(window.btc)))];
  for (const bucket of buckets) {
    const indexes = windows.filter((window) => policy.bucket(window.btc) === bucket).map((window) => window.windowIndex);
    const choice = chooseConfig(configResults, indexes);
    if (!choice) continue;
    rows.push({
      bucket,
      windows: indexes.length,
      selectedConfig: choice.item.config.name,
      summary: choice.summary,
    });
  }
  return rows.sort((a, b) => (b.summary.lowerConfidenceDailyPct ?? -Infinity) - (a.summary.lowerConfidenceDailyPct ?? -Infinity));
}

function toMarkdown(report) {
  const lines = [
    "# Regime Gated Momentum Selector",
    "",
    `Generated: ${report.generatedAt}`,
    `Reports: ${report.sources.map((row) => row.source).join(", ")}`,
    `BTC interval: ${report.interval}; window: ${report.windowDays} days`,
    "",
    "## Walk-Forward Policies",
    "",
    "| Policy | Periods | Active | Positive | Avg Daily % | Active Avg % | Median % | Worst % | Best % | Avg DD % | Worst DD % | Lower Confidence % |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.policies.map((row) => `| ${row.policy} | ${row.summary.periods} | ${row.summary.activePeriods} | ${row.summary.positivePeriods}/${row.summary.periods} | ${row.summary.avgDailyPct} | ${row.summary.activeAvgDailyPct} | ${row.summary.medianDailyPct} | ${row.summary.worstDailyPct} | ${row.summary.bestDailyPct} | ${row.summary.avgMaxDrawdownPct} | ${row.summary.worstMaxDrawdownPct} | ${row.summary.lowerConfidenceDailyPct} |`),
    "",
  ];
  for (const policy of report.policies) {
    lines.push(`## ${policy.policy} Periods`, "");
    lines.push("| Window | Bucket | Mode | BTC r30 | BTC r60 | BTC r90 | Daily % | Return % | DD % | Config | Bucket Train |");
    lines.push("|---:|---|---|---:|---:|---:|---:|---:|---:|---|---:|");
    for (const row of policy.periods) {
      lines.push(`| ${row.windowIndex} | ${row.bucket} | ${row.mode} | ${row.btc.r30} | ${row.btc.r60} | ${row.btc.r90} | ${row.dailyPct} | ${row.totalReturnPct} | ${row.maxDrawdownPct} | ${row.selectedConfig || "-"} | ${row.bucketTrainWindows || 0} |`);
    }
    lines.push("");
  }
  lines.push("## Fixed Regime Diagnostics");
  lines.push("");
  lines.push("These rows are diagnostic only because they use all windows in the bucket.");
  lines.push("");
  lines.push("| Policy | Bucket | Windows | Avg Daily % | Median % | Worst % | Positive % | Config |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---|");
  for (const row of report.fixedDiagnostics) {
    for (const bucket of row.buckets) {
      lines.push(`| ${row.policy} | ${bucket.bucket} | ${bucket.windows} | ${bucket.summary.avgDailyPct} | ${bucket.summary.medianDailyPct} | ${bucket.summary.worstDailyPct} | ${bucket.summary.positivePct} | ${bucket.selectedConfig} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const reportPaths = args.reports.split(",").map((item) => item.trim()).filter(Boolean);
  const { configResults, meta } = mergeReports(reportPaths);
  const windowDays = meta[0].windowDays || 90;
  const btc = await fetchCandles("BTCUSDT", args.interval, args.days);
  const count = Math.max(...configResults.flatMap((item) => item.windows.map((row) => row.windowIndex))) + 1;
  const baseWindows = buildWindows(btc.map((row) => row.t), windowDays, count);
  const windows = addBtcFeatures(baseWindows, btc, args.interval);
  const policies = regimePolicies
    .map((policy) => walkForwardPolicy(configResults, windows, policy, args.minTrainWindows, args.minBucketWindows, args.fallback))
    .sort((a, b) => (b.summary.lowerConfidenceDailyPct ?? -Infinity) - (a.summary.lowerConfidenceDailyPct ?? -Infinity));
  const fixedDiagnostics = regimePolicies.map((policy) => ({
    policy: policy.name,
    buckets: fixedRegimeDiagnostics(configResults, windows, policy),
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    sources: meta,
    interval: args.interval,
    windowDays,
    minTrainWindows: args.minTrainWindows,
    minBucketWindows: args.minBucketWindows,
    fallback: args.fallback,
    policies,
    fixedDiagnostics,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.resolve(args.markdown), toMarkdown(report));
  console.table(policies.map((row) => ({ policy: row.policy, ...row.summary })));
  console.log(`Report: ${path.resolve(args.markdown)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
