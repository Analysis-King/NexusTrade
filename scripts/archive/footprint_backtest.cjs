const { spawn } = require('node:child_process');

const MAX_LEVELS = 240;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function intervalMs(interval) {
  const match = /^(\d+)(m|h)$/.exec(interval);
  if (!match) throw new Error(`Desteklenmeyen interval: ${interval}`);
  return Number(match[1]) * (match[2] === 'm' ? 60_000 : 3_600_000);
}

async function fetchJson(url, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url);
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    throw new Error(`Binance ${response.status}: ${await response.text()}`);
  }
  throw new Error('Binance istegi tamamlanamadi');
}

async function fetchAggTrades(symbol, startTime, endTime) {
  const trades = [];
  let fromId = null;
  let first = true;
  while (true) {
    const url = new URL('https://api.binance.com/api/v3/aggTrades');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('limit', '1000');
    if (first) url.searchParams.set('startTime', String(startTime));
    else url.searchParams.set('fromId', String(fromId));
    const page = await fetchJson(url);
    if (!page.length) break;

    let reachedEnd = false;
    for (const trade of page) {
      const time = Number(trade.T);
      if (time >= endTime) {
        reachedEnd = true;
        break;
      }
      if (time >= startTime) trades.push(trade);
    }
    const nextId = Number(page.at(-1).a) + 1;
    if (reachedEnd || page.length < 1000 || nextId === fromId) break;
    fromId = nextId;
    first = false;
    if (trades.length % 50_000 === 0) {
      process.stderr.write(`trade: ${trades.length}\n`);
    }
    await sleep(30);
  }
  return trades;
}

function compressLevels(levels) {
  if (levels.length <= MAX_LEVELS) return levels;
  const min = levels[0].price;
  const max = levels.at(-1).price;
  const width = Math.max((max - min) / MAX_LEVELS, Number.EPSILON);
  const buckets = new Map();
  for (const level of levels) {
    const index = Math.min(MAX_LEVELS - 1, Math.floor((level.price - min) / width));
    const bucket = buckets.get(index) || {
      price: level.price,
      weighted_price: 0,
      buy_volume: 0,
      sell_volume: 0,
      delta: 0,
      total_volume: 0,
      buy_trades: 0,
      sell_trades: 0,
    };
    for (const key of ['buy_volume', 'sell_volume', 'delta', 'total_volume', 'buy_trades', 'sell_trades']) {
      bucket[key] += level[key];
    }
    bucket.weighted_price += level.price * level.total_volume;
    buckets.set(index, bucket);
  }
  return [...buckets.values()]
    .map(({ weighted_price, ...level }) => ({
      ...level,
      price: level.total_volume > 0 ? weighted_price / level.total_volume : level.price,
    }))
    .sort((a, b) => a.price - b.price);
}

function buildDataset(trades, interval, startTime, endTime) {
  const ms = intervalMs(interval);
  const buckets = new Map();
  for (const trade of trades) {
    const time = Number(trade.T);
    const t = Math.floor(time / ms) * ms;
    if (t < startTime || t >= endTime) continue;
    const price = Number(trade.p);
    const qty = Number(trade.q);
    const buy = !trade.m;
    const bucket = buckets.get(t) || {
      t,
      o: price,
      h: price,
      l: price,
      c: price,
      v: 0,
      trades: 0,
      buy_trades: 0,
      sell_trades: 0,
      buy_volume: 0,
      sell_volume: 0,
      buy_notional: 0,
      sell_notional: 0,
      levels: new Map(),
    };
    bucket.h = Math.max(bucket.h, price);
    bucket.l = Math.min(bucket.l, price);
    bucket.c = price;
    bucket.v += qty;
    bucket.trades += 1;
    const level = bucket.levels.get(price) || {
      price,
      buy_volume: 0,
      sell_volume: 0,
      buy_trades: 0,
      sell_trades: 0,
    };
    if (buy) {
      bucket.buy_trades += 1;
      bucket.buy_volume += qty;
      bucket.buy_notional += price * qty;
      level.buy_trades += 1;
      level.buy_volume += qty;
    } else {
      bucket.sell_trades += 1;
      bucket.sell_volume += qty;
      bucket.sell_notional += price * qty;
      level.sell_trades += 1;
      level.sell_volume += qty;
    }
    bucket.levels.set(price, level);
    buckets.set(t, bucket);
  }

  const candles = [];
  const footprints = [];
  for (const bucket of [...buckets.values()].sort((a, b) => a.t - b.t)) {
    const levels = compressLevels(
      [...bucket.levels.values()]
        .map((level) => ({
          ...level,
          delta: level.buy_volume - level.sell_volume,
          total_volume: level.buy_volume + level.sell_volume,
        }))
        .sort((a, b) => a.price - b.price)
    );
    const poc = levels.reduce(
      (best, level) => (!best || level.total_volume > best.total_volume ? level : best),
      null
    );
    candles.push({ t: bucket.t, o: bucket.o, h: bucket.h, l: bucket.l, c: bucket.c, v: bucket.v });
    footprints.push({
      t: bucket.t,
      complete: true,
      trades: bucket.trades,
      buy_trades: bucket.buy_trades,
      sell_trades: bucket.sell_trades,
      buy_volume: bucket.buy_volume,
      sell_volume: bucket.sell_volume,
      delta: bucket.buy_volume - bucket.sell_volume,
      total_volume: bucket.buy_volume + bucket.sell_volume,
      buy_notional: bucket.buy_notional,
      sell_notional: bucket.sell_notional,
      delta_notional: bucket.buy_notional - bucket.sell_notional,
      total_notional: bucket.buy_notional + bucket.sell_notional,
      poc_price: poc?.price ?? null,
      levels,
    });
  }
  return { candles, footprints };
}

function startWorker() {
  const child = spawn('python', ['-u', 'python/workers/pool_worker.py'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.stdout.setEncoding('utf8');
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
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      message.ok ? waiter.resolve(message.data) : waiter.reject(new Error(message.error));
    }
  });
  return {
    child,
    request(cmd, payload) {
      const id = `fp_${++seq}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
      });
    },
  };
}

async function runVariant(worker, name, candles, footprints, params) {
  const instance = `footprint_${name}`;
  await worker.request('load', {
    instance,
    strategy_file: 'footprint_order_flow.py',
    params,
  });
  const result = await worker.request('backtest', {
    instance,
    candles,
    footprints,
    initial_capital: 1000,
    fee_bps: 10,
    slippage_bps: 2,
    fill_model: 'pessimistic_ohlc',
    params: {
      max_position_usd: 1000,
      stop_loss_mode: 'strategy',
      exit_on_opposite_signal: false,
      ...params,
    },
  });
  const reasons = {};
  for (const trade of result.trades || []) {
    reasons[trade.reason] = (reasons[trade.reason] || 0) + 1;
  }
  return {
    variant: name,
    ...result.summary,
    reasons,
    setups: result.observationStats,
  };
}

async function main() {
  const symbol = String(process.argv[2] || 'BTCUSDT').toUpperCase();
  const interval = process.argv[3] || '1m';
  const hours = Math.max(1, Number(process.argv[4] || 2));
  const ms = intervalMs(interval);
  const endTime = Math.floor(Date.now() / ms) * ms;
  const startTime = endTime - hours * 3_600_000;
  process.stderr.write(`${symbol} ${interval}: ${new Date(startTime).toISOString()} -> ${new Date(endTime).toISOString()}\n`);
  const trades = await fetchAggTrades(symbol, startTime, endTime);
  const { candles, footprints } = buildDataset(trades, interval, startTime, endTime);
  if (candles.length < 10) throw new Error(`Yetersiz footprint mumu: ${candles.length}`);

  const worker = startWorker();
  try {
    const variants = [
      ['absorption_only', {
        enable_absorption: true,
        enable_failed_auction: false,
        enable_delta_divergence: false,
      }],
      ['sell_absorption_long_only', {
        enable_absorption: true,
        enable_failed_auction: false,
        enable_delta_divergence: false,
        allow_short: false,
      }],
      ['buy_absorption_short_only', {
        enable_absorption: true,
        enable_failed_auction: false,
        enable_delta_divergence: false,
        allow_long: false,
      }],
      ['failed_auction_only', {
        enable_absorption: false,
        enable_failed_auction: true,
        enable_delta_divergence: false,
      }],
      ['delta_divergence_only', {
        enable_absorption: false,
        enable_failed_auction: false,
        enable_delta_divergence: true,
      }],
      ['delta_divergence_long_only', {
        enable_absorption: false,
        enable_failed_auction: false,
        enable_delta_divergence: true,
        allow_short: false,
      }],
      ['combined_any', {}],
      ['combined_confluence_2', {
        min_confluence: 2,
        absorption_delta_pct: 14,
        delta_divergence_min_pct: 10,
        auction_extreme_activity_ratio: 0.8,
        rejection_wick_pct: 0.2,
      }],
      ['inverse_absorption', {
        enable_absorption: true,
        enable_failed_auction: false,
        enable_delta_divergence: false,
        invert_signals: true,
      }],
      ['inverse_delta_divergence', {
        enable_absorption: false,
        enable_failed_auction: false,
        enable_delta_divergence: true,
        invert_signals: true,
      }],
      ['inverse_combined', {
        invert_signals: true,
      }],
    ];
    const results = [];
    for (const [name, params] of variants) {
      results.push(await runVariant(worker, name, candles, footprints, params));
    }
    console.log(JSON.stringify({
      symbol,
      interval,
      hours,
      startTime,
      endTime,
      aggregateTrades: trades.length,
      footprintCandles: candles.length,
      costs: { feeBpsPerSide: 10, slippageBpsPerSide: 2 },
      results,
    }, null, 2));
  } finally {
    worker.child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
