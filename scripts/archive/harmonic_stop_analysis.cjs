const { spawn } = require('node:child_process');

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchCandles(symbol, interval, days) {
  const endTime = Date.now();
  let cursor = endTime - days * DAY;
  const all = [];
  while (cursor <= endTime) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    Object.entries({ symbol, interval, startTime: cursor, endTime, limit: 1000 }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} ${interval} Binance ${res.status}: ${await res.text()}`);
    const raw = await res.json();
    if (!raw.length) break;
    for (const k of raw) {
      all.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    }
    const next = +raw.at(-1)[6] + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(35);
  }
  return [...new Map(all.map((candle) => [candle.t, candle])).values()].sort((a, b) => a.t - b.t);
}

async function fetchTopUsdtSymbols(limit = 20) {
  const stableOrFiat = new Set([
    'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1',
    'RLUSD', 'XUSD', 'EUR', 'TRY', 'BRL', 'ARS', 'AEUR', 'PAXG', 'XAUT',
  ]);
  const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
  if (!res.ok) throw new Error(`Binance ticker ${res.status}: ${await res.text()}`);
  const tickers = await res.json();
  return tickers
    .filter((item) => {
      const symbol = String(item.symbol || '');
      if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
      const base = symbol.slice(0, -4);
      if (base.length < 2 || stableOrFiat.has(base)) return false;
      if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
      return Number(item.quoteVolume || 0) > 0;
    })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((item) => item.symbol);
}

function startWorker() {
  const child = spawn('python', ['-u', 'python/workers/pool_worker.py'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {});

  let buffer = '';
  let seq = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.data);
      else waiter.reject(new Error(msg.error || 'worker error'));
    }
  });

  function request(cmd, payload, timeout = 420_000) {
    const id = `stop_${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout ${cmd}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  }

  return { child, request };
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarizeResult(symbol, result) {
  const trades = result.trades || [];
  const reasons = {};
  const patternStats = {};
  for (const trade of trades) {
    reasons[trade.reason] = (reasons[trade.reason] || 0) + 1;
    const pattern = trade.meta?.pattern || 'unknown';
    const stats = patternStats[pattern] || { trades: 0, netPnl: 0, sl: 0, tp: 0, signal: 0, end: 0 };
    stats.trades += 1;
    stats.netPnl += Number(trade.netPnl || 0);
    if (trade.reason === 'sl') stats.sl += 1;
    if (trade.reason === 'tp') stats.tp += 1;
    if (trade.reason === 'signal') stats.signal += 1;
    if (trade.reason === 'end_of_test') stats.end += 1;
    patternStats[pattern] = stats;
  }
  return {
    symbol,
    ret: result.summary?.totalReturnPct ?? 0,
    win: result.summary?.winRatePct ?? 0,
    pf: result.summary?.profitFactor ?? null,
    dd: result.summary?.maxDrawdownPct ?? 0,
    trades: trades.length,
    reasons,
    patternStats,
  };
}

async function main() {
  const interval = process.argv[2] || '1h';
  const days = Number(process.argv[3] || 90);
  const targetCount = Number(process.argv[4] || 20);
  const { child, request } = startWorker();
  const symbols = await fetchTopUsdtSymbols(targetCount);
  const baseParams = {
    allow_repaint: true,
    allow_short: true,
    exit_mode: 'tp2_trail',
    take_profit_mode: 'target_1',
    stop_loss_mode: 'strategy',
    min_reward_risk: 0.5,
    recent_signal_bars: 3,
    breakeven_buffer_pct: 0.02,
    trail_atr_period: 14,
    trail_atr_mult: 1.1,
    max_position_pct: 100,
    leverage: 3,
    trade_filters: [
      { pattern: '5-0', zigzag_length: 20, direction: 'bullish' },
      { pattern: 'White Swan', zigzag_length: 15, direction: 'bearish' },
      { pattern: '5-0', zigzag_length: 5, direction: 'bearish' },
      { pattern: '5-0', zigzag_length: 10, direction: 'bullish' },
    ],
  };
  const variants = [
    ['r1', 1],
    ['r1.5', 1.5],
    ['r2', 2],
  ];

  const output = [];
  for (const [variantName, stop_loss_target_ratio] of variants) {
    const rows = [];
    for (const symbol of symbols) {
      const candles = await fetchCandles(symbol, interval, days);
      const params = { ...baseParams, stop_loss_target_ratio };
      const instance = `${variantName}_${symbol}_${Date.now().toString(36)}`;
      await request('load', { instance, strategy_file: 'pine_harmonic_patterns.py', params });
      const result = await request('backtest', {
        instance,
        candles,
        initial_capital: 1000,
        fee_bps: 10,
        slippage_bps: 2,
        fill_model: 'pessimistic_ohlc',
        params,
      }, 420_000);
      await request('drop', { instance }).catch(() => {});
      rows.push(summarizeResult(symbol, result));
      console.log(`[${variantName}] ${rows.length}/${symbols.length} ${symbol} ret=${result.summary?.totalReturnPct}% trades=${result.summary?.totalTrades}`);
    }

    const reasonTotals = {};
    const patternTotals = {};
    for (const row of rows) {
      for (const [reason, count] of Object.entries(row.reasons)) {
        reasonTotals[reason] = (reasonTotals[reason] || 0) + count;
      }
      for (const [pattern, stats] of Object.entries(row.patternStats)) {
        const total = patternTotals[pattern] || { trades: 0, netPnl: 0, sl: 0, tp: 0, signal: 0, end: 0 };
        total.trades += stats.trades;
        total.netPnl += stats.netPnl;
        total.sl += stats.sl;
        total.tp += stats.tp;
        total.signal += stats.signal;
        total.end += stats.end;
        patternTotals[pattern] = total;
      }
    }

    output.push({
      variant: variantName,
      stop_loss_target_ratio,
      avgReturn: rows.reduce((sum, row) => sum + row.ret, 0) / rows.length,
      medianReturn: median(rows.map((row) => row.ret)),
      avgTrades: rows.reduce((sum, row) => sum + row.trades, 0) / rows.length,
      reasonTotals,
      patternTotals,
      sampleRows: rows.slice(0, 5),
    });
  }

  console.log(JSON.stringify({ interval, days, symbols, output }, null, 2));
  child.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
