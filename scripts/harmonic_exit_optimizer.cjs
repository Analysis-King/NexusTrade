const fs = require('node:fs');
const { spawn } = require('node:child_process');

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const interval = arg('interval', '1h');
const days = Number(arg('days', '90'));
const offsetDays = Number(arg('offset-days', '0'));
const warmupDays = Number(arg('warmup-days', '0'));
const symbolCount = Number(arg('symbols', '10'));
const initialCapital = Number(arg('capital', '1000'));
const leverage = Number(arg('leverage', '1'));
const feeBps = Number(arg('fee-bps', '10'));
const slippageBps = Number(arg('slippage-bps', '2'));
const profile = arg('profile', 'full');
const portfolioReplay = ['1', 'true', 'yes', 'on'].includes(String(arg('portfolio-replay', 'false')).toLowerCase());
const replayJson = arg('replay-json', '');
const replayCombine = ['1', 'true', 'yes', 'on'].includes(String(arg('replay-combine', 'false')).toLowerCase());
const portfolioScoreFilter = arg('portfolio-score', '');
const portfolioPositionsFilter = Number(arg('portfolio-positions', '0'));
const portfolioCostFilter = Number(arg('portfolio-extra-cost-bps', '-1'));
const minCoverage = Number(arg('min-coverage', '0.9'));
const variantFilter = new Set(
  arg('variants', '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
const explicitSymbols = arg('list', '')
  .split(',')
  .map((item) => item.trim().toUpperCase())
  .filter(Boolean);
const dataEndTime = Date.now() - offsetDays * DAY;
const testStartTime = dataEndTime - days * DAY;

async function fetchCandles(symbol, interval, days) {
  const endTime = dataEndTime;
  let cursor = endTime - (days + warmupDays) * DAY;
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

async function fetchTopUsdtSymbols(limit) {
  if (explicitSymbols.length) return explicitSymbols.slice(0, limit);
  const stableOrFiat = new Set([
    'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1',
    'RLUSD', 'XUSD', 'EUR', 'EURI', 'TRY', 'BRL', 'ARS', 'AEUR', 'BFUSD',
    'PAXG', 'XAUT',
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
    const id = `hexit_${++seq}`;
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

function pct(count, total) {
  return total ? Number((count * 100 / total).toFixed(2)) : 0;
}

function avg(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function dailyCompound(ret) {
  return ret > -100 ? (Math.pow(1 + ret / 100, 1 / days) - 1) * 100 : -100;
}

function benchmark(candles) {
  const testCandles = warmupDays > 0 ? candles.filter((candle) => candle.t >= testStartTime) : candles;
  if (!testCandles.length) return 0;
  return (Number(testCandles.at(-1).c) / Number(testCandles[0].c) - 1) * 100;
}

function f(pattern, zigzag_length, direction) {
  return { pattern, zigzag_length, direction };
}

const allPatternSets = [
  ['all', {}],
  ['all_context', { collect_htf_context: true }],
  ['strong_core', {
    enabled_patterns: ['Gartley', 'Derin Yengec', 'Black Swan', 'Cypher', '5-0', 'White Swan'],
  }],
  ['no_abcd', {
    enabled_patterns: ['Gartley', 'Yengec', 'Derin Yengec', 'Yarasa', 'Alt Yarasa', 'Kelebek', 'Shark', 'Cypher', 'Nenstar', 'Black Swan', 'White Swan', '3 Basamak', '5-0'],
  }],
  ['detail_seed', {
    trade_filters: [
      f('Gartley', 5, 'bullish'),
      f('Gartley', 5, 'bearish'),
      f('Cypher', 5, 'bullish'),
      f('Black Swan', 10, 'bullish'),
      f('Black Swan', 15, 'bearish'),
      f('Derin Yengec', 5, 'bullish'),
    ],
  }],
  ['detail_seed_context', {
    collect_htf_context: true,
    trade_filters: [
      f('Gartley', 5, 'bullish'),
      f('Gartley', 5, 'bearish'),
      f('Cypher', 5, 'bullish'),
      f('Black Swan', 10, 'bullish'),
      f('Black Swan', 15, 'bearish'),
      f('Derin Yengec', 5, 'bullish'),
    ],
  }],
  ['validated_core', {
    trade_filters: [
      f('Black Swan', 15, 'bearish'),
      f('Derin Yengec', 5, 'bullish'),
    ],
  }],
  ['stable_core', {
    trade_filters: [
      f('ABCD', 25, 'bearish'),
      f('5-0', 10, 'bullish'),
      f('Kelebek', 15, 'bullish'),
      f('Nenstar', 10, 'bearish'),
      f('Cypher', 10, 'bullish'),
    ],
  }],
  ['triple_period_core', {
    trade_filters: [
      f('Yengec', 10, 'bearish'),
      f('Nenstar', 10, 'bearish'),
      f('ABCD Uzanti', 25, 'bearish'),
      f('Nenstar', 20, 'bullish'),
      f('Yarasa', 10, 'bearish'),
    ],
  }],
  ['abcd25_bear_q40', {
    trade_filters: [f('ABCD', 25, 'bearish')],
    min_quality: 40,
  }],
  ['five0_10_bear_t5', {
    trade_filters: [f('5-0', 10, 'bearish')],
    min_target_pct: 5,
  }],
  ['nenstar15_bear_t5', {
    trade_filters: [f('Nenstar', 15, 'bearish')],
    min_target_pct: 5,
  }],
  ['abcd5_bear_q80', {
    trade_filters: [f('ABCD', 5, 'bearish')],
    min_quality: 80,
  }],
  ['black_swan25_bull_t5', {
    trade_filters: [f('Black Swan', 25, 'bullish')],
    min_target_pct: 5,
  }],
  ['ctx_abcd_ext10_bull_sb_q70', {
    trade_filters: [f('ABCD Uzanti', 10, 'bullish')],
    min_quality: 70,
    htf_regime_filter: 'custom',
    htf_long_regime: 'strong_bear',
    htf_allow_unknown: false,
  }],
  ['ctx_abcd10_bear_sb_q50', {
    trade_filters: [f('ABCD', 10, 'bearish')],
    min_quality: 50,
    htf_regime_filter: 'custom',
    htf_short_regime: 'strong_bear',
    htf_allow_unknown: false,
  }],
  ['ctx_nenstar10_bull_sb', {
    trade_filters: [f('Nenstar', 10, 'bullish')],
    htf_regime_filter: 'custom',
    htf_long_regime: 'strong_bear',
    htf_allow_unknown: false,
  }],
  ['ctx_abcd5_bear_bear_q50', {
    trade_filters: [f('ABCD', 5, 'bearish')],
    min_quality: 50,
    htf_regime_filter: 'custom',
    htf_short_regime: 'bear',
    htf_allow_unknown: false,
  }],
  ['ctx_nenstar5_bear_sb', {
    trade_filters: [f('Nenstar', 5, 'bearish')],
    htf_regime_filter: 'custom',
    htf_short_regime: 'strong_bear',
    htf_allow_unknown: false,
  }],
  ['ctx_abcd5_bear_bull', {
    trade_filters: [f('ABCD', 5, 'bearish')],
    htf_regime_filter: 'custom',
    htf_short_regime: 'bull',
    htf_allow_unknown: false,
  }],
];

const allExitModels = [
  ['single_t1_r01', { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.1, min_reward_risk: 0.5 }],
  ['single_t1_r02', { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.2, min_reward_risk: 0.5 }],
  ['single_t1_r03', { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.3, min_reward_risk: 0.5 }],
  ['single_t1_r04', { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.4, min_reward_risk: 0.5 }],
  ['single_t1_r05', { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.5, min_reward_risk: 0.5 }],
  ['single_t1_r075', { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.75, min_reward_risk: 0.5 }],
  ['single_t1_r1', { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 1, min_reward_risk: 0.5 }],
  ['single_t2_r01', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.1, min_reward_risk: 0.5 }],
  ['single_t2_r02', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.2, min_reward_risk: 0.5 }],
  ['single_t2_r02_close', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.2, stop_trigger_mode: 'close', min_reward_risk: 0.5 }],
  ['single_t2_r01_close', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.1, stop_trigger_mode: 'close', min_reward_risk: 0.5 }],
  ['single_t2_r03_close', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.3, stop_trigger_mode: 'close', min_reward_risk: 0.5 }],
  ['single_t2_r04_close', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.4, stop_trigger_mode: 'close', min_reward_risk: 0.5 }],
  ['single_t2_r05_close', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.5, stop_trigger_mode: 'close', min_reward_risk: 0.5 }],
  ['single_t2_r075_close', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.75, stop_trigger_mode: 'close', min_reward_risk: 0.5 }],
  ['single_t2_r10_close', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 1.0, stop_trigger_mode: 'close', min_reward_risk: 0.5 }],
  ['single_t2_x', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_mode: 'x_point', min_reward_risk: 0.5 }],
  ['single_t2_zone', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_mode: 'confirmation_zone', min_reward_risk: 0.5 }],
  ['single_t2_r03', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.3, min_reward_risk: 0.5 }],
  ['single_t2_r04', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.4, min_reward_risk: 0.5 }],
  ['single_t2_r05', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.5, min_reward_risk: 0.5 }],
  ['single_t2_r06', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.6, min_reward_risk: 0.5 }],
  ['single_t2_r07', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.7, min_reward_risk: 0.5 }],
  ['single_t2_r075', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.75, min_reward_risk: 0.5 }],
  ['single_t2_r08', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.8, min_reward_risk: 0.5 }],
  ['single_t2_r09', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 0.9, min_reward_risk: 0.5 }],
  ['single_t2_r10', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 1, min_reward_risk: 0.5 }],
  ['single_t2_r12', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 1.2, min_reward_risk: 0.5 }],
  ['single_t2_r15', { exit_mode: 'single', take_profit_mode: 'target_2', stop_loss_target_ratio: 1.5, min_reward_risk: 0.5 }],
  ['tp1_trail_t2_atr08', { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.75, min_reward_risk: 0.5, breakeven_buffer_pct: 0.03, trail_atr_period: 14, trail_atr_mult: 0.8 }],
  ['tp1_trail_t2_atr11', { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.75, min_reward_risk: 0.5, breakeven_buffer_pct: 0.03, trail_atr_period: 14, trail_atr_mult: 1.1 }],
  ['tp1_trail_t2_atr15', { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.75, min_reward_risk: 0.5, breakeven_buffer_pct: 0.03, trail_atr_period: 14, trail_atr_mult: 1.5 }],
  ['tp1_trail_t2_r02_atr08', { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.2, min_reward_risk: 0.5, breakeven_buffer_pct: 0.03, trail_atr_period: 14, trail_atr_mult: 0.8 }],
  ['tp1_trail_t2_r02_atr11', { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.2, min_reward_risk: 0.5, breakeven_buffer_pct: 0.03, trail_atr_period: 14, trail_atr_mult: 1.1 }],
  ['tp1_trail_t2_r02_atr15', { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.2, min_reward_risk: 0.5, breakeven_buffer_pct: 0.03, trail_atr_period: 14, trail_atr_mult: 1.5 }],
];

const allRegimeModels = [
  ['base', {}],
  ['trend100', { trend_filter: 'with_trend', trend_ema_period: 100 }],
  ['reversal100', { trend_filter: 'reversal', trend_ema_period: 100 }],
  ['htf4h_trend', { htf_regime_filter: 'with_trend', htf_timeframe: '4h', htf_allow_unknown: false }],
  ['htf4h_reversal', { htf_regime_filter: 'reversal', htf_timeframe: '4h', htf_allow_unknown: false }],
  ['htf4h_prefer_trend', { htf_regime_filter: 'prefer_with_trend', htf_timeframe: '4h', htf_allow_unknown: false }],
  ['htf4h_prefer_reversal', { htf_regime_filter: 'prefer_reversal', htf_timeframe: '4h', htf_allow_unknown: false }],
  ['adx18', { adx_filter: true, min_adx: 18 }],
  ['adx25', { adx_filter: true, min_adx: 25 }],
  ['volume120', { volume_filter: true, min_volume_ratio: 1.2 }],
  ['atr020_500', { atr_pct_filter: true, min_atr_pct: 0.2, max_atr_pct: 5 }],
  ['trend100_adx18', { trend_filter: 'with_trend', trend_ema_period: 100, adx_filter: true, min_adx: 18 }],
  ['reversal100_adx18', { trend_filter: 'reversal', trend_ema_period: 100, adx_filter: true, min_adx: 18 }],
  ['htf4h_trend_adx18', { htf_regime_filter: 'with_trend', htf_timeframe: '4h', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
  ['htf4h_reversal_adx18', { htf_regime_filter: 'reversal', htf_timeframe: '4h', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
  ['dema_trend', { dema_filter: 'with_trend', dema_fast_period: 20, dema_slow_period: 30 }],
  ['dema_trend_adx18', { dema_filter: 'with_trend', dema_fast_period: 20, dema_slow_period: 30, adx_filter: true, min_adx: 18 }],
  ['dema_reversal', { dema_filter: 'reversal', dema_fast_period: 20, dema_slow_period: 30 }],
  ['quality70', { min_quality: 70 }],
  ['signal_exit', { exit_on_opposite_pattern: true, exit_on_opposite_signal: true }],
  ['signal_exit_adx18', { exit_on_opposite_pattern: true, exit_on_opposite_signal: true, adx_filter: true, min_adx: 18 }],
  ['signal_exit_htf4h_trend_adx18', { exit_on_opposite_pattern: true, exit_on_opposite_signal: true, htf_regime_filter: 'with_trend', htf_timeframe: '4h', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
];

const allLearningModels = [
  ['baseline', {}],
  ['confirm_f05_b4', { entry_confirmation_mode: 'target_fraction', entry_confirmation_fraction: 0.05, entry_confirmation_bars: 4 }],
  ['confirm_f05_b8', { entry_confirmation_mode: 'target_fraction', entry_confirmation_fraction: 0.05, entry_confirmation_bars: 8 }],
  ['confirm_f10_b4', { entry_confirmation_mode: 'target_fraction', entry_confirmation_fraction: 0.1, entry_confirmation_bars: 4 }],
  ['confirm_f10_b8', { entry_confirmation_mode: 'target_fraction', entry_confirmation_fraction: 0.1, entry_confirmation_bars: 8 }],
  ['confirm_f10_b12', { entry_confirmation_mode: 'target_fraction', entry_confirmation_fraction: 0.1, entry_confirmation_bars: 12 }],
  ['confirm_f20_b8', { entry_confirmation_mode: 'target_fraction', entry_confirmation_fraction: 0.2, entry_confirmation_bars: 8 }],
  ['confirm_f20_b12', { entry_confirmation_mode: 'target_fraction', entry_confirmation_fraction: 0.2, entry_confirmation_bars: 12 }],
  ['baseline_confirmed', { allow_repaint: false }],
  ['baseline_confirmed_adx18', { allow_repaint: false, adx_filter: true, min_adx: 18 }],
  ['baseline_confirmed_htftrend_adx18', { allow_repaint: false, htf_regime_filter: 'with_trend', htf_timeframe: '4h', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
  ['baseline_q50', { min_quality: 50 }],
  ['baseline_q65', { min_quality: 65 }],
  ['baseline_q75', { min_quality: 75 }],
  ['baseline_q85', { min_quality: 85 }],
  ['pdir_n3_wr20_w12', { learning_filter: true, learning_group: 'pattern_direction', learning_min_samples: 3, learning_min_win_rate: 20, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 12 }],
  ['pdir_n5_wr20_w20', { learning_filter: true, learning_group: 'pattern_direction', learning_min_samples: 5, learning_min_win_rate: 20, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20 }],
  ['pdir_n5_wr25_w20', { learning_filter: true, learning_group: 'pattern_direction', learning_min_samples: 5, learning_min_win_rate: 25, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20 }],
  ['pdir_n8_wr25_w30', { learning_filter: true, learning_group: 'pattern_direction', learning_min_samples: 8, learning_min_win_rate: 25, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 30 }],
  ['pldir_n3_wr20_w12', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 3, learning_min_win_rate: 20, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 12 }],
  ['pldir_n5_wr20_w20', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 20, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20 }],
  ['pldir_n5_wr25_w20', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 25, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20 }],
  ['pldir_n8_wr25_w30', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 8, learning_min_win_rate: 25, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 30 }],
  ['pldir_n5_wr30_w20', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20 }],
  ['pldir_n5_wr30_w20_q50', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, min_quality: 50 }],
  ['pldir_n5_wr30_w20_q65', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, min_quality: 65 }],
  ['pldir_n5_wr30_w20_q75', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, min_quality: 75 }],
  ['pldir_n5_wr30_w20_q85', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, min_quality: 85 }],
  ['pldir_n5_wr30_w20_t05', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, min_target_pct: 0.5 }],
  ['pldir_n5_wr30_w20_t10', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, min_target_pct: 1.0 }],
  ['pldir_n5_wr30_w20_t20', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, min_target_pct: 2.0 }],
  ['pldir_n5_wr30_w20_q65_t10', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, min_quality: 65, min_target_pct: 1.0 }],
  ['pldir_n5_wr30_w20_confirmed', { allow_repaint: false, learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20 }],
  ['pldir_n5_wr30_w20_adx18', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, adx_filter: true, min_adx: 18 }],
  ['pldir_n5_wr30_w20_confirmed_adx18', { allow_repaint: false, learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, adx_filter: true, min_adx: 18 }],
  ['pldir_n5_wr30_w20_htftrend', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, htf_regime_filter: 'with_trend', htf_timeframe: '4h', htf_allow_unknown: false }],
  ['pldir_n5_wr30_w20_htftrend_adx18', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, htf_regime_filter: 'with_trend', htf_timeframe: '4h', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
  ['pldir_n5_wr30_w20_confirmed_htftrend_adx18', { allow_repaint: false, learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, htf_regime_filter: 'with_trend', htf_timeframe: '4h', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
  ['pldir_n5_wr30_w20_reversal100', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, trend_filter: 'reversal', trend_ema_period: 100 }],
  ['pldir_n5_wr30_w20_reversal100_adx18', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, trend_filter: 'reversal', trend_ema_period: 100, adx_filter: true, min_adx: 18 }],
  ['pldir_n5_wr30_w20_htfreversal', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, htf_regime_filter: 'reversal', htf_timeframe: '4h', htf_allow_unknown: false }],
  ['pldir_n5_wr30_w20_htfreversal_adx18', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, htf_regime_filter: 'reversal', htf_timeframe: '4h', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
  ['pldir_n5_wr30_w20_htf1d_trend_adx18', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, htf_regime_filter: 'with_trend', htf_timeframe: '1d', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
  ['pldir_n5_wr30_w20_htf1d_reversal_adx18', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, htf_regime_filter: 'reversal', htf_timeframe: '1d', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
  ['pldir_n5_wr30_w20_dema_trend', { learning_filter: true, learning_group: 'pattern_length_direction', learning_min_samples: 5, learning_min_win_rate: 30, learning_min_expectancy_r: 0, learning_horizon_bars: 96, learning_window_samples: 20, dema_filter: 'with_trend', dema_fast_period: 20, dema_slow_period: 30 }],
];

function selectedPatternSets() {
  if (profile === 'learning') {
    return allPatternSets.filter(([name]) => ['all', 'detail_seed'].includes(name));
  }
  if (profile === 'risk') {
    return allPatternSets.filter(([name]) => ['all', 'detail_seed', 'stable_core', 'triple_period_core'].includes(name));
  }
  if (profile === 'regime') {
    return allPatternSets.filter(([name]) => ['all', 'detail_seed', 'validated_core', 'triple_period_core'].includes(name));
  }
  if (profile === 'finalists') {
    return allPatternSets.filter(([name]) => ['no_abcd', 'detail_seed'].includes(name));
  }
  return allPatternSets;
}

function selectedExitModels() {
  if (profile === 'learning') {
    return allExitModels.filter(([name]) => ['single_t1_r02', 'single_t2_r02', 'single_t2_r02_close'].includes(name));
  }
  if (profile === 'risk') {
    return allExitModels.filter(([name]) => [
      'single_t1_r01', 'single_t1_r02', 'single_t1_r03', 'single_t1_r04', 'single_t1_r05',
      'single_t2_r01', 'single_t2_r02', 'single_t2_r03', 'single_t2_r04', 'single_t2_r05',
      'single_t2_r06', 'single_t2_r07', 'single_t2_r075', 'single_t2_r08', 'single_t2_r09',
      'single_t2_r10', 'single_t2_r12', 'single_t2_r15',
      'single_t2_r01_close', 'single_t2_r02_close', 'single_t2_r03_close', 'single_t2_r04_close',
      'single_t2_r05_close', 'single_t2_r075_close', 'single_t2_r10_close',
      'single_t2_x', 'single_t2_zone',
      'tp1_trail_t2_r02_atr08', 'tp1_trail_t2_r02_atr11', 'tp1_trail_t2_r02_atr15',
    ].includes(name));
  }
  if (profile === 'regime') {
    return allExitModels.filter(([name]) => name === 'single_t2_r02');
  }
  if (profile === 'finalists') {
    return allExitModels.filter(([name]) => ['single_t2_r05', 'single_t2_r075', 'single_t1_r1'].includes(name));
  }
  return allExitModels;
}

function selectedRegimeModels() {
  if (profile === 'learning') return allLearningModels;
  return profile === 'regime' ? allRegimeModels : [['base', {}]];
}

const variants = selectedPatternSets().flatMap(([setName, setParams]) =>
  selectedExitModels().flatMap(([exitName, exitParams]) =>
    selectedRegimeModels().map(([regimeName, regimeParams]) => {
      const name = ['regime', 'learning'].includes(profile)
        ? `${setName}__${exitName}__${regimeName}`
        : `${setName}__${exitName}`;
      return [name, {
        allow_repaint: true,
        allow_short: true,
        stop_loss_mode: 'target_ratio',
        recent_signal_bars: 3,
        max_position_pct: 100,
        leverage,
        ...setParams,
        ...exitParams,
        ...regimeParams,
      }];
    }),
  ),
).filter(([name]) => !variantFilter.size || variantFilter.has(name));

function intervalMs(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d+)([mhd])$/);
  if (!match) return null;
  const unit = { m: 60_000, h: 3_600_000, d: DAY }[match[2]];
  return Number(match[1]) * unit;
}

function hasEnoughCoverage(candles) {
  const step = intervalMs(interval);
  if (!step) return candles.length >= 500;
  const expected = Math.floor((days + warmupDays) * DAY / step);
  return candles.length >= Math.max(200, Math.floor(expected * minCoverage));
}

async function runCase(request, symbol, candles, variant, params) {
  const instance = `hexit_${symbol}_${variant}_${Math.random().toString(16).slice(2)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  await request('load', { instance, strategy_file: 'pine_harmonic_patterns.py', params });
  try {
    const result = await request('backtest', {
      instance,
      candles,
      initial_capital: initialCapital,
      fee_bps: feeBps,
      slippage_bps: slippageBps,
      fill_model: 'pessimistic_ohlc',
      start_time: warmupDays > 0 ? testStartTime : undefined,
      params,
    });
    const summary = result.summary || {};
    return {
      variant,
      symbol,
      ret: Number(summary.totalReturnPct || 0),
      daily: dailyCompound(Number(summary.totalReturnPct || 0)),
      win: Number(summary.winRatePct || 0),
      pf: summary.profitFactor,
      trades: Number(summary.totalTrades || 0),
      dd: Number(summary.maxDrawdownPct || 0),
      final: Number(summary.finalCapital || initialCapital),
      reasons: reasonCounts(result.trades || []),
      patternStats: tradePatternStats(result.trades || []),
      featureStats: tradeFeatureStats(result.trades || []),
      tradeRows: portfolioReplay ? (result.trades || []).map((trade) => ({ ...trade, symbol })) : undefined,
    };
  } finally {
    await request('drop', { instance }).catch(() => {});
  }
}

function reasonCounts(trades) {
  return trades.reduce((out, trade) => {
    const reason = trade.reason || 'unknown';
    out[reason] = (out[reason] || 0) + 1;
    return out;
  }, {});
}

function tradePatternStats(trades) {
  const out = {};
  for (const trade of trades) {
    const meta = trade.meta || {};
    const key = [
      meta.pattern || 'unknown',
      `L${meta.zigzag_length ?? '?'}`,
      meta.direction || trade.side || 'unknown',
    ].join(' | ');
    const stats = out[key] || { trades: 0, wins: 0, netPnl: 0, tp: 0, sl: 0 };
    const pnl = Number(trade.netPnl || 0);
    stats.trades += 1;
    stats.wins += pnl > 0 ? 1 : 0;
    stats.netPnl += pnl;
    stats.tp += trade.reason === 'tp' ? 1 : 0;
    stats.sl += trade.reason === 'sl' ? 1 : 0;
    out[key] = stats;
  }
  return out;
}

function tradeFeatureStats(trades) {
  const out = {};
  const add = (key, trade) => {
    const stats = out[key] || { trades: 0, wins: 0, netPnl: 0, tp: 0, sl: 0 };
    const pnl = Number(trade.netPnl || 0);
    stats.trades += 1;
    stats.wins += pnl > 0 ? 1 : 0;
    stats.netPnl += pnl;
    stats.tp += trade.reason === 'tp' ? 1 : 0;
    stats.sl += trade.reason === 'sl' ? 1 : 0;
    out[key] = stats;
  };

  for (const trade of trades) {
    const meta = trade.meta || {};
    const identity = [
      meta.pattern || 'unknown',
      `L${meta.zigzag_length ?? '?'}`,
      meta.direction || trade.side || 'unknown',
    ].join(' | ');
    const htf = String(meta.htf_regime || 'unknown');
    const dema = String(meta.dema_trend || 'unknown');
    const quality = Number(meta.quality);
    const entry = Number(trade.entryPrice || meta.entry || 0);
    const target = Number(trade.tpPrice || meta.tp || 0);
    const targetPct = entry > 0 && target > 0 ? Math.abs(target - entry) / entry * 100 : 0;
    const filters = new Set(['base', `htf=${htf}`, `dema=${dema}`, `htf=${htf};dema=${dema}`]);
    for (const threshold of [40, 50, 60, 70, 80, 90]) {
      if (Number.isFinite(quality) && quality >= threshold) {
        filters.add(`q>=${threshold}`);
        filters.add(`htf=${htf};q>=${threshold}`);
      }
    }
    for (const threshold of [0.25, 0.5, 1, 2, 3, 5]) {
      if (targetPct >= threshold) {
        filters.add(`target>=${threshold}`);
        filters.add(`htf=${htf};target>=${threshold}`);
      }
    }
    for (const filter of filters) add(`${filter} | ${identity}`, trade);
  }
  return out;
}

function summarize(rows) {
  return variants.map(([variant]) => {
    const group = rows.filter((row) => row.variant === variant);
    const reasons = {};
    for (const row of group) {
      for (const [reason, count] of Object.entries(row.reasons || {})) {
        reasons[reason] = (reasons[reason] || 0) + count;
      }
    }
    return {
      variant,
      symbols: group.length,
      avgRet: avg(group.map((row) => row.ret)),
      medRet: median(group.map((row) => row.ret)),
      avgDaily: avg(group.map((row) => row.daily)),
      medDaily: median(group.map((row) => row.daily)),
      winners: pct(group.filter((row) => row.ret > 0).length, group.length),
      targetHits: group.filter((row) => row.daily >= 0.8).length,
      avgWin: avg(group.map((row) => row.win)),
      totalTrades: group.reduce((sum, row) => sum + row.trades, 0),
      avgTrades: avg(group.map((row) => row.trades)),
      avgDd: avg(group.map((row) => row.dd)),
      reasons,
      patternStats: mergePatternStats(group.map((row) => row.patternStats || {})),
      featureStats: mergePatternStats(group.map((row) => row.featureStats || {})),
    };
  }).sort((a, b) => (b.avgDaily ?? -Infinity) - (a.avgDaily ?? -Infinity));
}

function mergePatternStats(groups) {
  const out = {};
  for (const group of groups) {
    for (const [key, stats] of Object.entries(group)) {
      const total = out[key] || { trades: 0, wins: 0, netPnl: 0, tp: 0, sl: 0 };
      for (const field of ['trades', 'wins', 'netPnl', 'tp', 'sl']) {
        total[field] += Number(stats[field] || 0);
      }
      out[key] = total;
    }
  }
  return out;
}

function portfolioFeatures(trade) {
  const meta = trade.meta || {};
  const quality = Number(meta.quality || 0);
  const entry = Number(trade.entryPrice || 0);
  const target = Number(trade.tpPrice || 0);
  const targetPct = entry > 0 && target > 0 ? Math.abs(target - entry) / entry * 100 : 0;
  const direction = String(meta.direction || trade.side || '');
  const regime = String(meta.htf_regime || 'unknown');
  const aligned = (
    direction === 'bullish' && ['bull', 'strong_bull'].includes(regime)
  ) || (
    direction === 'bearish' && ['bear', 'strong_bear'].includes(regime)
  );
  const reversal = (
    direction === 'bullish' && ['bear', 'strong_bear'].includes(regime)
  ) || (
    direction === 'bearish' && ['bull', 'strong_bull'].includes(regime)
  );
  const strongAligned = (
    direction === 'bullish' && regime === 'strong_bull'
  ) || (
    direction === 'bearish' && regime === 'strong_bear'
  );
  return { quality, targetPct, aligned, reversal, strongAligned };
}

function portfolioEligible(trade, mode) {
  const features = portfolioFeatures(trade);
  const targetMinimum = String(mode).match(/^target_min(05|1|2|3|5)$/);
  if (targetMinimum) {
    const threshold = targetMinimum[1] === '05' ? 0.5 : Number(targetMinimum[1]);
    return features.targetPct >= threshold;
  }
  if (mode.startsWith('trend_only_')) return features.aligned;
  if (mode.startsWith('strong_trend_')) return features.strongAligned;
  if (mode.startsWith('reversal_only_')) return features.reversal;
  if (mode.startsWith('trend_target2_')) return features.aligned && features.targetPct >= 2;
  return true;
}

function portfolioScore(trade, mode) {
  const { quality, targetPct, aligned, reversal } = portfolioFeatures(trade);
  if (mode === 'target' || mode.startsWith('target_min')) return targetPct;
  if (mode.includes('target')) return quality * Math.sqrt(Math.max(0, targetPct));
  if (mode === 'trend_quality') return quality + (aligned ? 1000 : 0);
  if (mode === 'reversal_quality') return quality + (reversal ? 1000 : 0);
  return quality;
}

function replayPortfolio(trades, maxPositions, scoreMode, portfolioLeverage = 1, extraCostBps = 0) {
  const groups = new Map();
  for (const trade of trades) {
    const time = Number(trade.entryTime || 0);
    if (!groups.has(time)) groups.set(time, []);
    groups.get(time).push(trade);
  }
  const entryTimes = [...groups.keys()].sort((a, b) => a - b);
  let equity = initialCapital;
  let active = [];
  let peak = initialCapital;
  let maxDd = 0;
  let wins = 0;
  let taken = 0;

  const mark = () => equity;
  const updateDrawdown = () => {
    const equity = mark();
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak * 100 : 0);
  };
  const closeThrough = (time) => {
    const closing = active.filter((item) => item.exitTime <= time).sort((a, b) => a.exitTime - b.exitTime);
    for (const item of closing) {
      equity += item.allocation * item.returnPct / 100;
      wins += item.returnPct > 0 ? 1 : 0;
      active = active.filter((candidate) => candidate !== item);
      updateDrawdown();
    }
  };

  for (const time of entryTimes) {
    closeThrough(time);
    const slots = maxPositions - active.length;
    if (slots <= 0) continue;
    // Giris mumunda kapanan islemler de dahil (exitTime === entryTime). Eskiden `> time` ile
    // atiliyorlardi: bu, sonucu bilinmeden verilemeyecek bir karardi ve 28 Haziran portfoy adayinin
    // gunluk %0.84-1.59'unun tamamini uretti (duzeltilince gunluk -%3.9 ile -%6.1). Bkz. DENEY-KAYDI EXP-016.
    const candidates = groups.get(time)
      .filter((trade) => Number(trade.exitTime || 0) >= time)
      .filter((trade) => portfolioEligible(trade, scoreMode))
      .sort((a, b) => portfolioScore(b, scoreMode) - portfolioScore(a, scoreMode));
    for (const trade of candidates.slice(0, slots)) {
      const allocation = equity / maxPositions * portfolioLeverage;
      if (allocation <= 0) break;
      active.push({
        allocation,
        exitTime: Number(trade.exitTime),
        returnPct: Number(trade.pnlPct || 0) - extraCostBps / 100,
      });
      taken += 1;
    }
    updateDrawdown();
  }
  closeThrough(Number.POSITIVE_INFINITY);
  const totalReturn = (equity / initialCapital - 1) * 100;
  return {
    maxPositions,
    scoreMode,
    portfolioLeverage,
    extraCostBps,
    trades: taken,
    winRate: pct(wins, taken),
    totalReturn,
    daily: dailyCompound(totalReturn),
    maxDd,
    final: equity,
  };
}

function portfolioSummary(rows) {
  if (!portfolioReplay) return [];
  const modes = [
    'quality', 'target', 'quality_target', 'trend_quality', 'reversal_quality',
    'trend_only_quality', 'trend_only_target', 'strong_trend_quality',
    'reversal_only_quality', 'trend_target2_quality',
    'target_min05', 'target_min1', 'target_min2', 'target_min3', 'target_min5',
  ];
  const limits = [1, 2, 3, 5, 10];
  const leverages = [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12];
  const costStresses = [0, 10, 20, 30];
  const variantNames = [...new Set(rows.map((row) => row.variant))];
  return variantNames.flatMap((variant) => {
    const trades = rows
      .filter((row) => row.variant === variant)
      .flatMap((row) => row.tradeRows || []);
    return modes.flatMap((mode) => limits.flatMap((limit) => leverages.flatMap((portfolioLeverage) => costStresses.map((extraCostBps) => ({
      variant,
      ...replayPortfolio(trades, limit, mode, portfolioLeverage, extraCostBps),
    })))));
  }).sort((a, b) => b.daily - a.daily);
}

function mdTable(rows, columns) {
  const head = `| ${columns.map((col) => col[0]).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---:').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map(([, get]) => get(row)).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

async function main() {
  if (replayJson) {
    const replayFiles = replayJson.split(',').map((item) => item.trim()).filter(Boolean);
    const replayPayloads = replayFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    if (replayCombine) {
      const portfolioRows = portfolioSummary(replayPayloads.flatMap((payload) => payload.rows || [])).filter((row) => (
        (!portfolioScoreFilter || row.scoreMode === portfolioScoreFilter)
        && (!portfolioPositionsFilter || row.maxPositions === portfolioPositionsFilter)
        && (portfolioCostFilter < 0 || row.extraCostBps === portfolioCostFilter)
      ));
      console.table(portfolioRows.slice(0, 40).map((row) => ({
        variant: row.variant,
        score: row.scoreMode,
        positions: row.maxPositions,
        leverage: row.portfolioLeverage,
        extraCostBps: row.extraCostBps,
        daily: Number(row.daily.toFixed(3)),
        ret: Number(row.totalReturn.toFixed(2)),
        win: row.winRate,
        trades: row.trades,
        dd: Number(row.maxDd.toFixed(2)),
      })));
      return;
    }
    const replayRows = replayPayloads.flatMap((payload, period) => {
      return portfolioSummary(payload.rows || []).map((row) => ({ ...row, period }));
    });
    const portfolioRows = replayRows.filter((row) => (
      (!portfolioScoreFilter || row.scoreMode === portfolioScoreFilter)
      && (!portfolioPositionsFilter || row.maxPositions === portfolioPositionsFilter)
      && (portfolioCostFilter < 0 || row.extraCostBps === portfolioCostFilter)
    ));
    if (replayFiles.length > 1) {
      const groups = new Map();
      for (const row of portfolioRows) {
        const key = `${row.scoreMode}|${row.maxPositions}|${row.portfolioLeverage}|${row.extraCostBps}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const aggregate = [...groups.values()].map((group) => ({
        score: group[0].scoreMode,
        positions: group[0].maxPositions,
        leverage: group[0].portfolioLeverage,
        extraCostBps: group[0].extraCostBps,
        avgDaily: avg(group.map((row) => row.daily)),
        minDaily: Math.min(...group.map((row) => row.daily)),
        positive: group.filter((row) => row.daily > 0).length,
        maxDd: Math.max(...group.map((row) => row.maxDd)),
      })).sort((a, b) => b.avgDaily - a.avgDaily);
      console.table(aggregate.slice(0, 80).map((row) => ({
        ...row,
        avgDaily: Number(row.avgDaily.toFixed(3)),
        minDaily: Number(row.minDaily.toFixed(3)),
        maxDd: Number(row.maxDd.toFixed(2)),
      })));
      return;
    }
    console.table(portfolioRows.slice(0, 40).map((row) => ({
      variant: row.variant,
      score: row.scoreMode,
      positions: row.maxPositions,
      leverage: row.portfolioLeverage,
      extraCostBps: row.extraCostBps,
      daily: Number(row.daily.toFixed(3)),
      ret: Number(row.totalReturn.toFixed(2)),
      win: row.winRate,
      trades: row.trades,
      dd: Number(row.maxDd.toFixed(2)),
    })));
    return;
  }
  console.log(`Harmonic exit optimizer: interval=${interval} days=${days} warmup=${warmupDays} offset=${offsetDays} symbols=${symbolCount} profile=${profile} variants=${variants.length}`);
  if (!variants.length) throw new Error('Secilen profile/variants icin varyant bulunamadi');
  const candidates = await fetchTopUsdtSymbols(explicitSymbols.length ? symbolCount : Math.max(symbolCount * 3, symbolCount + 20));
  const datasets = new Map();
  for (const symbol of candidates) {
    if (datasets.size >= symbolCount) break;
    const candles = await fetchCandles(symbol, interval, days);
    if (!hasEnoughCoverage(candles)) {
      console.log(`skip ${symbol}: yetersiz gecmis (${candles.length} mum)`);
      continue;
    }
    datasets.set(symbol, candles);
    console.log(`data ${symbol}: ${candles.length} candles benchmark=${benchmark(candles).toFixed(2)}%`);
  }
  const symbols = [...datasets.keys()];
  if (!symbols.length) throw new Error('Yeterli gecmise sahip sembol bulunamadi');

  const { child, request } = startWorker();
  const rows = [];
  const failures = [];
  try {
    let completed = 0;
    const total = symbols.length * variants.length;
    for (const [variant, params] of variants) {
      for (const symbol of symbols) {
        try {
          const row = await runCase(request, symbol, datasets.get(symbol), variant, params);
          rows.push(row);
        } catch (err) {
          failures.push({ variant, symbol, reason: err.message || String(err) });
        }
        completed += 1;
        if (completed % 20 === 0 || completed === total) {
          console.log(`progress ${completed}/${total}`);
        }
      }
    }
  } finally {
    child.kill();
  }

  const summary = summarize(rows);
  const portfolioRows = portfolioSummary(rows);
  if (portfolioRows.length) {
    console.table(portfolioRows.slice(0, 15).map((row) => ({
      variant: row.variant,
      score: row.scoreMode,
      positions: row.maxPositions,
      leverage: row.portfolioLeverage,
      extraCostBps: row.extraCostBps,
      daily: Number(row.daily.toFixed(3)),
      ret: Number(row.totalReturn.toFixed(2)),
      win: row.winRate,
      trades: row.trades,
      dd: Number(row.maxDd.toFixed(2)),
    })));
  }
  const patternRows = summary.flatMap((variantRow) =>
    Object.entries(variantRow.patternStats || {}).map(([pattern, stats]) => ({
      variant: variantRow.variant,
      pattern,
      ...stats,
      winRate: pct(stats.wins, stats.trades),
    })),
  ).sort((a, b) => b.netPnl - a.netPnl);
  const featureRows = summary.flatMap((variantRow) =>
    Object.entries(variantRow.featureStats || {}).map(([feature, stats]) => ({
      variant: variantRow.variant,
      feature,
      ...stats,
      winRate: pct(stats.wins, stats.trades),
    })),
  ).sort((a, b) => b.netPnl - a.netPnl);
  const topRows = [...rows].sort((a, b) => b.daily - a.daily).slice(0, 40);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const offsetTag = offsetDays > 0 ? `_offset${offsetDays}d` : '';
  const warmupTag = warmupDays > 0 ? `_warmup${warmupDays}d` : '';
  const base = `data/harmonic_exit_optimizer_${interval}_${days}d${warmupTag}${offsetTag}_${symbols.length}s_${stamp}`;
  const payload = { interval, days, warmupDays, offsetDays, symbols, profile, portfolioReplay, variants: variants.map(([name, params]) => ({ name, params })), summary, portfolioRows, patternRows, featureRows, topRows, rows, failures };
  fs.writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2));

  const md = [
    '# Harmonic Exit Optimizer',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Interval: ${interval}`,
    `Days: ${days}`,
    `Warm-up Days: ${warmupDays}`,
    `Offset Days: ${offsetDays}`,
    `Profile: ${profile}`,
    `Symbols: ${symbols.join(', ')}`,
    `Fee/Slippage bps: ${feeBps}/${slippageBps}`,
    '',
    '## Variant Summary',
    '',
    mdTable(summary.slice(0, 20), [
      ['Variant', (row) => row.variant],
      ['Avg Daily %', (row) => row.avgDaily?.toFixed(3)],
      ['Med Daily %', (row) => row.medDaily?.toFixed(3)],
      ['Avg Ret %', (row) => row.avgRet?.toFixed(2)],
      ['Win Symbols %', (row) => row.winners],
      ['Avg Trade Win %', (row) => row.avgWin?.toFixed(2)],
      ['Trades', (row) => row.totalTrades],
      ['Avg DD %', (row) => row.avgDd?.toFixed(2)],
      ['TP', (row) => row.reasons.tp || 0],
      ['SL', (row) => row.reasons.sl || 0],
      ['End', (row) => row.reasons.end_of_test || 0],
    ]),
    '',
    '## Portfolio Replay',
    '',
    mdTable(portfolioRows.slice(0, 50), [
      ['Variant', (row) => row.variant],
      ['Score', (row) => row.scoreMode],
      ['Positions', (row) => row.maxPositions],
      ['Leverage', (row) => row.portfolioLeverage],
      ['Extra Cost bps', (row) => row.extraCostBps],
      ['Daily %', (row) => row.daily.toFixed(3)],
      ['Return %', (row) => row.totalReturn.toFixed(2)],
      ['Win %', (row) => row.winRate],
      ['Trades', (row) => row.trades],
      ['Max DD %', (row) => row.maxDd.toFixed(2)],
    ]),
    '',
    '## Pattern Breakdown',
    '',
    mdTable(patternRows, [
      ['Variant', (row) => row.variant],
      ['Pattern', (row) => row.pattern],
      ['Trades', (row) => row.trades],
      ['Win %', (row) => row.winRate],
      ['Net PnL', (row) => row.netPnl.toFixed(2)],
      ['TP', (row) => row.tp],
      ['SL', (row) => row.sl],
    ]),
    '',
    '## Feature Breakdown (Top 100)',
    '',
    mdTable(featureRows.slice(0, 100), [
      ['Variant', (row) => row.variant],
      ['Feature', (row) => row.feature],
      ['Trades', (row) => row.trades],
      ['Win %', (row) => row.winRate],
      ['Net PnL', (row) => row.netPnl.toFixed(2)],
    ]),
    '',
    '## Best Symbol Runs',
    '',
    mdTable(topRows.slice(0, 25), [
      ['Variant', (row) => row.variant],
      ['Symbol', (row) => row.symbol],
      ['Daily %', (row) => row.daily.toFixed(3)],
      ['Ret %', (row) => row.ret.toFixed(2)],
      ['Win %', (row) => row.win.toFixed(2)],
      ['PF', (row) => row.pf ?? ''],
      ['Trades', (row) => row.trades],
      ['DD %', (row) => row.dd.toFixed(2)],
    ]),
    '',
    failures.length ? `Failures: ${JSON.stringify(failures)}` : 'Failures: none',
    '',
  ].join('\n');
  fs.writeFileSync(`${base}.md`, md);

  console.table(summary.slice(0, 12).map((row) => ({
    variant: row.variant,
    avgDaily: Number(row.avgDaily?.toFixed(3)),
    medDaily: Number(row.medDaily?.toFixed(3)),
    avgRet: Number(row.avgRet?.toFixed(2)),
    winners: row.winners,
    avgWin: Number(row.avgWin?.toFixed(2)),
    trades: row.totalTrades,
    avgDd: Number(row.avgDd?.toFixed(2)),
  })));
  console.log(`report ${base}.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
