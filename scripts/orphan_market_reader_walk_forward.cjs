const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DAY = 86_400_000;
const ROOT = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const outputName = String(args.out || 'orphan_market_reader_walk_forward').replace(/[^a-zA-Z0-9_-]/g, '_');
const OUT_JSON = path.join(ROOT, 'data', `${outputName}.json`);
const OUT_MD = path.join(ROOT, 'data', `${outputName}.md`);
const strategyFile = path.basename(String(args.strategyFile || 'orphan_market_reader.py'));

const DEFAULT_PROFILES = [
  'ZECUSDT:30m',
  'AVAXUSDT:30m',
  'ALTUSDT:1h',
  'ADAUSDT:30m',
  'DOGEUSDT:30m',
  'BTCUSDT:30m',
  'FILUSDT:1h',
  'LTCUSDT:30m',
  'JTOUSDT:1h',
  'LTCUSDT:1h',
  'HBARUSDT:30m',
  'HBARUSDT:1h',
];

const DEFAULT_WINDOW_DAYS = {
  '30m': 60,
  '1h': 90,
};

const DEFAULT_STEP_DAYS = {
  '30m': 30,
  '1h': 45,
};

const profiles = String(args.profiles || DEFAULT_PROFILES.join(','))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
  .map(parseProfile);

const lookbackDays = Number(args.lookbackDays || 360);
const warmupDays = Math.max(0, Number(args.warmupDays || 0));
const concurrency = Math.max(1, Number(args.concurrency || 4));
const fixedWindowDays = args.windowDays ? Number(args.windowDays) : null;
const fixedStepDays = args.stepDays ? Number(args.stepDays) : null;
let endAnchorMs = args.endTime ? Number(args.endTime) : Date.now();

const strategyParams = {
  max_position_pct: Number(args.positionPct || 100),
  leverage: Number(args.leverage || 2),
  fee_bps: Number(args.feeBps || 10),
  slippage_bps: Number(args.slippageBps || 2),
  stop_loss_mode: 'strategy',
  exit_on_opposite_signal: args.exitOnOpposite == null ? true : String(args.exitOnOpposite).toLowerCase() !== 'false',
};
if (args.paramsJson || args.paramsFile) {
  const rawParams = args.paramsFile
    ? fs.readFileSync(path.resolve(String(args.paramsFile)), 'utf8')
    : String(args.paramsJson);
  const extraParams = JSON.parse(rawParams);
  if (!extraParams || typeof extraParams !== 'object' || Array.isArray(extraParams)) {
    throw new Error('--paramsJson/--paramsFile must contain a JSON object');
  }
  Object.assign(strategyParams, extraParams);
}

for (const [argKey, paramKey] of [
  ['minScore', 'min_score'],
  ['minRewardRisk', 'min_reward_risk'],
  ['defaultRewardRisk', 'default_reward_risk'],
  ['oppositeCloseScore', 'opposite_close_score'],
  ['cooldownBars', 'cooldown_bars'],
  ['minIntervalMinutes', 'min_interval_minutes'],
  ['minVolumeRatio', 'min_volume_ratio'],
  ['stopBufferAtr', 'stop_buffer_atr'],
  ['stopAtrFloor', 'stop_atr_floor'],
  ['minStopPct', 'min_stop_pct'],
  ['minSignalRiskPct', 'min_signal_risk_pct'],
  ['maxStopPct', 'max_stop_pct'],
  ['minNetRewardPct', 'min_net_reward_pct'],
  ['recentSignalBars', 'recent_signal_bars'],
]) {
  const value = maybeNumber(argKey);
  if (value !== undefined) strategyParams[paramKey] = value;
}

for (const [argKey, paramKey] of [
  ['regimeFilter', 'regime_filter'],
  ['enabledSetups', 'enabled_setups'],
  ['enabledModels', 'enabled_models'],
  ['pivotDepths', 'pivot_depths'],
]) {
  const value = maybeString(argKey);
  if (value !== undefined) strategyParams[paramKey] = value;
}

function parseArgs(items) {
  const out = {};
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = items[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function maybeNumber(key) {
  if (args[key] == null) return undefined;
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : undefined;
}

function maybeString(key) {
  if (args[key] == null) return undefined;
  return String(args[key]);
}

function parseProfile(value) {
  const [symbol, interval] = value.split(':').map((part) => part.trim());
  if (!symbol || !interval) throw new Error(`Invalid profile: ${value}`);
  return { symbol: symbol.toUpperCase(), interval };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchCandlesWindow(symbol, interval, startMs, endMs) {
  const all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endMs));
    url.searchParams.set('limit', '1000');
    const raw = await fetchJson(url);
    if (!Array.isArray(raw) || !raw.length) break;
    for (const k of raw) {
      all.push({
        t: Number(k[0]),
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        v: Number(k[5]),
      });
    }
    const next = Number(raw.at(-1)[6]) + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(25);
  }
  return [...new Map(all.map((candle) => [candle.t, candle])).values()]
    .filter((candle) => candle.t >= startMs && candle.t <= endMs)
    .sort((a, b) => a.t - b.t);
}

function startWorker(slot) {
  let alive = true;
  const child = spawn('python', ['-u', 'python/workers/pool_worker.py'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });
  let buffer = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        continue;
      }
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.data);
      else waiter.reject(new Error(msg.error || `worker ${slot} error`));
    }
  });

  child.stderr.on('data', () => {});
  child.on('exit', (code, signal) => {
    alive = false;
    for (const [id, waiter] of pending.entries()) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`worker ${slot} exited: code=${code} signal=${signal}`));
    }
  });

  function request(cmd, payload, timeout = 240_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${cmd}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  }

  return { child, request, isAlive: () => alive };
}

async function runBacktest(worker, task) {
  const candles = await fetchCandlesWindow(
    task.symbol,
    task.interval,
    task.startMs - warmupDays * DAY,
    task.endMs
  );
  if (candles.length < 120) throw new Error(`not enough candles: ${candles.length}`);
  const instance = `strategy_wf_${task.symbol}_${task.interval}_${randomUUID().replace(/-/g, '')}`;
  await worker.request('load', {
    instance,
    strategy_file: strategyFile,
    params: strategyParams,
  });
  try {
    const result = await worker.request('backtest', {
      instance,
      candles,
      initial_capital: 1000,
      fee_bps: strategyParams.fee_bps,
      slippage_bps: strategyParams.slippage_bps,
      fill_model: 'pessimistic_ohlc',
      start_time: task.startMs,
      params: strategyParams,
    });
    return {
      ...task,
      candles: candles.length,
      summary: result.summary,
      patterns: result.patterns || [],
      observationStats: result.observationStats || [],
    };
  } finally {
    await worker.request('drop', { instance }, 30_000).catch(() => undefined);
  }
}

function mean(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}

function dailyCompoundPct(totalReturnPct, days) {
  if (!Number.isFinite(totalReturnPct) || !Number.isFinite(days) || days <= 0) return null;
  return (Math.pow(1 + totalReturnPct / 100, 1 / days) - 1) * 100;
}

function buildTasks() {
  const tasks = [];
  const minStartMs = endAnchorMs - lookbackDays * DAY;
  for (const profile of profiles) {
    const windowDays = fixedWindowDays || DEFAULT_WINDOW_DAYS[profile.interval] || 60;
    const stepDays = fixedStepDays || DEFAULT_STEP_DAYS[profile.interval] || Math.max(1, Math.round(windowDays / 2));
    let endMs = endAnchorMs;
    let index = 0;
    while (endMs - windowDays * DAY >= minStartMs) {
      const startMs = endMs - windowDays * DAY;
      tasks.push({
        ...profile,
        windowIndex: index,
        windowDays,
        stepDays,
        startMs,
        endMs,
      });
      endMs -= stepDays * DAY;
      index += 1;
    }
  }
  return tasks;
}

function aggregate(results) {
  const profileRows = [];
  const profileMap = new Map();
  const validResults = results.filter((row) => !row.error && row.summary);
  for (const result of results) {
    if (result.error || !result.summary) continue;
    const key = `${result.symbol}:${result.interval}`;
    if (!profileMap.has(key)) profileMap.set(key, []);
    profileMap.get(key).push(result);
  }

  for (const [profile, rows] of profileMap.entries()) {
    const returns = rows.map((row) => Number(row.summary.totalReturnPct || 0));
    const daily = rows.map((row) => dailyCompoundPct(Number(row.summary.totalReturnPct || 0), Number(row.windowDays)));
    const positive = rows.filter((row) => Number(row.summary.totalReturnPct || 0) > 0);
    const active = rows.filter((row) => Number(row.summary.totalTrades || 0) > 0);
    profileRows.push({
      profile,
      windows: rows.length,
      activeWindows: active.length,
      positiveWindows: positive.length,
      positivePct: round(rows.length ? positive.length * 100 / rows.length : 0, 2),
      avgReturnPct: round(mean(returns), 3),
      medianReturnPct: round(median(returns), 3),
      avgDailyPct: round(mean(daily), 4),
      medianDailyPct: round(median(daily), 4),
      worstDailyPct: round(Math.min(...daily.filter(Number.isFinite)), 4),
      bestDailyPct: round(Math.max(...daily.filter(Number.isFinite)), 4),
      totalTrades: rows.reduce((sum, row) => sum + Number(row.summary.totalTrades || 0), 0),
      avgMaxDrawdownPct: round(mean(rows.map((row) => Number(row.summary.maxDrawdownPct)).filter(Number.isFinite)), 2),
    });
  }

  profileRows.sort((a, b) =>
    (b.avgDailyPct * Math.min(b.positivePct, 100)) - (a.avgDailyPct * Math.min(a.positivePct, 100))
  );

  const validDaily = validResults
    .map((row) => dailyCompoundPct(Number(row.summary.totalReturnPct), Number(row.windowDays)))
    .filter(Number.isFinite);
  const windowIndexes = [...new Set(validResults.map((row) => Number(row.windowIndex)))].sort((a, b) => a - b);
  const equalWeightWindows = windowIndexes.map((windowIndex) => {
    const rows = validResults.filter((row) => Number(row.windowIndex) === windowIndex);
    const daily = rows
      .map((row) => dailyCompoundPct(Number(row.summary.totalReturnPct), Number(row.windowDays)))
      .filter(Number.isFinite);
    return {
      windowIndex,
      profiles: rows.length,
      validDailyProfiles: daily.length,
      avgDailyPct: round(mean(daily), 4),
      medianDailyPct: round(median(daily), 4),
      positiveProfiles: daily.filter((value) => value > 0).length,
      targetProfiles: daily.filter((value) => value >= 0.8).length,
    };
  });

  return {
    universal: {
      cases: validResults.length,
      validDailyCases: validDaily.length,
      positiveCases: validDaily.filter((value) => value > 0).length,
      positivePct: round(validDaily.length ? validDaily.filter((value) => value > 0).length * 100 / validDaily.length : 0, 2),
      targetDailyPct: 0.8,
      targetCases: validDaily.filter((value) => value >= 0.8).length,
      targetPct: round(validDaily.length ? validDaily.filter((value) => value >= 0.8).length * 100 / validDaily.length : 0, 2),
      blownCases: validResults.filter((row) => Number(row.summary.totalReturnPct) <= -100).length,
      avgDailyPct: round(mean(validDaily), 4),
      medianDailyPct: round(median(validDaily), 4),
      avgMaxDrawdownPct: round(mean(validResults.map((row) => Number(row.summary.maxDrawdownPct))), 2),
      equalWeightWindows,
    },
    profiles: profileRows,
    windows: results
      .filter((row) => !row.error && row.summary)
      .sort((a, b) => Number(b.summary.totalReturnPct || 0) - Number(a.summary.totalReturnPct || 0))
      .slice(0, 30),
    errors: results.filter((row) => row.error),
  };
}

function markdown(report) {
  const lines = [];
  lines.push('# Strategy Walk-Forward');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Profiles: ${report.profiles.map((profile) => `${profile.symbol}:${profile.interval}`).join(', ')}`);
  lines.push(`Strategy: ${report.strategyFile}`);
  lines.push(`Lookback Days: ${report.lookbackDays}`);
  lines.push(`Warmup Days: ${report.warmupDays}`);
  lines.push(`Params: ${JSON.stringify(report.params)}`);
  lines.push('');
  lines.push('## Universal Portfolio Summary');
  lines.push('');
  lines.push('| Cases | Positive | >=0.8%/day | Blown | Avg Daily % | Median Daily % | Avg DD % |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|');
  const universal = report.aggregate.universal;
  lines.push(`| ${universal.cases} | ${universal.positiveCases}/${universal.validDailyCases} (${universal.positivePct}%) | ${universal.targetCases}/${universal.validDailyCases} (${universal.targetPct}%) | ${universal.blownCases} | ${universal.avgDailyPct} | ${universal.medianDailyPct} | ${universal.avgMaxDrawdownPct} |`);
  lines.push('');
  lines.push('| Window | Profiles | Avg Daily % | Median Daily % | Positive | >=0.8%/day |');
  lines.push('|---:|---:|---:|---:|---:|---:|');
  for (const row of universal.equalWeightWindows) {
    lines.push(`| ${row.windowIndex} | ${row.profiles} | ${row.avgDailyPct} | ${row.medianDailyPct} | ${row.positiveProfiles} | ${row.targetProfiles} |`);
  }
  lines.push('');
  lines.push('## Profile Summary');
  lines.push('');
  lines.push('| Profile | Windows | Positive | Avg Daily % | Median Daily % | Worst Daily % | Best Daily % | Avg DD % | Trades |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.aggregate.profiles) {
    lines.push(`| ${row.profile} | ${row.windows} | ${row.positiveWindows}/${row.windows} (${row.positivePct}%) | ${row.avgDailyPct} | ${row.medianDailyPct} | ${row.worstDailyPct} | ${row.bestDailyPct} | ${row.avgMaxDrawdownPct} | ${row.totalTrades} |`);
  }
  lines.push('');
  lines.push('## Best Windows');
  lines.push('');
  lines.push('| Profile | Window | Dates | Return % | Daily % | Trades | Win % | Max DD % |');
  lines.push('|---|---:|---|---:|---:|---:|---:|---:|');
  for (const row of report.aggregate.windows) {
    lines.push(`| ${row.symbol}:${row.interval} | ${row.windowIndex} | ${new Date(row.startMs).toISOString().slice(0, 10)} - ${new Date(row.endMs).toISOString().slice(0, 10)} | ${row.summary.totalReturnPct} | ${round(dailyCompoundPct(Number(row.summary.totalReturnPct || 0), Number(row.windowDays)), 4)} | ${row.summary.totalTrades} | ${row.summary.winRatePct} | ${row.summary.maxDrawdownPct} |`);
  }
  if (report.aggregate.errors.length) {
    lines.push('');
    lines.push('## Errors');
    lines.push('');
    for (const error of report.aggregate.errors.slice(0, 30)) {
      lines.push(`- ${error.symbol}:${error.interval} window ${error.windowIndex}: ${error.error}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildReport(results) {
  return {
    generatedAt: new Date().toISOString(),
    strategyFile,
    profiles,
    lookbackDays,
    warmupDays,
    endAnchorMs,
    params: strategyParams,
    results: [...results].sort((a, b) =>
      String(a.symbol).localeCompare(String(b.symbol)) ||
      String(a.interval).localeCompare(String(b.interval)) ||
      Number(a.windowIndex) - Number(b.windowIndex)
    ),
    aggregate: aggregate(results),
  };
}

function save(report) {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(OUT_MD, markdown(report));
}

async function workerLoop(slot, tasks, results, progress) {
  let worker = startWorker(slot);
  try {
    while (true) {
      const task = tasks.shift();
      if (!task) return;
      if (!worker.isAlive()) {
        worker.child.kill();
        worker = startWorker(slot);
      }
      try {
        const result = await runBacktest(worker, task);
        results.push(result);
        progress.done += 1;
        const ret = result.summary?.totalReturnPct;
        const daily = dailyCompoundPct(Number(ret), Number(task.windowDays));
        console.log(`[${progress.done}/${progress.total}] ${task.symbol}:${task.interval} w${task.windowIndex} return=${ret}% daily=${round(daily, 4)}% trades=${result.summary?.totalTrades}`);
      } catch (err) {
        results.push({ ...task, error: err.message });
        progress.done += 1;
        console.log(`[${progress.done}/${progress.total}] ${task.symbol}:${task.interval} w${task.windowIndex} ERROR ${err.message}`);
      }
      if (progress.done % 8 === 0) save(buildReport(results));
    }
  } finally {
    worker.child.kill();
  }
}

async function main() {
  const results = [];
  let previousReport = null;
  if (args.resume && fs.existsSync(OUT_JSON)) {
    try {
      previousReport = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
      if (!args.endTime && Number.isFinite(Number(previousReport.endAnchorMs))) {
        endAnchorMs = Number(previousReport.endAnchorMs);
      }
      const unique = new Map();
      for (const result of previousReport.results || []) {
        if (result && result.symbol && result.interval && Number.isFinite(Number(result.windowIndex))) {
          unique.set(`${result.symbol}|${result.interval}|${result.windowIndex}`, result);
        }
      }
      results.push(...unique.values());
    } catch (err) {
      console.log(`Resume read skipped: ${err.message}`);
    }
  }

  const tasks = buildTasks();
  const completed = new Set(results.map((row) => `${row.symbol}|${row.interval}|${row.windowIndex}`));
  const remainingTasks = tasks.filter((task) => !completed.has(`${task.symbol}|${task.interval}|${task.windowIndex}`));
  const progress = { done: 0, total: remainingTasks.length };
  save(buildReport(results));
  console.log(`Walk-forward starting: profiles=${profiles.length}, tasks=${tasks.length}, remaining=${remainingTasks.length}, concurrency=${concurrency}`);

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, remainingTasks.length); i += 1) {
    workers.push(workerLoop(i + 1, remainingTasks, results, progress));
  }
  await Promise.all(workers);

  const report = buildReport(results);
  save(report);
  console.log(`Done. JSON: ${OUT_JSON}`);
  console.log(`Done. MD: ${OUT_MD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
