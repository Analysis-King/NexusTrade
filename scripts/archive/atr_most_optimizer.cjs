const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const DAY = 86_400_000;
const TARGET_DAILY = 0.8;
const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed || 260614);
const screenCount = Math.max(20, Number(args.screenCount || 180));
const finalistCount = Math.max(2, Number(args.finalists || 10));
const symbolCount = Math.max(10, Number(args.symbols || 50));
const concurrency = Math.max(1, Number(args.concurrency || 6));
const leverage = Math.max(1, Number(args.leverage || 2));
const outStem = String(args.out || `atr_most_optimizer_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`)
  .replace(/[^a-zA-Z0-9_-]/g, '_');
const outJson = path.join(DATA_DIR, `${outStem}.json`);
const outMd = path.join(DATA_DIR, `${outStem}.md`);

function parseArgs(items) {
  const out = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = items[index + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function seededRandom(initialSeed) {
  let state = initialSeed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const random = seededRandom(seed);

function pick(values) {
  return values[Math.floor(random() * values.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchTopSymbols(limit) {
  const stable = new Set([
    'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1',
    'RLUSD', 'XUSD', 'EUR', 'TRY', 'BRL', 'ARS', 'AEUR', 'PAXG', 'XAUT',
  ]);
  const rows = await fetchJson('https://api.binance.com/api/v3/ticker/24hr');
  return rows
    .filter((row) => {
      const symbol = String(row.symbol || '');
      if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
      const base = symbol.slice(0, -4);
      return base.length > 1
        && !stable.has(base)
        && !/(UP|DOWN|BULL|BEAR)$/.test(base)
        && Number(row.quoteVolume || 0) > 0;
    })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((row) => row.symbol);
}

async function fetchCandles(symbol, interval, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor < endTime) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTime));
    url.searchParams.set('limit', '1000');
    const raw = await fetchJson(url);
    if (!Array.isArray(raw) || !raw.length) break;
    for (const row of raw) {
      all.push({
        t: Number(row[0]),
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
        v: Number(row[5]),
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
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.data);
      else waiter.reject(new Error(message.error || `worker ${slot} error`));
    }
  });
  child.on('exit', () => {
    alive = false;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`worker ${slot} exited`));
    }
    pending.clear();
  });
  function request(cmd, payload, timeout = 300_000) {
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

function dailyCompound(totalReturnPct, days) {
  const growth = 1 + Number(totalReturnPct || 0) / 100;
  if (!(growth > 0) || !(days > 0)) return -100;
  return (growth ** (1 / days) - 1) * 100;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function variantKey(variant) {
  return `${variant.family}|${JSON.stringify(variant.params)}`;
}

function addUnique(target, variant) {
  const key = variantKey(variant);
  if (!target.keys.has(key)) {
    target.keys.add(key);
    target.rows.push({ ...variant, id: `${variant.family}_${target.rows.length + 1}` });
  }
}

function mostVariant(index) {
  const mode = pick(['fixed', 'fixed', 'atr', 'atr']);
  const entryPairs = [
    ['flip', 'flip'],
    ['flip_reclaim', 'flip_reclaim'],
    ['retest_rejection', 'retest_rejection'],
    ['retest_confirmation', 'retest_confirmation'],
    ['retest_confirmation', 'retest_rejection'],
    ['flip', 'retest_rejection'],
    ['trend', 'trend'],
  ];
  const [longEntry, shortEntry] = pick(entryPairs);
  const stopMode = pick(['none', 'atr', 'most', 'most_atr']);
  const useTakeProfit = stopMode !== 'none' && pick([false, false, true]);
  const useRegime = pick([false, true, true]);
  const useRsi = pick([false, false, true]);
  const useStoch = pick([false, false, true]);
  const direction = pick(['both', 'both', 'both', 'long', 'short']);
  const params = {
    max_position_pct: 100,
    leverage,
    ma_period: pick([3, 5, 7, 9, 13, 21, 34]),
    ma_type: pick(['ema', 'ema', 'sma']),
    most_mode: mode,
    most_percent: pick([0.5, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4]),
    most_atr_multiplier: pick([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]),
    min_most_percent: pick([0.25, 0.5, 0.75, 1]),
    max_most_percent: pick([2, 3, 4, 5, 6]),
    long_entry_mode: longEntry,
    short_entry_mode: shortEntry,
    min_trend_age_bars: pick([0, 0, 1, 2, 4]),
    max_trend_age_bars: pick([0, 0, 12, 24, 48, 96]),
    allow_long: direction !== 'short',
    allow_short: direction !== 'long',
    exit_mode: pick(['color_flip', 'most_cross', 'ma_cross', 'none']),
    max_hold_bars: pick([0, 0, 24, 48, 72, 120]),
    cooldown_bars: pick([0, 0, 1, 3, 6]),
    use_regime_filter: useRegime,
    min_adx: pick([10, 12, 15, 18, 22, 28]),
    min_di_spread: pick([0, 0, 2, 4, 8]),
    require_di_direction: pick([false, true]),
    min_volume_ratio: pick([0, 0, 0.75, 1, 1.25, 1.5]),
    min_atr_pct: pick([0, 0, 0.1, 0.2, 0.35, 0.5]),
    max_atr_pct: pick([0, 3, 5, 8, 12]),
    require_rejection_candle: pick([false, true]),
    min_rejection_body_ratio: pick([0, 0.1, 0.2, 0.35]),
    max_retest_penetration_atr: pick([0, 0.5, 1, 1.5, 2]),
    min_close_distance_atr: pick([0, 0.05, 0.1, 0.2]),
    use_rsi_filter: useRsi,
    rsi_long_min: pick([40, 45, 50, 55]),
    rsi_long_max: pick([65, 70, 75, 82, 100]),
    rsi_short_min: pick([0, 18, 25, 30, 35]),
    rsi_short_max: pick([45, 50, 55, 60]),
    use_stoch_rsi_filter: useStoch,
    stoch_long_min: pick([0, 10, 20, 30, 40]),
    stoch_long_max: pick([70, 80, 90, 100]),
    stoch_short_min: pick([0, 10, 20, 30]),
    stoch_short_max: pick([60, 70, 80, 90, 100]),
    require_stoch_cross: pick([false, false, true]),
    stop_mode: stopMode,
    stop_atr: pick([0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]),
    min_stop_pct: pick([0.1, 0.25, 0.5, 0.75]),
    max_stop_pct: pick([2, 3, 4, 6, 8]),
    use_take_profit: useTakeProfit,
    reward_risk: pick([1, 1.25, 1.5, 2, 2.5, 3, 4]),
    exit_on_opposite_signal: true,
  };
  if (params.max_most_percent < params.min_most_percent) params.max_most_percent = params.min_most_percent;
  if (params.max_stop_pct < params.min_stop_pct) params.max_stop_pct = params.min_stop_pct;
  if (!useRegime) {
    params.min_adx = 0;
    params.min_di_spread = 0;
    params.require_di_direction = false;
    params.min_volume_ratio = 0;
    params.min_atr_pct = 0;
    params.max_atr_pct = 0;
    params.require_rejection_candle = false;
    params.min_rejection_body_ratio = 0;
    params.max_retest_penetration_atr = 0;
    params.min_close_distance_atr = 0;
  }
  if (!useRsi) params.use_rsi_filter = false;
  if (!useStoch) params.use_stoch_rsi_filter = false;
  return { family: 'MOST', file: 'most_rsi_stoch.py', name: `MOST random ${index}`, params };
}

function atrVariant(index) {
  const triples = [
    [5, 21, 55],
    [8, 21, 55],
    [9, 34, 89],
    [13, 34, 89],
    [13, 55, 144],
    [21, 55, 144],
    [21, 55, 200],
    [34, 89, 200],
    [50, 100, 200],
  ];
  const [fast, mid, slow] = pick(triples);
  const useTakeProfit = pick([false, false, true, true]);
  return {
    family: 'ATR',
    file: 'trend_atr_breakout.py',
    name: `ATR random ${index}`,
    params: {
      max_position_pct: 100,
      leverage,
      fast_ema: fast,
      mid_ema: mid,
      slow_ema: slow,
      atr_period: pick([7, 10, 14, 21, 28]),
      breakout_period: pick([5, 10, 15, 20, 30, 40, 55, 80]),
      slope_period: pick([3, 6, 12, 18, 24, 36]),
      min_slope_pct: pick([0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12]),
      min_atr_pct: pick([0, 0.05, 0.1, 0.2, 0.35, 0.5]),
      max_atr_pct: pick([2, 3, 5, 8, 12]),
      stop_atr: pick([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]),
      reward_risk: pick([0.75, 1, 1.25, 1.5, 1.8, 2, 2.5, 3, 4, 5]),
      use_take_profit: useTakeProfit,
      cooldown_bars: pick([0, 1, 3, 6, 8, 12, 24]),
      allow_short: pick([true, true, true, false]),
      exit_on_opposite_signal: true,
    },
  };
}

function localMostVariant(base, index) {
  const params = {
    ...base,
    max_position_pct: 100,
    leverage,
    ma_period: pick([5, 7, 9, 13, 21]),
    most_mode: pick(['fixed', 'fixed', 'atr']),
    most_percent: pick([0.5, 0.65, 0.8, 1, 1.25, 1.5]),
    most_atr_multiplier: pick([0.5, 0.75, 1, 1.25, 1.5]),
    long_entry_mode: pick(['retest_confirmation', 'retest_rejection', 'flip_reclaim']),
    short_entry_mode: pick(['retest_confirmation', 'retest_rejection', 'flip_reclaim']),
    min_trend_age_bars: pick([0, 1, 2, 4, 6]),
    exit_mode: pick(['none', 'most_cross', 'ma_cross', 'color_flip']),
    max_hold_bars: pick([12, 24, 36, 48, 72]),
    cooldown_bars: pick([0, 1, 3, 6]),
    use_stoch_rsi_filter: pick([false, true, true]),
    require_stoch_cross: pick([false, false, true]),
    stop_mode: pick(['atr', 'most_atr', 'most']),
    stop_atr: pick([0.75, 1, 1.25, 1.5, 2]),
    use_take_profit: pick([false, true, true]),
    reward_risk: pick([2, 3, 4, 5]),
  };
  return { family: 'MOST', file: 'most_rsi_stoch.py', name: `MOST local ${index}`, params };
}

function localAtrVariant(base, index) {
  const triples = [[13, 55, 144], [21, 55, 144], [21, 55, 200], [34, 89, 200], [50, 100, 200]];
  const [fast, mid, slow] = pick(triples);
  const params = {
    ...base,
    max_position_pct: 100,
    leverage,
    fast_ema: fast,
    mid_ema: mid,
    slow_ema: slow,
    atr_period: pick([7, 10, 14, 21]),
    breakout_period: pick([10, 15, 20, 30, 40, 55]),
    slope_period: pick([3, 6, 12, 18]),
    min_slope_pct: pick([0.01, 0.02, 0.03, 0.05, 0.08]),
    min_atr_pct: pick([0.1, 0.2, 0.35, 0.5]),
    max_atr_pct: pick([2, 3, 5, 8]),
    stop_atr: pick([0.5, 0.75, 1, 1.25, 1.5, 2]),
    reward_risk: pick([1, 1.5, 2, 2.5, 3, 4]),
    use_take_profit: pick([false, false, true]),
    cooldown_bars: pick([0, 1, 3, 6, 12]),
    allow_short: pick([true, true, true, false]),
  };
  return { family: 'ATR', file: 'trend_atr_breakout.py', name: `ATR local ${index}`, params };
}

function buildVariants() {
  const most = { rows: [], keys: new Set() };
  const atr = { rows: [], keys: new Set() };
  addUnique(most, {
    family: 'MOST',
    file: 'most_rsi_stoch.py',
    name: 'MOST baseline 5/2',
    params: {
      max_position_pct: 100,
      leverage,
      ma_period: 5,
      most_percent: 2,
      most_mode: 'fixed',
      entry_mode: 'flip_reclaim',
      allow_long: true,
      allow_short: true,
      exit_on_color_flip: true,
      stop_mode: 'none',
      use_take_profit: false,
      exit_on_opposite_signal: true,
    },
  });
  addUnique(atr, {
    family: 'ATR',
    file: 'trend_atr_breakout.py',
    name: 'ATR baseline',
    params: {
      max_position_pct: 100,
      leverage,
      fast_ema: 21,
      mid_ema: 55,
      slow_ema: 144,
      atr_period: 14,
      breakout_period: 20,
      slope_period: 12,
      min_slope_pct: 0.02,
      min_atr_pct: 0.08,
      max_atr_pct: 3,
      stop_atr: 1.4,
      reward_risk: 1.8,
      use_take_profit: false,
      cooldown_bars: 8,
      allow_short: true,
      exit_on_opposite_signal: true,
    },
  });

  for (const filename of fs.readdirSync(DATA_DIR)) {
    let target = null;
    let family = null;
    let file = null;
    if (/^scan_most.*\.json$/i.test(filename)) {
      target = most;
      family = 'MOST';
      file = 'most_rsi_stoch.py';
    } else if (/^scan_trend_atr.*\.json$/i.test(filename)) {
      target = atr;
      family = 'ATR';
      file = 'trend_atr_breakout.py';
    }
    if (!target) continue;
    try {
      const params = JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
      addUnique(target, {
        family,
        file,
        name: `Saved ${path.basename(filename, '.json')}`,
        params: { max_position_pct: 100, leverage, ...params },
      });
    } catch {
      // Ignore incomplete historical parameter files.
    }
  }

  const bestMostPath = path.join(DATA_DIR, 'best_most_optimized_params.json');
  const bestAtrPath = path.join(DATA_DIR, 'best_atr_optimized_params.json');
  if (fs.existsSync(bestMostPath)) {
    const bestMost = JSON.parse(fs.readFileSync(bestMostPath, 'utf8'));
    addUnique(most, { family: 'MOST', file: 'most_rsi_stoch.py', name: 'MOST previous best', params: bestMost });
    for (let index = 1; index <= Math.floor(screenCount * 0.45); index += 1) {
      addUnique(most, localMostVariant(bestMost, index));
    }
  }
  if (fs.existsSync(bestAtrPath)) {
    const bestAtr = JSON.parse(fs.readFileSync(bestAtrPath, 'utf8'));
    addUnique(atr, { family: 'ATR', file: 'trend_atr_breakout.py', name: 'ATR previous best', params: bestAtr });
    for (let index = 1; index <= Math.floor(screenCount * 0.45); index += 1) {
      addUnique(atr, localAtrVariant(bestAtr, index));
    }
  }

  for (let index = 1; most.rows.length < screenCount; index += 1) addUnique(most, mostVariant(index));
  for (let index = 1; atr.rows.length < screenCount; index += 1) addUnique(atr, atrVariant(index));
  return [...most.rows, ...atr.rows];
}

async function runBacktest(worker, dataset, variant, startTime, reportDays) {
  const instance = `opt_${variant.id}_${randomUUID().replaceAll('-', '')}`;
  await worker.request('load', { instance, strategy_file: variant.file, params: variant.params });
  try {
    const result = await worker.request('backtest', {
      instance,
      candles: dataset.candles,
      initial_capital: 1000,
      fee_bps: 10,
      slippage_bps: 2,
      fill_model: 'pessimistic_ohlc',
      start_time: startTime,
      params: variant.params,
    });
    const summary = result.summary || {};
    return {
      variantId: variant.id,
      family: variant.family,
      symbol: dataset.symbol,
      interval: dataset.interval,
      reportDays,
      totalReturnPct: Number(summary.totalReturnPct || 0),
      dailyPct: dailyCompound(Number(summary.totalReturnPct || 0), reportDays),
      maxDrawdownPct: Number(summary.maxDrawdownPct || 0),
      trades: Number(summary.totalTrades || 0),
      winRatePct: Number(summary.winRatePct || 0),
      profitFactor: Number(summary.profitFactor || 0),
    };
  } finally {
    await worker.request('drop', { instance }, 30_000).catch(() => undefined);
  }
}

async function runTasks(tasks, datasets, variants, label) {
  const queue = [...tasks];
  const results = [];
  const progress = { done: 0, total: queue.length };
  async function loop(slot) {
    let worker = startWorker(slot);
    try {
      while (queue.length) {
        const task = queue.shift();
        if (!task) break;
        if (!worker.isAlive()) {
          worker.child.kill();
          worker = startWorker(slot);
        }
        try {
          const row = await runBacktest(
            worker,
            datasets.get(task.datasetKey),
            variants.get(task.variantId),
            task.startTime,
            task.reportDays,
          );
          results.push(row);
        } catch (error) {
          results.push({ ...task, error: error.message });
        }
        progress.done += 1;
        if (progress.done % 100 === 0 || progress.done === progress.total) {
          console.log(`${label}: ${progress.done}/${progress.total}`);
        }
      }
    } finally {
      worker.child.kill();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, (_, index) => loop(index + 1)));
  return results;
}

function aggregateVariant(variant, rows, stage) {
  const valid = rows.filter((row) => !row.error && row.variantId === variant.id);
  const daily = valid.map((row) => row.dailyPct);
  const dd = valid.map((row) => row.maxDrawdownPct);
  const positive = daily.filter((value) => value > 0).length;
  const target = daily.filter((value) => value >= TARGET_DAILY).length;
  const active = valid.filter((row) => row.trades > 0).length;
  const blown = valid.filter((row) => row.totalReturnPct <= -100).length;
  const avgDaily = mean(daily) ?? -100;
  const medianDaily = median(daily) ?? -100;
  const avgDd = mean(dd) ?? 100;
  const worstDaily = daily.length ? Math.min(...daily) : -100;
  const positivePct = valid.length ? positive * 100 / valid.length : 0;
  const targetPct = valid.length ? target * 100 / valid.length : 0;
  const activePct = valid.length ? active * 100 / valid.length : 0;
  const score = (
    medianDaily * 5
    + avgDaily * 2
    + worstDaily * 1.5
    + positivePct * 0.025
    + targetPct * 0.05
    + activePct * 0.005
    - avgDd * 0.025
    - blown * 10
  );
  return {
    stage,
    variantId: variant.id,
    family: variant.family,
    file: variant.file,
    name: variant.name,
    cases: valid.length,
    activePct: round(activePct, 2),
    positivePct: round(positivePct, 2),
    targetPct: round(targetPct, 2),
    avgDailyPct: round(avgDaily),
    medianDailyPct: round(medianDaily),
    worstDailyPct: round(worstDaily),
    bestDailyPct: round(daily.length ? Math.max(...daily) : -100),
    avgDrawdownPct: round(avgDd, 2),
    medianDrawdownPct: round(median(dd) ?? 100, 2),
    avgTrades: round(mean(valid.map((row) => row.trades)) ?? 0, 2),
    blown,
    score: round(score, 4),
    params: variant.params,
  };
}

function summarize(variants, rows, stage) {
  return variants
    .map((variant) => aggregateVariant(variant, rows, stage))
    .sort((a, b) => b.score - a.score);
}

function markdown(report) {
  const lines = [];
  lines.push('# ATR ve MOST Parametre Optimizasyonu');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target: günlük bileşik %${TARGET_DAILY}`);
  lines.push(`Varsayimlar: ${leverage}x, %0.10 komisyon, %0.02 slippage, pessimistic OHLC.`);
  lines.push('');
  lines.push('## Sonuc');
  lines.push('');
  lines.push(`- Hedefi evrensel medyanda geçen aday: **${report.conclusion.targetReached ? 'VAR' : 'YOK'}**`);
  lines.push(`- En iyi doğrulama adayı: **${report.conclusion.best?.variantId || '-'}**`);
  lines.push(`- Medyan günlük: **%${report.conclusion.best?.medianDailyPct ?? '-'}**, ortalama günlük: **%${report.conclusion.best?.avgDailyPct ?? '-'}**`);
  lines.push(`- Pozitif test oranı: **%${report.conclusion.best?.positivePct ?? '-'}**, hedef test oranı: **%${report.conclusion.best?.targetPct ?? '-'}**`);
  lines.push('');
  lines.push('## Doğrulama Siralamasi');
  lines.push('');
  lines.push('| # | Aile | Aday | Medyan Gunluk % | Ort. Gunluk % | En Kotu % | Pozitif % | >=0.8 % | Ort. DD % | Islem |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|');
  report.validationSummary.slice(0, 30).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.family} | ${row.variantId} | ${row.medianDailyPct} | ${row.avgDailyPct} | ${row.worstDailyPct} | ${row.positivePct} | ${row.targetPct} | ${row.avgDrawdownPct} | ${row.avgTrades} |`);
  });
  lines.push('');
  lines.push('## Tarama Siralamasi');
  lines.push('');
  lines.push('| # | Aile | Aday | Medyan Gunluk % | Ort. Gunluk % | Pozitif % | >=0.8 % | Ort. DD % |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|');
  report.screenSummary.slice(0, 20).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.family} | ${row.variantId} | ${row.medianDailyPct} | ${row.avgDailyPct} | ${row.positivePct} | ${row.targetPct} | ${row.avgDrawdownPct} |`);
  });
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function save(report) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
  fs.writeFileSync(outMd, markdown(report));
  for (const family of ['MOST', 'ATR']) {
    const best = report.validationSummary.find((row) =>
      row.family === family && row.activePct >= 50 && row.blown === 0
    );
    if (best) {
      fs.writeFileSync(
        path.join(DATA_DIR, `best_${family.toLowerCase()}_optimized_params.json`),
        JSON.stringify(best.params, null, 2),
      );
    }
  }
}

async function fetchDatasets(profiles, days, label) {
  const datasets = new Map();
  let done = 0;
  const queue = [...profiles];
  async function loop() {
    while (queue.length) {
      const profile = queue.shift();
      if (!profile) break;
      const key = `${profile.symbol}:${profile.interval}`;
      try {
        const candles = await fetchCandles(profile.symbol, profile.interval, days);
        if (candles.length >= 300) datasets.set(key, { ...profile, key, candles });
      } catch (error) {
        console.log(`${label} veri hatasi ${key}: ${error.message}`);
      }
      done += 1;
      if (done % 10 === 0 || done === profiles.length) console.log(`${label} veri: ${done}/${profiles.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, profiles.length) }, () => loop()));
  return datasets;
}

async function main() {
  console.log(`ATR/MOST optimizer: seed=${seed}, variants/family=${screenCount}, finalists/family=${finalistCount}`);
  const variants = buildVariants();
  const variantMap = new Map(variants.map((variant) => [variant.id, variant]));

  const screenSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const screenProfiles = screenSymbols.flatMap((symbol) => ['1h', '4h'].map((interval) => ({ symbol, interval })));
  const screenDatasets = await fetchDatasets(screenProfiles, 270, 'screen');
  const screenStart = Date.now() - 180 * DAY;
  const screenTasks = variants.flatMap((variant) => [...screenDatasets.values()].map((dataset) => ({
    variantId: variant.id,
    datasetKey: dataset.key,
    startTime: screenStart,
    reportDays: 180,
  })));
  const screenRows = await runTasks(screenTasks, screenDatasets, variantMap, 'screen');
  const screenSummary = summarize(variants, screenRows, 'screen');

  const finalists = ['MOST', 'ATR'].flatMap((family) => (
    screenSummary
      .filter((row) => row.family === family && row.activePct >= 50 && row.blown === 0)
      .slice(0, finalistCount)
      .map((row) => variantMap.get(row.variantId))
  ));
  console.log(`Finalistler: ${finalists.map((variant) => variant.id).join(', ')}`);

  const symbols = await fetchTopSymbols(symbolCount);
  const validationProfiles = symbols.flatMap((symbol) => ['1h', '4h'].map((interval) => ({ symbol, interval })));
  const validationDatasets = await fetchDatasets(validationProfiles, 180, 'validation');
  const validationStart = Date.now() - 90 * DAY;
  const validationTasks = finalists.flatMap((variant) => [...validationDatasets.values()].map((dataset) => ({
    variantId: variant.id,
    datasetKey: dataset.key,
    startTime: validationStart,
    reportDays: 90,
  })));
  const validationRows = await runTasks(validationTasks, validationDatasets, variantMap, 'validation');
  const validationSummary = summarize(finalists, validationRows, 'validation');
  const best = validationSummary.find((row) => row.activePct >= 50 && row.blown === 0) || null;
  const report = {
    generatedAt: new Date().toISOString(),
    assumptions: {
      targetDailyPct: TARGET_DAILY,
      feeBps: 10,
      slippageBps: 2,
      leverage,
      fillModel: 'pessimistic_ohlc',
      screenDays: 180,
      validationDays: 90,
      validationSymbols: symbols.length,
      validationIntervals: ['1h', '4h'],
      seed,
    },
    variantsTested: variants.length,
    finalistsTested: finalists.length,
    screenProfiles: [...screenDatasets.keys()],
    validationProfiles: [...validationDatasets.keys()],
    conclusion: {
      targetReached: Boolean(best && best.medianDailyPct >= TARGET_DAILY && best.positivePct >= 60 && best.blown === 0),
      best,
    },
    screenSummary,
    validationSummary,
    screenRows,
    validationRows,
  };
  save(report);
  console.table(validationSummary.slice(0, 20).map((row) => ({
    family: row.family,
    variant: row.variantId,
    medDaily: row.medianDailyPct,
    avgDaily: row.avgDailyPct,
    worst: row.worstDailyPct,
    positive: row.positivePct,
    target: row.targetPct,
    dd: row.avgDrawdownPct,
    trades: row.avgTrades,
  })));
  console.log(`Done: ${outMd}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
