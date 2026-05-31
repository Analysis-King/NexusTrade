const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DAY = 86_400_000;
const ROOT = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const outputName = String(args.out || 'orphan_market_reader_scan').replace(/[^a-zA-Z0-9_-]/g, '_');
const OUT_JSON = path.join(ROOT, 'data', `${outputName}.json`);
const OUT_MD = path.join(ROOT, 'data', `${outputName}.md`);

const DEFAULT_INTERVALS = ['5m', '15m', '30m', '1h'];
const DEFAULT_DAYS = {
  '5m': 14,
  '15m': 30,
  '30m': 60,
  '1h': 90,
};

const symbolLimit = Number(args.symbols || 50);
const concurrency = Math.max(1, Number(args.concurrency || 6));
const intervals = String(args.intervals || DEFAULT_INTERVALS.join(','))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const fixedDays = args.days ? Number(args.days) : null;

function maybeNumber(key) {
  if (args[key] == null) return undefined;
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : undefined;
}

function maybeString(key) {
  if (args[key] == null) return undefined;
  return String(args[key]);
}

const strategyParams = {
  max_position_pct: Number(args.positionPct || 25),
  leverage: Number(args.leverage || 1),
  fee_bps: Number(args.feeBps || 10),
  slippage_bps: Number(args.slippageBps || 2),
  stop_loss_mode: 'strategy',
  exit_on_opposite_signal: args.exitOnOpposite == null ? true : String(args.exitOnOpposite).toLowerCase() !== 'false',
};

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

async function fetchTopUsdtSymbols(limit) {
  const stableOrFiat = new Set([
    'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1',
    'RLUSD', 'XUSD', 'EUR', 'TRY', 'BRL', 'ARS', 'AEUR', 'PAXG', 'XAUT',
  ]);
  const tickers = await fetchJson('https://api.binance.com/api/v3/ticker/24hr');
  return tickers
    .filter((item) => {
      const symbol = String(item.symbol || '');
      if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
      const base = symbol.slice(0, -4);
      if (stableOrFiat.has(base)) return false;
      if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
      return Number(item.quoteVolume || 0) > 0;
    })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((item) => item.symbol);
}

async function fetchCandles(symbol, interval, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];

  while (cursor <= endTime) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit: 1000 })
      .forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const raw = await fetchJson(url);
    if (!raw.length) break;

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
  const candles = await fetchCandles(task.symbol, task.interval, task.days);
  const instance = `orphan_${task.symbol}_${task.interval}_${randomUUID().replace(/-/g, '')}`;
  await worker.request('load', {
    instance,
    strategy_file: 'orphan_market_reader.py',
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
      params: strategyParams,
    });
    return {
      ...task,
      candles: candles.length,
      summary: result.summary,
      trades: args.includeTrades ? (result.trades || []) : undefined,
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

function aggregate(results) {
  const byInterval = [];
  for (const interval of intervals) {
    const rows = results.filter((row) => row.interval === interval);
    const returns = rows.map((row) => row.summary?.totalReturnPct).filter(Number.isFinite);
    const dailyReturns = rows
      .map((row) => dailyCompoundPct(Number(row.summary?.totalReturnPct), Number(row.days)))
      .filter(Number.isFinite);
    byInterval.push({
      interval,
      rows: rows.length,
      positiveRows: rows.filter((row) => (row.summary?.totalReturnPct || 0) > 0).length,
      avgReturnPct: round(mean(returns), 3),
      medianReturnPct: round(median(returns), 3),
      avgDailyCompoundPct: round(mean(dailyReturns), 4),
      medianDailyCompoundPct: round(median(dailyReturns), 4),
      totalTrades: rows.reduce((sum, row) => sum + Number(row.summary?.totalTrades || 0), 0),
      avgWinRatePct: round(mean(rows.map((row) => row.summary?.winRatePct).filter(Number.isFinite)), 2),
    });
  }

  const setupMap = new Map();
  for (const result of results) {
    for (const obs of result.observationStats || []) {
      const key = `${obs.name}|${obs.side}`;
      const item = setupMap.get(key) || {
        name: obs.name,
        side: obs.side,
        count: 0,
        wins: 0,
        losses: 0,
        weightedReturn: 0,
        bestReturnPct: -Infinity,
        worstReturnPct: Infinity,
      };
      const count = Number(obs.count || 0);
      item.count += count;
      item.wins += Number(obs.wins || 0);
      item.losses += Number(obs.losses || 0);
      item.weightedReturn += Number(obs.avgReturnPct || 0) * count;
      item.bestReturnPct = Math.max(item.bestReturnPct, Number(obs.bestReturnPct ?? -Infinity));
      item.worstReturnPct = Math.min(item.worstReturnPct, Number(obs.worstReturnPct ?? Infinity));
      setupMap.set(key, item);
    }
  }
  const setups = [...setupMap.values()]
    .map((item) => ({
      ...item,
      winRatePct: item.count ? round(item.wins * 100 / item.count, 2) : 0,
      avgReturnPct: item.count ? round(item.weightedReturn / item.count, 4) : 0,
      bestReturnPct: Number.isFinite(item.bestReturnPct) ? round(item.bestReturnPct, 4) : null,
      worstReturnPct: Number.isFinite(item.worstReturnPct) ? round(item.worstReturnPct, 4) : null,
    }))
    .sort((a, b) => (b.avgReturnPct * Math.min(b.count, 50)) - (a.avgReturnPct * Math.min(a.count, 50)));

  const bestRows = [...results]
    .sort((a, b) => Number(b.summary?.totalReturnPct || 0) - Number(a.summary?.totalReturnPct || 0))
    .slice(0, 25);

  return { byInterval, setups, bestRows };
}

function markdown(report) {
  const lines = [];
  lines.push('# Orphan Market Reader Scan');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Symbols: ${report.symbols.length}`);
  lines.push(`Intervals: ${report.intervals.join(', ')}`);
  lines.push(`Params: ${JSON.stringify(report.params)}`);
  lines.push('');
  lines.push('## Interval Summary');
  lines.push('');
  lines.push('| Interval | Rows | Positive | Avg Return % | Avg Daily % | Median Daily % | Avg Win % | Trades |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.aggregate.byInterval) {
    lines.push(`| ${row.interval} | ${row.rows} | ${row.positiveRows} | ${row.avgReturnPct} | ${row.avgDailyCompoundPct} | ${row.medianDailyCompoundPct} | ${row.avgWinRatePct} | ${row.totalTrades} |`);
  }
  lines.push('');
  lines.push('## Setup Observation Summary');
  lines.push('');
  lines.push('| Setup | Side | Count | Win % | Avg Return % | Best % | Worst % |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  for (const row of report.aggregate.setups.slice(0, 20)) {
    lines.push(`| ${row.name} | ${row.side} | ${row.count} | ${row.winRatePct} | ${row.avgReturnPct} | ${row.bestReturnPct} | ${row.worstReturnPct} |`);
  }
  lines.push('');
  lines.push('## Best Symbol/Interval Rows');
  lines.push('');
  lines.push('| Symbol | Interval | Days | Return % | Daily % | Trades | Win % | Max DD % |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const row of report.aggregate.bestRows) {
    lines.push(`| ${row.symbol} | ${row.interval} | ${row.days} | ${row.summary.totalReturnPct} | ${round(dailyCompoundPct(Number(row.summary.totalReturnPct), Number(row.days)), 4)} | ${row.summary.totalTrades} | ${row.summary.winRatePct} | ${row.summary.maxDrawdownPct} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
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
        const trades = result.summary?.totalTrades;
        console.log(`[${progress.done}/${progress.total}] ${task.symbol} ${task.interval} ${task.days}d return=${ret}% trades=${trades}`);
      } catch (err) {
        results.push({ ...task, error: err.message });
        progress.done += 1;
        console.log(`[${progress.done}/${progress.total}] ${task.symbol} ${task.interval} ERROR ${err.message}`);
        if (!worker.isAlive()) {
          worker.child.kill();
          worker = startWorker(slot);
        }
      }
      const partial = buildReport(progress.symbols, results);
      save(partial);
    }
  } finally {
    worker.child.kill();
  }
}

function buildReport(symbols, results) {
  return {
    generatedAt: new Date().toISOString(),
    strategyFile: 'orphan_market_reader.py',
    symbols,
    intervals,
    daysByInterval: Object.fromEntries(intervals.map((interval) => [interval, fixedDays || DEFAULT_DAYS[interval] || 30])),
    params: strategyParams,
    results: [...results].sort((a, b) =>
      String(a.symbol).localeCompare(String(b.symbol)) || String(a.interval).localeCompare(String(b.interval))
    ),
    aggregate: aggregate(results.filter((row) => !row.error && row.summary)),
  };
}

async function main() {
  console.log(`Orphan scan starting: symbols=${symbolLimit}, intervals=${intervals.join(',')}, concurrency=${concurrency}`);
  const symbols = args.symbolList
    ? String(args.symbolList).split(',').map((item) => item.trim()).filter(Boolean)
    : await fetchTopUsdtSymbols(symbolLimit);
  const tasks = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      tasks.push({
        symbol,
        interval,
        days: fixedDays || DEFAULT_DAYS[interval] || 30,
      });
    }
  }

  const results = [];
  if (args.resume && fs.existsSync(OUT_JSON)) {
    try {
      const previous = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
      for (const result of previous.results || []) {
        if (result && result.symbol && result.interval) results.push(result);
      }
    } catch (err) {
      console.log(`Resume read skipped: ${err.message}`);
    }
  }
  const completed = new Set(results.map((row) => `${row.symbol}|${row.interval}|${row.days}`));
  const remainingTasks = tasks.filter((task) => !completed.has(`${task.symbol}|${task.interval}|${task.days}`));
  const progress = { done: 0, total: remainingTasks.length, symbols };
  save(buildReport(symbols, results));
  console.log(`Loaded previous rows=${results.length}, remaining=${remainingTasks.length}`);

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, remainingTasks.length); i += 1) {
    workers.push(workerLoop(i + 1, remainingTasks, results, progress));
  }
  await Promise.all(workers);

  const report = buildReport(symbols, results);
  save(report);
  console.log(`Done. JSON: ${OUT_JSON}`);
  console.log(`Done. MD: ${OUT_MD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
