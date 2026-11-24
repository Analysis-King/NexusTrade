#!/usr/bin/env node

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DAY = 86_400_000;
const ROOT = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(ROOT, args.manifest || 'data/paper_forward_candidates.json');
const lookbackDays = positiveNumber(args.lookbackDays, 730);
const holdoutDays = positiveNumber(args.holdoutDays, 90);
const endMs = args.endTime ? Number(args.endTime) : Date.now();
const startMs = endMs - lookbackDays * DAY;
const holdoutStartMs = endMs - holdoutDays * DAY;
const outputBase = String(args.out || 'paper_candidate_replay_latest').replace(/[^a-zA-Z0-9_-]/g, '_');
const outJson = path.join(ROOT, 'data', `${outputBase}.json`);
const outMd = path.join(ROOT, 'data', `${outputBase}.md`);

main().catch((error) => {
  console.error(`Replay hatasi: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const tasks = manifest.candidates.map((candidate) => ({ candidate, manifest }));
  const results = [];

  console.log(
    `Replay basliyor: aday=${tasks.length}, tam=${lookbackDays} gun, kor=${holdoutDays} gun`
  );
  await Promise.all(
    tasks.map(async (task, index) => {
      const result = await replayCandidate(task.manifest, task.candidate, index + 1);
      results.push(result);
      console.log(
        `${task.candidate.name}: kor gunluk=${result.holdout.dailyReturnPct}% ` +
          `getiri=${result.holdout.summary.totalReturnPct}% islem=${result.holdout.summary.totalTrades}`
      );
    })
  );

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    assumptions: {
      engine: 'universal_on_candle',
      signalFill: 'next_open',
      fillModel: 'pessimistic_ohlc',
      sameCandleTpSl: 'stop_first',
      futureDataVisible: false,
      lookbackDays,
      holdoutDays,
      startTime: startMs,
      holdoutStartTime: holdoutStartMs,
      endTime: endMs,
    },
    targetDailyReturnPct: Number(manifest.defaults?.health?.targetDailyReturnPct || 0.8),
    candidates: results.sort((a, b) => b.holdout.dailyReturnPct - a.holdout.dailyReturnPct),
  };
  fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outMd, markdown(report));
  console.log(`JSON: ${outJson}`);
  console.log(`Rapor: ${outMd}`);
}

async function replayCandidate(manifest, candidate, slot) {
  const worker = startWorker(slot);
  try {
    const candles = await fetchCandles(candidate.symbol, candidate.interval, startMs, endMs);
    if (candles.length < 500) throw new Error(`${candidate.name}: yetersiz mum (${candles.length})`);

    const params = executionParams(manifest.defaults || {}, candidate);
    const trainingCandles = candles.filter((candle) => candle.t < holdoutStartMs);
    const full = await run(worker, candidate, params, candles, 0);
    const training = await run(worker, candidate, params, trainingCandles, 0);
    const holdout = await run(worker, candidate, params, candles, holdoutStartMs);
    const targetDailyReturnPct = Number(manifest.defaults?.health?.targetDailyReturnPct || 0.8);

    return {
      key: candidate.key,
      name: candidate.name,
      symbol: candidate.symbol,
      interval: candidate.interval,
      strategyId: candidate.strategyId,
      params,
      candleCount: candles.length,
      baseline: candidate.baseline || {},
      full: analyzeRun(full, startMs, endMs, targetDailyReturnPct),
      training: analyzeRun(training, startMs, holdoutStartMs, targetDailyReturnPct),
      holdout: analyzeRun(holdout, holdoutStartMs, endMs, targetDailyReturnPct),
    };
  } finally {
    worker.kill();
  }
}

async function run(worker, candidate, params, candles, tradeStartTime) {
  const instance = `replay_${candidate.key}_${randomUUID().replaceAll('-', '')}`;
  await worker.request('load', {
    instance,
    strategy_file: candidate.strategyId,
    params,
  });
  try {
    return await worker.request(
      'backtest',
      {
        instance,
        candles,
        initial_capital: Number(params.initial_capital || 1000),
        fee_bps: Number(params.fee_bps || 0),
        slippage_bps: Number(params.slippage_bps || 0),
        fill_model: 'pessimistic_ohlc',
        start_time: tradeStartTime,
        params,
      },
      900_000
    );
  } finally {
    await worker.request('drop', { instance }, 30_000).catch(() => undefined);
  }
}

function executionParams(defaults, candidate) {
  const risk = { ...(defaults.risk || {}), ...(candidate.risk || {}) };
  return {
    ...(defaults.strategyParams || {}),
    ...(candidate.strategyParams || {}),
    initial_capital: Number(candidate.capitalUsd || defaults.capitalUsd || 1000),
    max_position_usd: Number(risk.maxPositionUsd || 1000),
    leverage: Number(risk.leverage || 1),
    stop_loss_pct: Number(risk.maxLossPct || 2),
    take_profit_pct: Number(risk.takeProfitPct || 4),
    stop_loss_mode: risk.stopLossMode || 'strategy',
    stop_loss_target_ratio: Number(risk.stopLossTargetRatio || 1),
    same_candle_tp_sl: 'stop_first',
    report_period_days: 30,
  };
}

function analyzeRun(raw, periodStart, periodEnd, targetDailyReturnPct) {
  const days = Math.max((periodEnd - periodStart) / DAY, 1 / 24);
  const summary = raw.summary || {};
  const totalReturnPct = Number(summary.totalReturnPct || 0);
  const trades = (raw.trades || []).filter((trade) => Number(trade.exitTime) >= periodStart);
  const equity = (raw.equity || []).filter(
    (point) => Number(point.t) >= periodStart && Number(point.t) <= periodEnd
  );
  const months = calendarPeriods(equity, trades, 'month');
  const windows90d = fixedPeriods(equity, trades, periodStart, periodEnd, 90);
  const feesUsd = sum(trades.map((trade) => Number(trade.feePaid || 0)));
  const reasons = countBy(trades, (trade) => trade.reason || 'unknown');
  const sides = countBy(trades, (trade) => trade.side || 'unknown');

  return {
    days: round(days, 2),
    dailyReturnPct: round(compoundDailyPct(totalReturnPct, days), 4),
    targetReached: compoundDailyPct(totalReturnPct, days) >= targetDailyReturnPct,
    summary,
    feesUsd: round(feesUsd, 4),
    reasons,
    sides,
    positiveMonths: months.filter((month) => month.returnPct > 0).length,
    totalMonths: months.length,
    positive90dWindows: windows90d.filter((window) => window.returnPct > 0).length,
    target90dWindows: windows90d.filter(
      (window) => window.dailyReturnPct >= targetDailyReturnPct
    ).length,
    total90dWindows: windows90d.length,
    months,
    windows90d,
    trades,
  };
}

function calendarPeriods(equity, trades, mode) {
  if (!equity.length) return [];
  const groups = new Map();
  for (const point of equity) {
    const date = new Date(Number(point.t));
    const key =
      mode === 'month'
        ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
        : date.toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  }
  return [...groups.entries()].map(([key, points]) => periodRow(key, points, trades));
}

function fixedPeriods(equity, trades, periodStart, periodEnd, days) {
  const rows = [];
  for (let start = periodStart; start < periodEnd; start += days * DAY) {
    const end = Math.min(periodEnd, start + days * DAY);
    const points = equity.filter((point) => Number(point.t) >= start && Number(point.t) <= end);
    if (points.length < 2) continue;
    rows.push(periodRow(`${isoDate(start)} - ${isoDate(end)}`, points, trades));
  }
  return rows;
}

function periodRow(label, points, trades) {
  const start = points[0];
  const end = points.at(-1);
  const startValue = Number(start.value || 0);
  const endValue = Number(end.value || 0);
  const rows = trades.filter(
    (trade) => Number(trade.exitTime) >= Number(start.t) && Number(trade.exitTime) <= Number(end.t)
  );
  return {
    label,
    startTime: Number(start.t),
    endTime: Number(end.t),
    returnPct: round(startValue ? ((endValue - startValue) / startValue) * 100 : 0, 3),
    pnlUsd: round(endValue - startValue, 3),
    trades: rows.length,
    winRatePct: rows.length
      ? round((rows.filter((trade) => Number(trade.netPnl) > 0).length / rows.length) * 100, 2)
      : null,
    maxDrawdownPct: round(drawdown(points), 3),
    dailyReturnPct: round(
      compoundDailyPct(
        startValue ? ((endValue - startValue) / startValue) * 100 : 0,
        Math.max((Number(end.t) - Number(start.t)) / DAY, 1 / 24)
      ),
      4
    ),
  };
}

async function fetchCandles(symbol, interval, from, to) {
  const rows = [];
  let cursor = from;
  while (cursor <= to) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(to));
    url.searchParams.set('limit', '1000');
    const raw = await fetchJson(url);
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const candle of raw) {
      rows.push({
        t: Number(candle[0]),
        o: Number(candle[1]),
        h: Number(candle[2]),
        l: Number(candle[3]),
        c: Number(candle[4]),
        v: Number(candle[5]),
      });
    }
    const next = Number(raw.at(-1)[6]) + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(30);
  }
  return [...new Map(rows.map((row) => [row.t, row])).values()]
    .filter((row) => row.t >= from && row.t <= to)
    .sort((a, b) => a.t - b.t);
}

async function fetchJson(url, tries = 5) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
      return response.json();
    } catch (error) {
      lastError = error;
      await sleep(attempt * 600);
    }
  }
  throw lastError;
}

function startWorker(slot) {
  const python = process.env.PYTHON_BIN || 'python';
  const child = spawn(python, ['-u', 'python/workers/pool_worker.py'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
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
  child.stderr.on('data', (chunk) => {
    if (args.verbose) process.stderr.write(chunk);
  });
  child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`worker ${slot} kapandi: code=${code} signal=${signal}`));
    }
    pending.clear();
  });
  return {
    request(cmd, payload, timeout = 120_000) {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`worker ${slot} timeout: ${cmd}`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
      });
    },
    kill() {
      child.kill();
    },
  };
}

function markdown(report) {
  const lines = [
    '# Paper Adaylari Kronolojik Replay',
    '',
    `Olusturulma: ${report.generatedAt}`,
    `Tam donem: ${report.assumptions.lookbackDays} gun`,
    `Kor dogrulama: son ${report.assumptions.holdoutDays} gun`,
    `Hedef: gunluk %${report.targetDailyReturnPct}`,
    '',
    'Sinyaller yalnizca o ana kadar gorulen mumlarla uretilir ve sonraki mum acilisinda doldurulur. TP ve SL ayni mumda gorulurse SL once kabul edilir.',
    '',
    '## Son 90 Gun Kor Dogrulama',
    '',
    '| Aday | Getiri | Gunluk | Hedef | Islem | Win | PF | Max DD | Ucret | Pozitif Ay |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.candidates) {
    lines.push(summaryLine(row.name, row.holdout, report.targetDailyReturnPct));
  }
  lines.push(
    '',
    '## Onceki Donem',
    '',
    '| Aday | Getiri | Gunluk | Hedef | Islem | Win | PF | Max DD | Ucret | Pozitif Ay |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  );
  for (const row of report.candidates) {
    lines.push(summaryLine(row.name, row.training, report.targetDailyReturnPct));
  }
  lines.push(
    '',
    '## 730 Gunluk 90 Gun Pencere Dayanikliligi',
    '',
    '| Aday | Hedefe Ulasan | Pozitif | Toplam | Tam Donem Gunluk | Tam Donem Max DD |',
    '|---|---:|---:|---:|---:|---:|'
  );
  for (const row of report.candidates) {
    lines.push(
      `| ${row.name} | ${row.full.target90dWindows}/${row.full.total90dWindows} | ${row.full.positive90dWindows}/${row.full.total90dWindows} | ${row.full.total90dWindows} | %${row.full.dailyReturnPct} | %${row.full.summary.maxDrawdownPct || 0} |`
    );
  }
  lines.push('', '## Son 90 Gun Aylik Dagilim', '');
  for (const row of report.candidates) {
    lines.push(`### ${row.name}`, '', '| Ay | Getiri | PnL | Islem | Win | Max DD |', '|---|---:|---:|---:|---:|---:|');
    for (const month of row.holdout.months) {
      lines.push(
        `| ${month.label} | %${month.returnPct} | $${month.pnlUsd} | ${month.trades} | ${fmt(month.winRatePct)} | %${month.maxDrawdownPct} |`
      );
    }
    lines.push('');
  }
  lines.push(
    '## Not',
    '',
    'Bu replay gecmis performansi olcer; gelecek getiriyi garanti etmez. Canli paper testi, replay sonucunun piyasa akisi ve sistem yukunde korunup korunmadigini dogrular.',
    ''
  );
  return lines.join('\n');
}

function summaryLine(name, run, target) {
  const summary = run.summary || {};
  return `| ${name} | %${summary.totalReturnPct || 0} | %${run.dailyReturnPct} | ${run.dailyReturnPct >= target ? 'EVET' : 'HAYIR'} | ${summary.totalTrades || 0} | %${summary.winRatePct || 0} | ${summary.profitFactor ?? '-'} | %${summary.maxDrawdownPct || 0} | $${run.feesUsd} | ${run.positiveMonths}/${run.totalMonths} |`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith('--')) continue;
    const equal = item.indexOf('=');
    if (equal >= 0) parsed[item.slice(2, equal)] = item.slice(equal + 1);
    else if (values[index + 1] && !values[index + 1].startsWith('--')) parsed[item.slice(2)] = values[++index];
    else parsed[item.slice(2)] = true;
  }
  return parsed;
}

function countBy(rows, selector) {
  const out = {};
  for (const row of rows) {
    const key = selector(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function drawdown(points) {
  let peak = Number(points[0]?.value || 0);
  let maximum = 0;
  for (const point of points) {
    const value = Number(point.value || 0);
    peak = Math.max(peak, value);
    if (peak > 0) maximum = Math.max(maximum, ((peak - value) / peak) * 100);
  }
  return maximum;
}

function compoundDailyPct(totalReturnPct, days) {
  const ratio = 1 + Number(totalReturnPct || 0) / 100;
  return ratio <= 0 ? -100 : (Math.pow(ratio, 1 / days) - 1) * 100;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function fmt(value) {
  return value === null || value === undefined ? '-' : `%${value}`;
}
