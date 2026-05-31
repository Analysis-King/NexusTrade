const { spawn } = require('node:child_process');

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const COMPOUND = process.argv.includes('--compound') || process.env.COMPOUND === '1';
const NO_JSON = process.argv.includes('--no-json') || process.env.NO_JSON === '1';
const LEVERAGE_ARG = process.argv.find((arg) => arg.startsWith('--leverage='));
const LEVERAGE = LEVERAGE_ARG ? Number(LEVERAGE_ARG.split('=')[1]) : Number(process.env.LEVERAGE || 1);
if (NO_JSON) {
  const log = console.log.bind(console);
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].trim().startsWith('{')) return;
    log(...args);
  };
}

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
    await sleep(45);
  }
  return [...new Map(all.map((candle) => [candle.t, candle])).values()].sort((a, b) => a.t - b.t);
}

async function fetchTopUsdtSymbols(limit = 80) {
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
      if (!symbol.endsWith('USDT')) return false;
      const base = symbol.slice(0, -4);
      if (base.length < 2) return false;
      if (stableOrFiat.has(base)) return false;
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
    const id = `scan_${++seq}`;
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

async function runCase(request, candles, item) {
  const instance = `case_${item.name.replace(/[^a-z0-9]/gi, '_')}_${Math.random().toString(16).slice(2)}`;
  const params = { ...(item.params || {}) };
  if (COMPOUND && params.max_position_pct == null && params.max_position_usd == null) {
    params.max_position_pct = 100;
  }
  if (Number.isFinite(LEVERAGE) && LEVERAGE > 1 && params.leverage == null) {
    params.leverage = LEVERAGE;
  }
  await request('load', { instance, strategy_file: item.file, params });
  const result = await request('backtest', {
    instance,
    candles,
    initial_capital: 1000,
    fee_bps: 10,
    slippage_bps: 2,
    fill_model: 'pessimistic_ohlc',
    start_time: item.start_time,
    params,
  });
  await request('drop', { instance }).catch(() => {});
  const summary = result.summary || {};
  return {
    name: item.name,
    file: item.file,
    ret: summary.totalReturnPct,
    win: summary.winRatePct,
    pf: summary.profitFactor,
    trades: summary.totalTrades,
    dd: summary.maxDrawdownPct,
    final: summary.finalCapital,
  };
}

async function runCaseFull(request, candles, item) {
  const instance = `case_${item.name.replace(/[^a-z0-9]/gi, '_')}_${Math.random().toString(16).slice(2)}`;
  const params = { ...(item.params || {}) };
  if (COMPOUND && params.max_position_pct == null && params.max_position_usd == null) {
    params.max_position_pct = 100;
  }
  if (Number.isFinite(LEVERAGE) && LEVERAGE > 1 && params.leverage == null) {
    params.leverage = LEVERAGE;
  }
  await request('load', { instance, strategy_file: item.file, params });
  const result = await request('backtest', {
    instance,
    candles,
    initial_capital: 1000,
    fee_bps: 10,
    slippage_bps: 2,
    fill_model: 'pessimistic_ohlc',
    start_time: item.start_time,
    params,
  });
  await request('drop', { instance }).catch(() => {});
  const summary = result.summary || {};
  return {
    name: item.name,
    file: item.file,
    ret: summary.totalReturnPct,
    win: summary.winRatePct,
    pf: summary.profitFactor,
    trades: summary.totalTrades,
    dd: summary.maxDrawdownPct,
    final: summary.finalCapital,
    rawTrades: result.trades || [],
    observations: result.observations || [],
    observationStats: result.observationStats || [],
  };
}

function benchmarkReturn(candles) {
  if (!candles.length) return 0;
  const first = Number(candles[0].c || candles[0].o || 0);
  const last = Number(candles.at(-1).c || 0);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return 0;
  return (last / first - 1) * 100;
}

function attachBenchmark(row, candles, days) {
  const benchmark = benchmarkReturn(candles);
  const dailyCompound = row.ret > -100 ? (Math.pow(1 + row.ret / 100, 1 / days) - 1) * 100 : -100;
  return {
    ...row,
    dailySimple: row.ret / days,
    dailyCompound,
    benchmark,
    excess: row.ret - benchmark,
  };
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function pct(count, total) {
  return total ? Number((count * 100 / total).toFixed(2)) : 0;
}

function _patternLabel(meta = {}) {
  const pattern = meta.pattern || 'unknown';
  const direction = meta.direction || '';
  const length = meta.zigzag_length != null ? ` L${meta.zigzag_length}` : '';
  return `${direction ? `${direction} ` : ''}${pattern}${length}`.trim();
}

function addTradePatternStats(target, variant, symbol, trades = []) {
  for (const trade of trades) {
    const meta = trade.meta || {};
    const pattern = meta.pattern || 'unknown';
    const detail = _patternLabel(meta);
    const keys = [
      `${variant}|||pattern|||${pattern}`,
      `${variant}|||detail|||${detail}`,
    ];
    for (const key of keys) {
      const [, scope, label] = key.split('|||');
      const row = target.get(key) || {
        variant,
        scope,
        label,
        symbols: new Set(),
        trades: 0,
        wins: 0,
        losses: 0,
        grossProfit: 0,
        grossLoss: 0,
        netPnl: 0,
        pnlPctSum: 0,
        tp: 0,
        sl: 0,
        signal: 0,
        end: 0,
      };
      const pnl = Number(trade.netPnl || 0);
      row.symbols.add(symbol);
      row.trades += 1;
      row.netPnl += pnl;
      row.pnlPctSum += Number(trade.pnlPct || 0);
      if (pnl > 0) {
        row.wins += 1;
        row.grossProfit += pnl;
      } else if (pnl < 0) {
        row.losses += 1;
        row.grossLoss += Math.abs(pnl);
      }
      if (trade.reason === 'tp') row.tp += 1;
      else if (trade.reason === 'sl') row.sl += 1;
      else if (trade.reason === 'signal') row.signal += 1;
      else if (trade.reason === 'end_of_test') row.end += 1;
      target.set(key, row);
    }
  }
}

function finalizePatternStats(target, scope = 'pattern') {
  return [...target.values()]
    .filter((row) => row.scope === scope)
    .map((row) => ({
      variant: row.variant,
      label: row.label,
      symbols: row.symbols.size,
      trades: row.trades,
      winRate: pct(row.wins, row.trades),
      wins: row.wins,
      losses: row.losses,
      pf: row.grossLoss > 0 ? Number((row.grossProfit / row.grossLoss).toFixed(2)) : (row.grossProfit > 0 ? 99 : null),
      netPnl: Number(row.netPnl.toFixed(2)),
      avgTradePct: row.trades ? Number((row.pnlPctSum / row.trades).toFixed(3)) : 0,
      tp: row.tp,
      sl: row.sl,
      signal: row.signal,
      end: row.end,
    }))
    .sort((a, b) => a.variant.localeCompare(b.variant) || b.trades - a.trades || b.winRate - a.winRate);
}

const harmonicGood6 = [
  { pattern: '5-0', zigzag_length: 20, direction: 'bullish' },
  { pattern: 'White Swan', zigzag_length: 15, direction: 'bearish' },
  { pattern: '5-0', zigzag_length: 5, direction: 'bearish' },
  { pattern: '5-0', zigzag_length: 10, direction: 'bullish' },
  { pattern: 'ABCD', zigzag_length: 5, direction: 'bearish' },
  { pattern: 'Kelebek', zigzag_length: 5, direction: 'bearish' },
];

const tvModes = [
  'supertrend',
  'supertrend_macd',
  'hma_supertrend',
  'ut_bot',
  'pmax',
  'ssl_qqe',
  'halftrend',
  'alpha_trend',
  'chandelier',
  'range_filter',
  'ichimoku',
];

const cases = [
  { name: 'BuyHold', file: 'simple_buy_hold.py', params: {} },
  { name: 'EMA 9/21', file: 'simple_ema_cross.py', params: { fast_period: 9, slow_period: 21, allow_short: true, use_risk: false, exit_on_opposite_signal: true } },
  { name: 'EMA 20/50 risk', file: 'simple_ema_cross.py', params: { fast_period: 20, slow_period: 50, allow_short: true, use_risk: true, stop_loss_pct: 1.2, take_profit_pct: 2.4, exit_on_opposite_signal: true } },
  { name: 'RSI mean reversion', file: 'rsi_mean_reversion.py', params: { exit_on_opposite_signal: true } },
  { name: 'MOST 5/2 base', file: 'most_rsi_stoch.py', params: { ma_period: 5, most_percent: 2, entry_mode: 'flip_reclaim', allow_short: true, use_take_profit: false, exit_on_opposite_signal: true } },
  { name: 'MOST trend', file: 'most_rsi_stoch.py', params: { ma_period: 5, most_percent: 2, entry_mode: 'trend', allow_short: true, use_take_profit: false, exit_on_opposite_signal: true } },
  { name: 'MOST RSI+Stoch', file: 'most_rsi_stoch.py', params: { ma_period: 5, most_percent: 2, entry_mode: 'flip_reclaim', allow_short: true, use_rsi_filter: true, use_stoch_rsi_filter: true, require_stoch_cross: false, use_take_profit: false, exit_on_opposite_signal: true } },
  { name: 'MOST TP RR1.5', file: 'most_rsi_stoch.py', params: { ma_period: 5, most_percent: 2, entry_mode: 'flip_reclaim', allow_short: true, use_take_profit: true, reward_risk: 1.5, exit_on_opposite_signal: true } },
  { name: 'MOST long only', file: 'most_rsi_stoch.py', params: { ma_period: 5, most_percent: 2, entry_mode: 'flip_reclaim', allow_short: false, use_take_profit: false, exit_on_opposite_signal: true } },
  { name: 'Trend ATR default', file: 'trend_atr_breakout.py', params: { allow_short: true, use_take_profit: false, exit_on_opposite_signal: true } },
  { name: 'Trend ATR TP', file: 'trend_atr_breakout.py', params: { allow_short: true, use_take_profit: true, reward_risk: 1.8, exit_on_opposite_signal: true } },
  { name: 'Trend ATR long only', file: 'trend_atr_breakout.py', params: { allow_short: false, use_take_profit: false, exit_on_opposite_signal: true } },
  { name: 'DEMA Cross 20/30', file: 'dema_cross_trend.py', params: { fast_period: 20, slow_period: 30, entry_mode: 'decc_cross', confirm_dema_order: true, allow_short: true, risk_mode: 'atr', stop_atr: 1.6, use_take_profit: false, exit_on_opposite_signal: true } },
  { name: 'DEMA Cross 20/30 TP', file: 'dema_cross_trend.py', params: { fast_period: 20, slow_period: 30, entry_mode: 'decc_cross', confirm_dema_order: true, allow_short: true, risk_mode: 'atr', stop_atr: 1.4, use_take_profit: true, reward_risk: 2.0, exit_on_opposite_signal: true } },
  { name: 'Explosion default', file: 'explosion_catcher.py', params: {} },
  { name: 'Explosion loose', file: 'explosion_catcher.py', params: { min_score: 12, min_day_gain_pct: 1.2, max_day_gain_pct: 3.0, reward_risk: 2.0 } },
  { name: 'Explosion strict', file: 'explosion_catcher.py', params: { min_score: 18, min_day_gain_pct: 1.8, max_day_gain_pct: 2.8, reward_risk: 2.2 } },
  { name: 'SMC swing CHoCH', file: 'smart_money_concepts.py', params: { signal_scope: 'swing', signal_tag: 'CHoCH', reward_risk: 2.0, stop_source: 'structure', allow_short: true, exit_on_opposite_signal: true } },
  { name: 'SMC internal CHoCH', file: 'smart_money_concepts.py', params: { signal_scope: 'internal', signal_tag: 'CHoCH', reward_risk: 2.0, stop_source: 'structure', allow_short: true, exit_on_opposite_signal: true } },
  { name: 'SMC both BOS/CHoCH', file: 'smart_money_concepts.py', params: { signal_scope: 'both', signal_tag: 'ALL', reward_risk: 2.0, stop_source: 'structure', allow_short: true, exit_on_opposite_signal: true } },
  { name: 'Harmonic filtered', file: 'pine_harmonic_patterns.py', params: { allow_repaint: true, allow_short: true, take_profit_mode: 'target_1', stop_loss_mode: 'strategy', stop_loss_target_ratio: 1, min_reward_risk: 0.75, trade_filters: harmonicGood6 } },
  { name: 'Harmonic good4 t1', file: 'pine_harmonic_patterns.py', params: { allow_repaint: true, allow_short: true, take_profit_mode: 'target_1', stop_loss_mode: 'strategy', stop_loss_target_ratio: 1, min_reward_risk: 0.75, recent_signal_bars: 3, trade_filters: harmonicGood6.slice(0, 4) } },
  { name: 'Harmonic good4 trail', file: 'pine_harmonic_patterns.py', params: { allow_repaint: true, allow_short: true, exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_mode: 'strategy', stop_loss_target_ratio: 1, min_reward_risk: 0.5, recent_signal_bars: 3, breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.1, trade_filters: harmonicGood6.slice(0, 4) } },
  { name: 'Harmonic HTF 4h reversal', file: 'pine_harmonic_patterns.py', params: { allow_repaint: true, allow_short: true, exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_mode: 'strategy', stop_loss_target_ratio: 1, min_reward_risk: 0.5, recent_signal_bars: 3, breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.1, trade_filters: harmonicGood6.slice(0, 4), htf_regime_filter: 'reversal', htf_timeframe: '4h', htf_allow_unknown: false } },
  { name: 'Harmonic HTF bear long', file: 'pine_harmonic_patterns.py', params: { allow_repaint: true, allow_short: false, exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_mode: 'strategy', stop_loss_target_ratio: 1, min_reward_risk: 0.5, recent_signal_bars: 3, breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.1, trade_filters: harmonicGood6.filter((item) => item.direction === 'bullish'), htf_regime_filter: 'custom', htf_timeframe: '4h', htf_long_regime: 'bear', htf_allow_unknown: false } },
  { name: 'Harmonic DEMA trend', file: 'pine_harmonic_patterns.py', params: { allow_repaint: true, allow_short: true, exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_mode: 'strategy', stop_loss_target_ratio: 1, min_reward_risk: 0.5, recent_signal_bars: 3, breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.1, trade_filters: harmonicGood6.slice(0, 4), dema_filter: 'with_trend', dema_fast_period: 20, dema_slow_period: 30 } },
  { name: 'Harmonic DEMA reversal', file: 'pine_harmonic_patterns.py', params: { allow_repaint: true, allow_short: true, exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_mode: 'strategy', stop_loss_target_ratio: 1, min_reward_risk: 0.5, recent_signal_bars: 3, breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.1, trade_filters: harmonicGood6.slice(0, 4), dema_filter: 'reversal', dema_fast_period: 20, dema_slow_period: 30 } },
  { name: 'Harmonic only 5-0', file: 'pine_harmonic_patterns.py', params: { allow_repaint: true, allow_short: true, take_profit_mode: 'target_1', stop_loss_mode: 'strategy', stop_loss_target_ratio: 1, min_reward_risk: 0.75, recent_signal_bars: 3, enabled_patterns: ['5-0'] } },
  { name: 'Supply Demand base', file: 'supply_demand_zones.py', params: { allow_short: true, reward_risk: 1.8, min_strength: 58, max_tests: 1, entry_mode: 'rejection' } },
];

for (const mode of tvModes) {
  cases.push({ name: `TV ${mode}`, file: 'tradingview_popular_suite.py', params: { mode, allow_short: true, use_take_profit: false, exit_on_opposite_signal: true } });
}
for (const mode of ['supertrend', 'supertrend_macd', 'hma_supertrend', 'pmax', 'alpha_trend']) {
  cases.push({ name: `TV ${mode} RSI/MACD`, file: 'tradingview_popular_suite.py', params: { mode, allow_short: true, use_rsi_filter: true, use_macd_filter: true, use_take_profit: false, exit_on_opposite_signal: true } });
  cases.push({ name: `TV ${mode} TP`, file: 'tradingview_popular_suite.py', params: { mode, allow_short: true, use_take_profit: true, reward_risk: 1.5, exit_on_opposite_signal: true } });
}

function buildMomentumCandidateCases() {
  const out = [];
  const add = (name, file, params) => out.push({ name, file, params });

  const trendShapes = [
    ['fast', { fast_ema: 9, mid_ema: 21, slow_ema: 55, slope_period: 6 }],
    ['medium', { fast_ema: 13, mid_ema: 34, slow_ema: 89, slope_period: 8 }],
    ['slow', { fast_ema: 21, mid_ema: 55, slow_ema: 144, slope_period: 12 }],
  ];
  for (const [shapeName, shape] of trendShapes) {
    for (const breakout_period of [8, 14, 24]) {
      for (const min_atr_pct of [0.08, 0.16, 0.28]) {
        add(`Trend ${shapeName} br${breakout_period} atr${min_atr_pct} long`, 'trend_atr_breakout.py', {
          ...shape,
          breakout_period,
          min_atr_pct,
          min_slope_pct: 0.02,
          stop_atr: 1.0,
          reward_risk: 1.8,
          use_take_profit: true,
          allow_short: false,
          exit_on_opposite_signal: true,
          cooldown_bars: 6,
        });
        add(`Trend ${shapeName} br${breakout_period} atr${min_atr_pct} both`, 'trend_atr_breakout.py', {
          ...shape,
          breakout_period,
          min_atr_pct,
          min_slope_pct: 0.02,
          stop_atr: 1.2,
          reward_risk: 2.0,
          use_take_profit: true,
          allow_short: true,
          exit_on_opposite_signal: true,
          cooldown_bars: 8,
        });
      }
    }
  }

  const dailyShapes = [
    ['early', { min_day_gain_pct: 0.4, max_day_gain_pct: 2.2, min_roc_pct: 0.12, min_volume_ratio: 0.8, require_breakout: false }],
    ['breakout', { min_day_gain_pct: 0.7, max_day_gain_pct: 2.8, min_roc_pct: 0.18, min_volume_ratio: 1.0, require_breakout: true }],
    ['strict', { min_day_gain_pct: 1.0, max_day_gain_pct: 3.5, min_roc_pct: 0.3, min_volume_ratio: 1.2, require_breakout: true }],
  ];
  for (const [shapeName, shape] of dailyShapes) {
    for (const breakout_period of [12, 24]) {
      for (const reward_risk of [1.4, 1.8, 2.3]) {
        add(`Daily ${shapeName} br${breakout_period} rr${reward_risk} long`, 'daily_momentum_breakout.py', {
          ...shape,
          breakout_period,
          reward_risk,
          allow_short: false,
          stop_atr: 0.9,
          min_stop_pct: 0.18,
          max_stop_pct: 1.0,
          trailing_stop: true,
          trail_atr: 1.2,
          exit_on_momentum_loss: true,
          cooldown_bars: 8,
        });
        add(`Daily ${shapeName} br${breakout_period} rr${reward_risk} both`, 'daily_momentum_breakout.py', {
          ...shape,
          breakout_period,
          reward_risk,
          allow_short: true,
          stop_atr: 1.0,
          min_stop_pct: 0.2,
          max_stop_pct: 1.1,
          trailing_stop: true,
          trail_atr: 1.3,
          exit_on_momentum_loss: true,
          cooldown_bars: 10,
        });
      }
    }
  }

  for (const rsi_period of [7, 14, 21]) {
    for (const [oversold, overbought] of [[25, 75], [30, 70], [35, 65]]) {
      add(`RSI revert p${rsi_period} ${oversold}/${overbought} long`, 'rsi_mean_reversion.py', {
        rsi_period,
        oversold,
        overbought,
        allow_short: false,
        exit_on_midline: true,
        stop_loss_pct: 1.2,
        take_profit_pct: 2.4,
        exit_on_opposite_signal: true,
      });
      add(`RSI revert p${rsi_period} ${oversold}/${overbought} both`, 'rsi_mean_reversion.py', {
        rsi_period,
        oversold,
        overbought,
        allow_short: true,
        exit_on_midline: true,
        stop_loss_pct: 1.2,
        take_profit_pct: 2.4,
        exit_on_opposite_signal: true,
      });
    }
  }

  add('Mined reversal v1 both', 'mined_reversal_edge.py', {
    allow_short: true,
    reward_risk: 1.5,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 6,
    exit_on_opposite_signal: true,
  });
  add('Mined reversal v1 long', 'mined_reversal_edge.py', {
    allow_short: false,
    reward_risk: 1.5,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 6,
    exit_on_opposite_signal: true,
  });
  add('Mined reversal loose long', 'mined_reversal_edge.py', {
    allow_short: false,
    long_rsi_max: 35,
    long_stoch_min: 15,
    long_stoch_max: 45,
    long_min_bb_width: 8,
    reward_risk: 1.4,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 6,
    exit_on_opposite_signal: true,
  });
  add('Mined reversal strict long', 'mined_reversal_edge.py', {
    allow_short: false,
    long_rsi_max: 30,
    long_stoch_min: 20,
    long_stoch_max: 40,
    long_min_bb_width: 12,
    reward_risk: 1.8,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 8,
    exit_on_opposite_signal: true,
  });
  add('Mined strict regime mixed', 'mined_reversal_edge.py', {
    allow_short: false,
    long_rsi_max: 30,
    long_stoch_min: 20,
    long_stoch_max: 40,
    long_min_bb_width: 12,
    reward_risk: 1.8,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 8,
    regime_filter: true,
    regime_fast_period: 50,
    regime_slow_period: 200,
    regime_allow_mixed: true,
    exit_on_opposite_signal: true,
  });
  add('Mined strict regime bull', 'mined_reversal_edge.py', {
    allow_short: false,
    long_rsi_max: 30,
    long_stoch_min: 20,
    long_stoch_max: 40,
    long_min_bb_width: 12,
    reward_risk: 1.8,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 8,
    regime_filter: true,
    regime_fast_period: 50,
    regime_slow_period: 200,
    regime_allow_mixed: false,
    exit_on_opposite_signal: true,
  });
  add('Mined both regime directional', 'mined_reversal_edge.py', {
    allow_short: true,
    reward_risk: 1.5,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 6,
    regime_filter: true,
    regime_fast_period: 50,
    regime_slow_period: 200,
    regime_allow_mixed: true,
    exit_on_opposite_signal: true,
  });
  add('Mined strict htf bear long', 'mined_reversal_edge.py', {
    allow_long: true,
    allow_short: false,
    long_rsi_max: 30,
    long_stoch_min: 20,
    long_stoch_max: 40,
    long_min_bb_width: 12,
    reward_risk: 1.8,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 8,
    regime_filter: true,
    regime_fast_period: 84,
    regime_slow_period: 220,
    regime_allow_mixed: false,
    long_regime: 'bear',
    exit_on_opposite_signal: true,
  });
  add('Mined strict htf bear/mixed long', 'mined_reversal_edge.py', {
    allow_long: true,
    allow_short: false,
    long_rsi_max: 30,
    long_stoch_min: 20,
    long_stoch_max: 40,
    long_min_bb_width: 12,
    reward_risk: 1.8,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 8,
    regime_filter: true,
    regime_fast_period: 84,
    regime_slow_period: 220,
    regime_allow_mixed: true,
    long_regime: 'bear_or_mixed',
    exit_on_opposite_signal: true,
  });
  add('Mined short htf bear continuation', 'mined_reversal_edge.py', {
    allow_long: false,
    allow_short: true,
    reward_risk: 1.5,
    min_stop_pct: 0.35,
    max_stop_pct: 1.4,
    cooldown_bars: 6,
    regime_filter: true,
    regime_fast_period: 84,
    regime_slow_period: 220,
    regime_allow_mixed: false,
    short_regime: 'bear',
    exit_on_opposite_signal: true,
  });

  for (const mode of ['supertrend', 'hma_supertrend', 'pmax', 'alpha_trend', 'chandelier', 'range_filter', 'ut_bot']) {
    add(`TV ${mode} long ema100`, 'tradingview_popular_suite.py', {
      mode,
      allow_short: false,
      use_ema_filter: true,
      ema_filter_period: 100,
      stop_atr: 1.0,
      min_stop_pct: 0.12,
      max_stop_pct: 1.2,
      use_take_profit: true,
      reward_risk: 1.8,
      exit_on_opposite_signal: true,
    });
    add(`TV ${mode} both rsi_macd`, 'tradingview_popular_suite.py', {
      mode,
      allow_short: true,
      use_rsi_filter: true,
      use_macd_filter: true,
      stop_atr: 1.0,
      min_stop_pct: 0.12,
      max_stop_pct: 1.4,
      use_take_profit: true,
      reward_risk: 1.6,
      exit_on_opposite_signal: true,
    });
    add(`TV ${mode} trail`, 'tradingview_popular_suite.py', {
      mode,
      allow_short: true,
      stop_atr: 1.3,
      min_stop_pct: 0.18,
      max_stop_pct: 1.6,
      use_take_profit: false,
      exit_on_opposite_signal: true,
    });
  }

  for (const min_score of [10, 12, 15]) {
    for (const min_day_gain_pct of [0.5, 0.9, 1.3]) {
      for (const reward_risk of [1.5, 2.2]) {
        add(`Explosion s${min_score} day${min_day_gain_pct} rr${reward_risk}`, 'explosion_catcher.py', {
          min_score,
          min_day_gain_pct,
          max_day_gain_pct: min_day_gain_pct + 1.8,
          reward_risk,
          stop_loss_pct: 0.8,
          max_stop_pct: 1.4,
          exit_on_momentum_loss: true,
          max_hold_bars: 42,
        });
      }
    }
  }

  for (const [signal_scope, signal_tag] of [['swing', 'CHoCH'], ['swing', 'BOS'], ['internal', 'CHoCH'], ['both', 'ALL']]) {
    for (const reward_risk of [1.6, 2.2, 3.0]) {
      add(`SMC ${signal_scope} ${signal_tag} rr${reward_risk}`, 'smart_money_concepts.py', {
        signal_scope,
        signal_tag,
        reward_risk,
        stop_source: 'structure',
        max_stop_pct: 1.8,
        allow_short: true,
        use_take_profit: true,
        exit_on_opposite_signal: true,
        cooldown_bars: 5,
      });
    }
  }

  for (const entry_mode of ['decc_cross', 'dema_cross']) {
    for (const stop_atr of [1.2, 1.6, 2.0]) {
      add(`DEMA ${entry_mode} atr${stop_atr}`, 'dema_cross_trend.py', {
        fast_period: 20,
        slow_period: 30,
        entry_mode,
        confirm_dema_order: true,
        allow_short: true,
        risk_mode: 'atr',
        stop_atr,
        use_take_profit: false,
        exit_on_opposite_signal: true,
      });
      add(`DEMA ${entry_mode} atr${stop_atr} TP`, 'dema_cross_trend.py', {
        fast_period: 20,
        slow_period: 30,
        entry_mode,
        confirm_dema_order: true,
        allow_short: true,
        risk_mode: 'atr',
        stop_atr,
        reward_risk: 2.0,
        use_take_profit: true,
        exit_on_opposite_signal: true,
      });
    }
  }

  for (const entry_mode of ['rejection', 'close_outside', 'touch']) {
    for (const min_strength of [52, 58, 65]) {
      for (const reward_risk of [1.4, 1.8, 2.4]) {
        add(`Supply Demand ${entry_mode} s${min_strength} rr${reward_risk}`, 'supply_demand_zones.py', {
          entry_mode,
          min_strength,
          reward_risk,
          min_reward_risk: 1.0,
          max_tests: entry_mode === 'touch' ? 0 : 1,
          fresh_only: entry_mode === 'touch',
          impulse_atr: 1.25,
          min_departure_atr: 0.35,
          min_volume_ratio: 0.8,
          min_entry_age_bars: 4,
          range_filter: true,
          allow_short: true,
          exit_on_opposite_signal: true,
        });
      }
    }
  }
  for (const htf_filter of ['with_trend', 'reversal']) {
    for (const min_strength of [52, 58]) {
      add(`Supply Demand ${htf_filter} s${min_strength}`, 'supply_demand_zones.py', {
        entry_mode: 'rejection',
        min_strength,
        reward_risk: 1.8,
        min_reward_risk: 1.0,
        max_tests: 1,
        impulse_atr: 1.25,
        min_departure_atr: 0.35,
        min_volume_ratio: 0.8,
        min_entry_age_bars: 4,
        range_filter: true,
        htf_filter,
        htf_timeframe: '4h',
        allow_short: true,
        exit_on_opposite_signal: true,
      });
    }
  }

  const harmonicBase = {
    allow_repaint: true,
    allow_short: true,
    exit_mode: 'tp2_trail',
    take_profit_mode: 'target_1',
    stop_loss_mode: 'strategy',
    stop_loss_target_ratio: 1,
    min_reward_risk: 0.5,
    recent_signal_bars: 3,
    breakeven_buffer_pct: 0.02,
    trail_atr_period: 14,
    trail_atr_mult: 1.1,
    trade_filters: harmonicGood6.slice(0, 4),
  };
  add('Harmonic good4 trail', 'pine_harmonic_patterns.py', harmonicBase);
  add('Harmonic HTF 4h reversal', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    htf_regime_filter: 'reversal',
    htf_timeframe: '4h',
    htf_allow_unknown: false,
  });
  add('Harmonic HTF 4h prefer reversal', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    htf_regime_filter: 'prefer_reversal',
    htf_timeframe: '4h',
    htf_allow_unknown: false,
  });
  add('Harmonic HTF 4h with trend', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    htf_regime_filter: 'with_trend',
    htf_timeframe: '4h',
    htf_allow_unknown: false,
  });
  add('Harmonic HTF 4h prefer trend', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    htf_regime_filter: 'prefer_with_trend',
    htf_timeframe: '4h',
    htf_allow_unknown: false,
  });
  add('Harmonic HTF bear long', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    allow_short: false,
    trade_filters: harmonicGood6.filter((item) => item.direction === 'bullish'),
    htf_regime_filter: 'custom',
    htf_timeframe: '4h',
    htf_long_regime: 'bear',
    htf_allow_unknown: false,
  });
  add('Harmonic HTF bear/mixed long', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    allow_short: false,
    trade_filters: harmonicGood6.filter((item) => item.direction === 'bullish'),
    htf_regime_filter: 'custom',
    htf_timeframe: '4h',
    htf_long_regime: 'bear_or_mixed',
    htf_allow_unknown: false,
  });
  add('Harmonic HTF 1d reversal', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    htf_regime_filter: 'reversal',
    htf_timeframe: '1d',
    htf_allow_unknown: false,
  });
  add('Harmonic DEMA trend', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    dema_filter: 'with_trend',
    dema_fast_period: 20,
    dema_slow_period: 30,
  });
  add('Harmonic DEMA reversal', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    dema_filter: 'reversal',
    dema_fast_period: 20,
    dema_slow_period: 30,
  });
  add('Harmonic long stop r1.5', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    stop_loss_target_ratio: 1.5,
  });
  add('Harmonic long stop r2', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    stop_loss_target_ratio: 2,
  });
  add('Harmonic 5-0 r2', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    trade_filters: harmonicGood6.slice(0, 4).filter((item) => item.pattern === '5-0'),
    stop_loss_target_ratio: 2,
  });
  add('Harmonic DEMA trend stop r1.5', 'pine_harmonic_patterns.py', {
    ...harmonicBase,
    stop_loss_target_ratio: 1.5,
    dema_filter: 'with_trend',
    dema_fast_period: 20,
    dema_slow_period: 30,
  });

  return out;
}

function buildInternetTop10Cases() {
  const tvBase = {
    allow_short: true,
    use_ema_filter: true,
    ema_filter_period: 100,
    stop_atr: 1.2,
    min_stop_pct: 0.16,
    max_stop_pct: 1.6,
    use_take_profit: false,
    reward_risk: 1.8,
    cooldown_bars: 3,
    exit_on_opposite_signal: true,
  };

  const tv = (name, mode, params = {}) => ({
    name,
    file: 'tradingview_popular_suite.py',
    params: { ...tvBase, mode, ...params },
  });

  return [
    tv('Internet 01 Supertrend', 'supertrend', {
      atr_period: 10,
      supertrend_mult: 3.0,
    }),
    tv('Internet 02 UT Bot', 'ut_bot', {
      ut_atr_period: 10,
      ut_key: 2.0,
      stop_atr: 1.0,
    }),
    tv('Internet 03 PMax', 'pmax', {
      pmax_ma_period: 10,
      pmax_atr_mult: 3.0,
    }),
    tv('Internet 04 AlphaTrend', 'alpha_trend', {
      alpha_coeff: 1.0,
      alpha_rsi_level: 50,
    }),
    tv('Internet 05 Chandelier Exit', 'chandelier', {
      chandelier_period: 22,
      chandelier_mult: 3.0,
    }),
    tv('Internet 06 Ichimoku Cloud', 'ichimoku', {
      tenkan_period: 9,
      kijun_period: 26,
      senkou_b_period: 52,
      stop_atr: 1.4,
    }),
    tv('Internet 07 Range Filter', 'range_filter', {
      range_period: 20,
      range_mult: 3.0,
      stop_atr: 1.0,
    }),
    tv('Internet 08 HMA Supertrend', 'hma_supertrend', {
      hma_period: 55,
      supertrend_mult: 2.6,
      stop_atr: 1.1,
    }),
    {
      name: 'Internet 09 Donchian ATR Breakout',
      file: 'trend_atr_breakout.py',
      params: {
        fast_ema: 21,
        mid_ema: 55,
        slow_ema: 144,
        breakout_period: 20,
        slope_period: 12,
        min_slope_pct: 0.02,
        min_atr_pct: 0.08,
        max_atr_pct: 3.0,
        stop_atr: 1.4,
        reward_risk: 1.8,
        use_take_profit: false,
        allow_short: true,
        cooldown_bars: 8,
        exit_on_opposite_signal: true,
      },
    },
    {
      name: 'Internet 10 Bollinger RSI Squeeze',
      file: 'bollinger_rsi_squeeze.py',
      params: {
        bb_period: 20,
        bb_std_mult: 2.0,
        squeeze_lookback: 120,
        squeeze_percentile: 0.35,
        require_squeeze: true,
        require_expansion: true,
        use_ema_filter: true,
        ema_filter_period: 100,
        rsi_period: 14,
        rsi_long_min: 54,
        rsi_short_max: 46,
        use_macd_filter: true,
        stop_atr: 1.4,
        min_stop_pct: 0.18,
        max_stop_pct: 1.8,
        use_take_profit: false,
        reward_risk: 1.8,
        allow_short: true,
        cooldown_bars: 8,
        exit_on_midline: true,
      },
    },
  ];
}

function summarizeStrategyRows(name, rows, params) {
  const total = rows.length;
  return {
    preset: name,
    tested: total,
    profitable: rows.filter((row) => row.ret > 0).length,
    profitablePct: pct(rows.filter((row) => row.ret > 0).length, total),
    beatBenchmark: rows.filter((row) => row.excess > 0).length,
    beatBenchmarkPct: pct(rows.filter((row) => row.excess > 0).length, total),
    dailyCompoundAbove1: rows.filter((row) => row.dailyCompound >= 1).length,
    dailyCompoundAbove1Pct: pct(rows.filter((row) => row.dailyCompound >= 1).length, total),
    avgReturn: average(rows.map((row) => row.ret)),
    medianReturn: median(rows.map((row) => row.ret)),
    avgDailyCompound: average(rows.map((row) => row.dailyCompound)),
    medianDailyCompound: median(rows.map((row) => row.dailyCompound)),
    avgMaxDrawdown: average(rows.map((row) => row.dd)),
    medianMaxDrawdown: median(rows.map((row) => row.dd)),
    avgTrades: average(rows.map((row) => row.trades)),
    params,
  };
}

async function main() {
  const mode = process.argv[2] || 'scan';
  const { child, request } = startWorker();
  try {
    if (mode === 'validate') {
      const topNames = new Set((process.argv[3] || '').split(',').map((item) => item.trim()).filter(Boolean));
      const selected = topNames.size ? cases.filter((item) => topNames.has(item.name)) : cases.slice(0, 6);
      const jobs = [
        ['BTCUSDT', '5m', 30],
        ['BTCUSDT', '15m', 30],
        ['BTCUSDT', '30m', 30],
        ['BTCUSDT', '1h', 30],
        ['BTCUSDT', '15m', 90],
        ['ETHUSDT', '15m', 90],
        ['SOLUSDT', '15m', 90],
        ['BNBUSDT', '15m', 90],
      ];
      const rows = [];
      for (const [symbol, interval, days] of jobs) {
        const candles = await fetchCandles(symbol, interval, days);
        for (const item of selected) {
          const row = await runCase(request, candles, item);
          rows.push({ symbol, interval, days, candles: candles.length, ...row });
        }
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.map(({ symbol, interval, days, name, ret, win, pf, trades, dd }) => ({ symbol, interval, days, name, ret, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'scan-one') {
      const symbol = process.argv[3] || 'BTCUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const rows = [];
      for (const item of cases) {
        const row = await runCase(request, candles, item);
        rows.push(attachBenchmark({ symbol, interval, days, ...row, params: item.params || {} }, candles, days));
      }
      rows.sort((a, b) => b.excess - a.excess);
      console.table(rows.slice(0, 30).map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'edge-trend-check') {
      const symbol = process.argv[3] || 'KITEUSDT';
      const interval = process.argv[4] || '1h';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const presets = [
        {
          name: 'Edge trend pullback 13/55/200 rr1.5',
          file: 'edge_trend_pullback.py',
          params: {
            fast_ema: 13,
            mid_ema: 55,
            slow_ema: 200,
            adx_period: 14,
            adx_min: 24,
            atr_period: 14,
            stop_atr: 1,
            reward_risk: 1.5,
            pullback: true,
            allow_short: true,
            use_take_profit: true,
            exit_on_opposite_signal: true,
          },
        },
        {
          name: 'Edge trend breakout 13/55/200 rr2.2',
          file: 'edge_trend_pullback.py',
          params: {
            fast_ema: 13,
            mid_ema: 55,
            slow_ema: 200,
            adx_period: 14,
            adx_min: 24,
            atr_period: 14,
            stop_atr: 1,
            reward_risk: 2.2,
            pullback: false,
            allow_short: true,
            use_take_profit: true,
            exit_on_opposite_signal: true,
          },
        },
      ];
      const rows = [];
      for (const preset of presets) {
        const row = await runCase(request, candles, preset);
        rows.push(attachBenchmark({ symbol, interval, days, ...row, params: preset.params }, candles, days));
      }
      const splitIndex = Math.max(300, Math.floor(candles.length * 0.67));
      const trainCandles = candles.slice(0, splitIndex + 1);
      const validationStart = candles[Math.min(splitIndex + 1, candles.length - 1)]?.t;
      const splitRows = [];
      for (const preset of presets) {
        const trainRow = await runCase(request, trainCandles, { ...preset, name: `${preset.name} train` });
        const valRow = await runCase(request, candles, {
          ...preset,
          name: `${preset.name} validation`,
          start_time: validationStart,
        });
        splitRows.push({
          name: preset.name,
          train: attachBenchmark({ symbol, interval, days: days * splitIndex / candles.length, ...trainRow }, trainCandles, days * splitIndex / candles.length),
          validation: attachBenchmark({ symbol, interval, days: days * (candles.length - splitIndex) / candles.length, ...valRow }, candles.slice(splitIndex), days * (candles.length - splitIndex) / candles.length),
        });
      }
      rows.sort((a, b) => b.dailyCompound - a.dailyCompound);
      console.table(rows.map(({ name, ret, dailyCompound, benchmark, excess, win, pf, trades, dd }) => ({
        name,
        ret,
        dailyCompound,
        benchmark,
        excess,
        win,
        pf,
        trades,
        dd,
      })));
      console.log('Train / validation:');
      console.table(splitRows.map((row) => ({
        name: row.name,
        trainRet: row.train.ret,
        trainDaily: row.train.dailyCompound,
        trainTrades: row.train.trades,
        trainDd: row.train.dd,
        valRet: row.validation.ret,
        valDaily: row.validation.dailyCompound,
        valTrades: row.validation.trades,
        valDd: row.validation.dd,
      })));
      console.log(JSON.stringify({ symbol, interval, days, leverage: LEVERAGE, rows }, null, 2));
      return;
    }

    if (mode === 'edge-trend-matrix') {
      const intervals = (process.argv[3] || '5m,15m,30m,1h').split(',').map((value) => value.trim()).filter(Boolean);
      const days = Number(process.argv[4] || 90);
      const targetCount = Number(process.argv[5] || 50);
      const preset = {
        name: 'Edge trend pullback 13/55/200 rr1.5',
        file: 'edge_trend_pullback.py',
        params: {
          fast_ema: 13,
          mid_ema: 55,
          slow_ema: 200,
          adx_period: 14,
          adx_min: 24,
          atr_period: 14,
          stop_atr: 1,
          reward_risk: 1.5,
          pullback: true,
          allow_short: true,
          use_take_profit: true,
          exit_on_opposite_signal: true,
        },
      };
      const candidates = await fetchTopUsdtSymbols(Math.max(targetCount * 2, 90));
      const symbols = [];
      for (const symbol of candidates) {
        if (symbols.length >= targetCount) break;
        symbols.push(symbol);
      }
      const rows = [];
      const failures = [];
      console.log(`Edge trend matrix: ${intervals.join(', ')} x ${symbols.length} sembol, ${days} gun, leverage=${LEVERAGE}`);
      for (const interval of intervals) {
        let completed = 0;
        for (const symbol of symbols) {
          try {
            const candles = await fetchCandles(symbol, interval, days);
            if (candles.length < 300) {
              failures.push({ symbol, interval, reason: `az mum: ${candles.length}` });
              continue;
            }
            const row = await runCase(request, candles, preset);
            rows.push(attachBenchmark({ symbol, interval, days, ...row }, candles, days));
            completed += 1;
            if (completed % 10 === 0) {
              console.log(`${interval}: ${completed}/${symbols.length} tamamlandi`);
            }
          } catch (err) {
            failures.push({ symbol, interval, reason: err.message });
          }
        }
      }
      const byInterval = intervals.map((interval) => {
        const group = rows.filter((row) => row.interval === interval);
        const winners = group.filter((row) => Number(row.ret) > 0);
        const targetHits = group.filter((row) => Number(row.dailyCompound) >= 0.8);
        const traded = group.filter((row) => Number(row.trades) > 0);
        return {
          interval,
          symbols: group.length,
          avgRet: average(group.map((row) => row.ret)),
          medRet: median(group.map((row) => row.ret)),
          avgDaily: average(group.map((row) => row.dailyCompound)),
          medDaily: median(group.map((row) => row.dailyCompound)),
          winners: pct(winners.length, group.length),
          targetHits: targetHits.length,
          avgTrades: average(group.map((row) => row.trades)),
          tradedSymbols: traded.length,
          avgDd: average(group.map((row) => row.dd)),
        };
      });
      rows.sort((a, b) => b.dailyCompound - a.dailyCompound);
      console.log('Periyot ozeti:');
      console.table(byInterval.map((row) => ({
        interval: row.interval,
        symbols: row.symbols,
        avgRet: Number(row.avgRet?.toFixed(2)),
        medRet: Number(row.medRet?.toFixed(2)),
        avgDaily: Number(row.avgDaily?.toFixed(3)),
        medDaily: Number(row.medDaily?.toFixed(3)),
        winners: row.winners,
        targetHits: row.targetHits,
        avgTrades: Number(row.avgTrades?.toFixed(1)),
        avgDd: Number(row.avgDd?.toFixed(2)),
      })));
      console.log('En iyi 30 sembol/periyot:');
      console.table(rows.slice(0, 30).map((row) => ({
        symbol: row.symbol,
        interval: row.interval,
        ret: Number(row.ret?.toFixed(2)),
        daily: Number(row.dailyCompound?.toFixed(3)),
        win: Number(row.win?.toFixed(2)),
        pf: Number(row.pf?.toFixed(2)),
        trades: row.trades,
        dd: Number(row.dd?.toFixed(2)),
        benchmark: Number(row.benchmark?.toFixed(2)),
      })));
      console.log(JSON.stringify({ days, targetCount: symbols.length, intervals, leverage: LEVERAGE, summary: byInterval, top: rows.slice(0, 50), failures }, null, 2));
      return;
    }

    if (mode === 'explosion-grid') {
      const candles = await fetchCandles('BTCUSDT', '15m', 30);
      const rows = [];
      const variants = [
        [8, 0.8, 1.5, false],
        [8, 1.2, 1.5, false],
        [12, 0.8, 1.5, false],
        [12, 1.2, 2.2, false],
      ];
      for (const [minScore, minDayGain, rewardRisk, exitOnLoss] of variants) {
        const params = {
          min_score: minScore,
          min_day_gain_pct: minDayGain,
          max_day_gain_pct: minDayGain + 1.4,
          reward_risk: rewardRisk,
          exit_on_momentum_loss: exitOnLoss,
        };
        const row = await runCase(request, candles, {
          name: `Explosion score${minScore} day${minDayGain} rr${rewardRisk} exit${exitOnLoss}`,
          file: 'explosion_catcher.py',
          params,
        });
        rows.push({ ...row, params });
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.map(({ name, ret, win, pf, trades, dd }) => ({ name, ret, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'smc-grid') {
      const symbol = process.argv[3] || 'ETHUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const rows = [];
      const scopes = ['swing', 'internal', 'both'];
      const tags = ['CHoCH', 'BOS', 'ALL'];
      const stopSources = ['structure', 'atr'];
      const rewardRisks = [1.2, 1.6, 2.0, 2.6];
      const maxStops = [1.5, 3.0];
      for (const signal_scope of scopes) {
        for (const signal_tag of tags) {
          for (const stop_source of stopSources) {
            for (const reward_risk of rewardRisks) {
              for (const max_stop_pct of maxStops) {
                const params = {
                  signal_scope,
                  signal_tag,
                  stop_source,
                  reward_risk,
                  max_stop_pct,
                  stop_atr: 1.5,
                  swing_length: 50,
                  internal_length: 5,
                  allow_short: true,
                  use_take_profit: true,
                  exit_on_opposite_signal: true,
                  cooldown_bars: 5,
                };
                const row = await runCase(request, candles, {
                  name: `SMC ${signal_scope} ${signal_tag} ${stop_source} rr${reward_risk} max${max_stop_pct}`,
                  file: 'smart_money_concepts.py',
                  params,
                });
                rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
              }
            }
          }
        }
      }
      rows.sort((a, b) => b.excess - a.excess || b.ret - a.ret);
      console.table(rows.slice(0, 30).map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'smc-best') {
      const symbol = process.argv[3] || 'ETHUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const bestCases = [
        ['SMC ETH top swing CHoCH rr2.6', { signal_scope: 'swing', signal_tag: 'CHoCH', stop_source: 'structure', reward_risk: 2.6, max_stop_pct: 3.0 }],
        ['SMC ETH conservative rr1.6', { signal_scope: 'swing', signal_tag: 'ALL', stop_source: 'structure', reward_risk: 1.6, max_stop_pct: 1.5 }],
        ['SMC swing BOS atr rr2.6', { signal_scope: 'swing', signal_tag: 'BOS', stop_source: 'atr', reward_risk: 2.6, max_stop_pct: 3.0 }],
      ];
      const rows = [];
      for (const [name, extra] of bestCases) {
        const params = {
          swing_length: 50,
          internal_length: 5,
          allow_short: true,
          use_take_profit: true,
          exit_on_opposite_signal: true,
          cooldown_bars: 5,
          ...extra,
        };
        const row = await runCase(request, candles, {
          name,
          file: 'smart_money_concepts.py',
          params,
        });
        rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
      }
      rows.sort((a, b) => b.excess - a.excess || b.ret - a.ret);
      console.table(rows.map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'strategy-candidate-basket') {
      const interval = process.argv[3] || '15m';
      const days = Number(process.argv[4] || 90);
      const targetCount = Number(process.argv[5] || 12);
      const filterArg = (process.argv[6] || '').startsWith('--') ? '' : (process.argv[6] || '');
      const filters = filterArg.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      const allPresets = buildMomentumCandidateCases();
      const activePresets = filters.length
        ? allPresets.filter((preset) => filters.some((filter) => preset.name.toLowerCase().includes(filter)))
        : allPresets;

      const candidates = await fetchTopUsdtSymbols(Math.max(targetCount * 2, 90));
      const presetRows = new Map(activePresets.map((preset) => [preset.name, []]));
      const failures = [];
      const symbols = [];
      for (const symbol of candidates) {
        if (symbols.length >= targetCount) break;
        try {
          const candles = await fetchCandles(symbol, interval, days);
          if (candles.length < 500) {
            failures.push({ symbol, reason: `not enough candles (${candles.length})` });
            continue;
          }
          symbols.push(symbol);
          for (const preset of activePresets) {
            const row = await runCase(request, candles, preset);
            presetRows.get(preset.name).push(attachBenchmark({ symbol, interval, days, ...row }, candles, days));
          }
          console.log(`[${symbols.length}/${targetCount}] ${symbol} tamam`);
        } catch (err) {
          failures.push({ symbol, reason: err.message || String(err) });
        }
      }

      const summaries = activePresets
        .map((preset) => summarizeStrategyRows(preset.name, presetRows.get(preset.name) || [], preset.params))
        .map((summary) => ({
          ...summary,
          score: (
            (summary.medianDailyCompound || -999) * 4
            + (summary.avgDailyCompound || -999) * 2
            + (summary.profitablePct || 0) * 0.05
            + (summary.beatBenchmarkPct || 0) * 0.05
            + (summary.dailyCompoundAbove1Pct || 0) * 0.2
            - (summary.medianMaxDrawdown || 0) * 0.05
          ),
        }))
        .sort((a, b) => b.score - a.score);

      console.log(`Strategy candidate basket: ${symbols.length} sembol, ${activePresets.length} aday`);
      console.table(summaries.slice(0, 30).map(({ preset, profitablePct, beatBenchmarkPct, dailyCompoundAbove1Pct, avgReturn, medianReturn, avgDailyCompound, medianDailyCompound, medianMaxDrawdown, avgTrades, score }) => ({
        preset,
        profitablePct,
        beatBenchmarkPct,
        dailyCompoundAbove1Pct,
        avgReturn,
        medianReturn,
        avgDailyCompound,
        medianDailyCompound,
        medianMaxDrawdown,
        avgTrades,
        score,
      })));
      console.log(JSON.stringify({ interval, days, leverage: LEVERAGE, symbols, summaries, failures }, null, 2));
      return;
    }

    if (mode === 'internet-top10') {
      const interval = process.argv[3] || '1h';
      const days = Number(process.argv[4] || 90);
      const targetCount = Number(process.argv[5] || 50);
      const activePresets = buildInternetTop10Cases();

      const candidates = await fetchTopUsdtSymbols(Math.max(targetCount * 2, 90));
      const presetRows = new Map(activePresets.map((preset) => [preset.name, []]));
      const failures = [];
      const symbols = [];

      for (const symbol of candidates) {
        if (symbols.length >= targetCount) break;
        try {
          const candles = await fetchCandles(symbol, interval, days);
          if (candles.length < 500) {
            failures.push({ symbol, reason: `not enough candles (${candles.length})` });
            continue;
          }
          symbols.push(symbol);
          for (const preset of activePresets) {
            const row = await runCase(request, candles, preset);
            presetRows.get(preset.name).push(attachBenchmark({ symbol, interval, days, ...row }, candles, days));
          }
          console.log(`[${symbols.length}/${targetCount}] ${symbol} tamam`);
        } catch (err) {
          failures.push({ symbol, reason: err.message || String(err) });
        }
      }

      const summaries = activePresets
        .map((preset) => summarizeStrategyRows(preset.name, presetRows.get(preset.name) || [], preset.params))
        .map((summary) => ({
          ...summary,
          score: (
            (summary.medianDailyCompound || -999) * 5
            + (summary.avgDailyCompound || -999) * 2
            + (summary.profitablePct || 0) * 0.04
            + (summary.beatBenchmarkPct || 0) * 0.04
            - (summary.medianMaxDrawdown || 0) * 0.04
          ),
        }))
        .sort((a, b) => b.score - a.score);

      const allRows = activePresets
        .flatMap((preset) => (presetRows.get(preset.name) || []).map((row) => ({ ...row, preset: preset.name })))
        .sort((a, b) => b.ret - a.ret);

      console.log(`Internet top 10: ${symbols.length} sembol, ${activePresets.length} strateji, ${interval}, ${days} gun`);
      console.table(summaries.map(({ preset, profitablePct, beatBenchmarkPct, avgReturn, medianReturn, avgDailyCompound, medianDailyCompound, medianMaxDrawdown, avgTrades, score }) => ({
        preset,
        profitablePct,
        beatBenchmarkPct,
        avgReturn,
        medianReturn,
        avgDailyCompound,
        medianDailyCompound,
        medianMaxDrawdown,
        avgTrades,
        score,
      })));
      console.log('En iyi tekil kosular:');
      console.table(allRows.slice(0, 20).map(({ preset, symbol, ret, dailyCompound, benchmark, excess, win, pf, trades, dd }) => ({
        preset,
        symbol,
        ret,
        dailyCompound,
        benchmark,
        excess,
        win,
        pf,
        trades,
        dd,
      })));
      console.log(JSON.stringify({ interval, days, leverage: LEVERAGE, symbols, summaries, bestRows: allRows.slice(0, 50), failures }, null, 2));
      return;
    }

    if (mode === 'harmonic-trail-matrix') {
      const interval = process.argv[3] || '15m';
      const days = Number(process.argv[4] || 90);
      const targetCount = Number(process.argv[5] || 50);
      const candidates = await fetchTopUsdtSymbols(Math.max(targetCount * 2, 90));
      const symbols = candidates.slice(0, targetCount);
      const baseParams = {
        allow_repaint: true,
        allow_short: true,
        stop_loss_mode: 'strategy',
        stop_loss_target_ratio: 1,
        min_reward_risk: 0.5,
        recent_signal_bars: 3,
        breakeven_buffer_pct: 0.02,
        trail_atr_period: 14,
        trail_atr_mult: 1.1,
      };
      const variants = [
        ['TP1 trail -> TP2', {
          ...baseParams,
          exit_mode: 'target_trail',
          take_profit_mode: 'target_1',
          trail_trigger_mode: 'target_1',
          trail_take_profit_mode: 'target_2',
        }],
        ['TP2 trail only', {
          ...baseParams,
          exit_mode: 'target_trail',
          take_profit_mode: 'target_2',
          trail_trigger_mode: 'target_2',
          trail_take_profit_mode: 'none',
        }],
      ];
      const rows = [];
      const failures = [];
      const patternStats = new Map();
      console.log(`Harmonic trail matrix: ${interval}, ${days} gun, ${symbols.length} sembol, compound=${COMPOUND}, leverage=${LEVERAGE}`);
      for (const [variant, params] of variants) {
        let completed = 0;
        for (const symbol of symbols) {
          try {
            const candles = await fetchCandles(symbol, interval, days);
            if (candles.length < 300) {
              failures.push({ variant, symbol, reason: `az mum: ${candles.length}` });
              continue;
            }
            const row = await runCaseFull(request, candles, {
              name: `Harmonic ${variant}`,
              file: 'pine_harmonic_patterns.py',
              params,
            });
            const enriched = attachBenchmark({ variant, symbol, interval, days, ...row }, candles, days);
            delete enriched.rawTrades;
            delete enriched.observations;
            delete enriched.observationStats;
            rows.push(enriched);
            addTradePatternStats(patternStats, variant, symbol, row.rawTrades);
            completed += 1;
            if (completed % 10 === 0) {
              console.log(`${variant}: ${completed}/${symbols.length} tamamlandi`);
            }
          } catch (err) {
            failures.push({ variant, symbol, reason: err.message });
          }
        }
      }

      const byVariant = variants.map(([variant]) => {
        const group = rows.filter((row) => row.variant === variant);
        const winners = group.filter((row) => Number(row.ret) > 0);
        const targetHits = group.filter((row) => Number(row.dailyCompound) >= 0.8);
        return {
          variant,
          symbols: group.length,
          avgRet: average(group.map((row) => row.ret)),
          medRet: median(group.map((row) => row.ret)),
          avgDaily: average(group.map((row) => row.dailyCompound)),
          medDaily: median(group.map((row) => row.dailyCompound)),
          winners: pct(winners.length, group.length),
          targetHits: targetHits.length,
          totalTrades: group.reduce((sum, row) => sum + Number(row.trades || 0), 0),
          avgTrades: average(group.map((row) => row.trades)),
          avgDd: average(group.map((row) => row.dd)),
        };
      });

      rows.sort((a, b) => b.dailyCompound - a.dailyCompound);
      const patternSummary = finalizePatternStats(patternStats, 'pattern');
      const detailSummary = finalizePatternStats(patternStats, 'detail');

      console.log('Varyant ozeti:');
      console.table(byVariant.map((row) => ({
        variant: row.variant,
        symbols: row.symbols,
        avgRet: Number(row.avgRet?.toFixed(2)),
        medRet: Number(row.medRet?.toFixed(2)),
        avgDaily: Number(row.avgDaily?.toFixed(3)),
        medDaily: Number(row.medDaily?.toFixed(3)),
        winners: row.winners,
        targetHits: row.targetHits,
        totalTrades: row.totalTrades,
        avgTrades: Number(row.avgTrades?.toFixed(1)),
        avgDd: Number(row.avgDd?.toFixed(2)),
      })));
      console.log('En iyi 30 sembol/varyant:');
      console.table(rows.slice(0, 30).map((row) => ({
        variant: row.variant,
        symbol: row.symbol,
        ret: Number(row.ret?.toFixed(2)),
        daily: Number(row.dailyCompound?.toFixed(3)),
        win: Number(row.win?.toFixed(2)),
        pf: Number(row.pf?.toFixed(2)),
        trades: row.trades,
        dd: Number(row.dd?.toFixed(2)),
        benchmark: Number(row.benchmark?.toFixed(2)),
      })));
      console.log('Harmonik dogruluk orani - pattern bazinda:');
      console.table(patternSummary.map((row) => ({
        variant: row.variant,
        pattern: row.label,
        symbols: row.symbols,
        trades: row.trades,
        winRate: row.winRate,
        pf: row.pf,
        avgTradePct: row.avgTradePct,
        netPnl: row.netPnl,
        tp: row.tp,
        sl: row.sl,
        end: row.end,
      })));
      console.log('Harmonik dogruluk orani - yon/uzunluk detayi (ilk 40):');
      console.table(detailSummary.slice(0, 40).map((row) => ({
        variant: row.variant,
        harmonic: row.label,
        symbols: row.symbols,
        trades: row.trades,
        winRate: row.winRate,
        pf: row.pf,
        avgTradePct: row.avgTradePct,
        netPnl: row.netPnl,
      })));
      console.log(JSON.stringify({ interval, days, targetCount: symbols.length, leverage: LEVERAGE, compound: COMPOUND, summary: byVariant, top: rows.slice(0, 50), patternSummary, detailSummary, failures }, null, 2));
      return;
    }

    if (mode === 'harmonic-grid') {
      const candles = await fetchCandles('BTCUSDT', '15m', 90);
      const rows = [];
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const good6 = harmonicGood6;
      const good4 = harmonicGood6.slice(0, 4);
      const sets = [
        ['good4', { trade_filters: good4 }],
        ['good6', { trade_filters: good6 }],
        ['5-0 L20 long', { trade_filters: [f('5-0', 20, 'bullish')] }],
        ['White Swan L15 short', { trade_filters: [f('White Swan', 15, 'bearish')] }],
        ['5-0 L5 short', { trade_filters: [f('5-0', 5, 'bearish')] }],
        ['ABCD L5 short', { trade_filters: [f('ABCD', 5, 'bearish')] }],
        ['only 5-0', { enabled_patterns: ['5-0'] }],
      ];
      const exits = [
        ['single-t1', { exit_mode: 'single', take_profit_mode: 'target_1' }],
        ['single-t2', { exit_mode: 'single', take_profit_mode: 'target_2' }],
        ['tp2-trail', { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.1 }],
      ];
      const ratios = [0.75, 1];
      const minRewardRisks = [0.5, 0.75];
      const recentBars = [3];
      for (const [setName, setParams] of sets) {
        for (const [exitName, exitParams] of exits) {
          for (const stop_loss_target_ratio of ratios) {
            for (const min_reward_risk of minRewardRisks) {
              for (const recent_signal_bars of recentBars) {
                const params = {
                  allow_repaint: true,
                  allow_short: true,
                  stop_loss_mode: 'strategy',
                  stop_loss_target_ratio,
                  min_reward_risk,
                  recent_signal_bars,
                  ...exitParams,
                  ...setParams,
                };
                const row = await runCase(request, candles, {
                  name: `${setName} ${exitName} r${stop_loss_target_ratio} minRR${min_reward_risk} recent${recent_signal_bars}`,
                  file: 'pine_harmonic_patterns.py',
                  params,
                });
                rows.push(attachBenchmark({ ...row, params }, candles, 90));
              }
            }
          }
        }
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.slice(0, 30).map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-singles') {
      const symbol = process.argv[3] || 'BTCUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const rows = [];
      const patternNames = [
        'Gartley', 'Yengec', 'Derin Yengec', 'Yarasa', 'Alt Yarasa', 'Kelebek',
        'Shark', 'Cypher', 'Nenstar', 'Black Swan', 'White Swan', '3 Basamak',
        '5-0', 'ABCD', 'AB=CD', 'ABCD Uzanti',
      ];
      for (const pattern of patternNames) {
        for (const zigzag_length of [5, 10, 15, 20, 25]) {
          for (const direction of ['bullish', 'bearish']) {
            const params = {
              allow_repaint: true,
              allow_short: true,
              take_profit_mode: 'target_1',
              stop_loss_mode: 'strategy',
              stop_loss_target_ratio: 1,
              min_reward_risk: 0.75,
              recent_signal_bars: 3,
              trade_filters: [{ pattern, zigzag_length, direction }],
            };
            const row = await runCase(request, candles, {
              name: `${pattern} L${zigzag_length} ${direction}`,
              file: 'pine_harmonic_patterns.py',
              params,
            });
            if ((row.trades || 0) > 0) {
              rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
            }
          }
        }
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.slice(0, 30).map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-combos') {
      const symbol = process.argv[3] || 'BTCUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const comboSets = [
        ['BTC best one', [f('5-0', 25, 'bullish')]],
        ['BTC top3', [f('5-0', 25, 'bullish'), f('5-0', 20, 'bullish'), f('Shark', 20, 'bearish')]],
        ['BTC top5', [f('5-0', 25, 'bullish'), f('5-0', 20, 'bullish'), f('Shark', 20, 'bearish'), f('5-0', 5, 'bearish'), f('White Swan', 20, 'bearish')]],
        ['BTC 5-0 bullish', [f('5-0', 15, 'bullish'), f('5-0', 20, 'bullish'), f('5-0', 25, 'bullish')]],
        ['ETH 5-0 core', [f('5-0', 5, 'bullish'), f('5-0', 10, 'bullish'), f('5-0', 15, 'bullish'), f('5-0', 20, 'bullish'), f('5-0', 25, 'bullish'), f('5-0', 25, 'bearish')]],
        ['ETH top5', [f('5-0', 25, 'bullish'), f('Yengec', 20, 'bearish'), f('5-0', 20, 'bullish'), f('AB=CD', 10, 'bearish'), f('ABCD Uzanti', 15, 'bullish')]],
        ['ETH top8', [f('5-0', 25, 'bullish'), f('Yengec', 20, 'bearish'), f('5-0', 20, 'bullish'), f('AB=CD', 10, 'bearish'), f('ABCD Uzanti', 15, 'bullish'), f('5-0', 25, 'bearish'), f('5-0', 15, 'bullish'), f('White Swan', 25, 'bearish')]],
      ];
      const exits = [
        ['single-t1', { exit_mode: 'single', take_profit_mode: 'target_1' }],
        ['single-t2', { exit_mode: 'single', take_profit_mode: 'target_2' }],
        ['tp2-trail', { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.1 }],
      ];
      const rows = [];
      for (const [setName, trade_filters] of comboSets) {
        for (const [exitName, exitParams] of exits) {
          for (const stop_loss_target_ratio of [0.75, 1]) {
            const params = {
              allow_repaint: true,
              allow_short: true,
              stop_loss_mode: 'strategy',
              stop_loss_target_ratio,
              min_reward_risk: 0.75,
              recent_signal_bars: 3,
              ...exitParams,
              trade_filters,
            };
            const row = await runCase(request, candles, {
              name: `${setName} ${exitName} r${stop_loss_target_ratio}`,
              file: 'pine_harmonic_patterns.py',
              params,
            });
            rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
          }
        }
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.slice(0, 30).map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-tune-top8') {
      const symbol = process.argv[3] || 'ETHUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const trade_filters = [
        f('5-0', 25, 'bullish'),
        f('Yengec', 20, 'bearish'),
        f('5-0', 20, 'bullish'),
        f('AB=CD', 10, 'bearish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('5-0', 25, 'bearish'),
        f('5-0', 15, 'bullish'),
        f('White Swan', 25, 'bearish'),
      ];
      const rows = [];
      for (const stop_loss_target_ratio of [0.75, 1, 1.25]) {
        for (const min_reward_risk of [0.5, 0.75, 1]) {
          for (const breakeven_buffer_pct of [0, 0.02, 0.05]) {
            for (const trail_atr_mult of [0.8, 1.1, 1.5]) {
              for (const recent_signal_bars of [3, 8]) {
                const params = {
                  allow_repaint: true,
                  allow_short: true,
                  exit_mode: 'tp2_trail',
                  take_profit_mode: 'target_1',
                  stop_loss_mode: 'strategy',
                  stop_loss_target_ratio,
                  min_reward_risk,
                  recent_signal_bars,
                  breakeven_buffer_pct,
                  trail_atr_period: 14,
                  trail_atr_mult,
                  trade_filters,
                };
                const row = await runCase(request, candles, {
                  name: `top8 trail r${stop_loss_target_ratio} rr${min_reward_risk} be${breakeven_buffer_pct} atr${trail_atr_mult} recent${recent_signal_bars}`,
                  file: 'pine_harmonic_patterns.py',
                  params,
                });
                rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
              }
            }
          }
        }
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.slice(0, 30).map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-best') {
      const symbol = process.argv[3] || 'ETHUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const top8 = [
        f('5-0', 25, 'bullish'),
        f('Yengec', 20, 'bearish'),
        f('5-0', 20, 'bullish'),
        f('AB=CD', 10, 'bearish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('5-0', 25, 'bearish'),
        f('5-0', 15, 'bullish'),
        f('White Swan', 25, 'bearish'),
      ];
      const btcTop5 = [
        f('5-0', 25, 'bullish'),
        f('5-0', 20, 'bullish'),
        f('Shark', 20, 'bearish'),
        f('5-0', 5, 'bearish'),
        f('White Swan', 20, 'bearish'),
      ];
      const rows = [];
      const bestCases = [
        ['ETH top8 tuned trail', top8, { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_target_ratio: 1, min_reward_risk: 0.5, breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.5 }],
        ['ETH top8 single lower SL', top8, { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.75, min_reward_risk: 0.75 }],
        ['BTC top5 single', btcTop5, { exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 1, min_reward_risk: 0.75 }],
        ['BTC best trail', [f('5-0', 25, 'bullish')], { exit_mode: 'tp2_trail', take_profit_mode: 'target_1', stop_loss_target_ratio: 1, min_reward_risk: 0.75, breakeven_buffer_pct: 0.02, trail_atr_period: 14, trail_atr_mult: 1.1 }],
      ];
      for (const [name, trade_filters, extra] of bestCases) {
        const params = {
          allow_repaint: true,
          allow_short: true,
          stop_loss_mode: 'strategy',
          recent_signal_bars: 3,
          ...extra,
          trade_filters,
        };
        const row = await runCase(request, candles, {
          name,
          file: 'pine_harmonic_patterns.py',
          params,
        });
        rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-filter-grid') {
      const symbol = process.argv[3] || 'ETHUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const trade_filters = [
        f('5-0', 25, 'bullish'),
        f('Yengec', 20, 'bearish'),
        f('5-0', 20, 'bullish'),
        f('AB=CD', 10, 'bearish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('5-0', 25, 'bearish'),
        f('5-0', 15, 'bullish'),
        f('White Swan', 25, 'bearish'),
      ];
      const trendOptions = [
        ['off', null],
        ['with_trend', 50],
        ['with_trend', 100],
        ['with_trend', 200],
        ['reversal', 50],
        ['reversal', 100],
        ['reversal', 200],
      ];
      const rsiOptions = [
        ['off', false, 45, 55],
        ['rsi45_55', true, 45, 55],
        ['rsi50_50', true, 50, 50],
        ['rsi55_45', true, 55, 45],
      ];
      const rows = [];
      for (const [trend_filter, trend_ema_period] of trendOptions) {
        for (const [rsiName, rsi_filter, rsi_long_max, rsi_short_min] of rsiOptions) {
          const params = {
            allow_repaint: true,
            allow_short: true,
            exit_mode: 'tp2_trail',
            take_profit_mode: 'target_1',
            stop_loss_mode: 'strategy',
            stop_loss_target_ratio: 1,
            min_reward_risk: 0.5,
            recent_signal_bars: 3,
            breakeven_buffer_pct: 0.02,
            trail_atr_period: 14,
            trail_atr_mult: 1.5,
            trend_filter,
            rsi_filter,
            rsi_long_max,
            rsi_short_min,
            trade_filters,
          };
          if (trend_ema_period) params.trend_ema_period = trend_ema_period;
          const row = await runCase(request, candles, {
            name: `top8 ${trend_filter}${trend_ema_period || ''} ${rsiName}`,
            file: 'pine_harmonic_patterns.py',
            params,
          });
          rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
        }
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-smc-grid') {
      const symbol = process.argv[3] || 'ETHUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const trade_filters = [
        f('5-0', 25, 'bullish'),
        f('Yengec', 20, 'bearish'),
        f('5-0', 20, 'bullish'),
        f('AB=CD', 10, 'bearish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('5-0', 25, 'bearish'),
        f('5-0', 15, 'bullish'),
        f('White Swan', 25, 'bearish'),
      ];
      const baseParams = {
        allow_repaint: true,
        allow_short: true,
        exit_mode: 'tp2_trail',
        take_profit_mode: 'target_1',
        stop_loss_mode: 'strategy',
        stop_loss_target_ratio: 1,
        min_reward_risk: 0.5,
        recent_signal_bars: 3,
        breakeven_buffer_pct: 0.02,
        trail_atr_period: 14,
        trail_atr_mult: 1.5,
        trade_filters,
      };
      const rows = [];
      const baseline = await runCase(request, candles, {
        name: 'harmonic top8 baseline',
        file: 'pine_harmonic_patterns.py',
        params: { ...baseParams },
      });
      rows.push(attachBenchmark({ symbol, interval, days, ...baseline, params: { ...baseParams } }, candles, days));

      const scopes = ['swing', 'internal', 'both'];
      const tags = ['CHoCH', 'BOS', 'ALL'];
      const lookbacks = [6, 12, 24, 48];
      for (const smc_scope of scopes) {
        for (const smc_tag of tags) {
          for (const smc_lookback_bars of lookbacks) {
            const params = {
              ...baseParams,
              smc_filter: 'same_direction',
              smc_scope,
              smc_tag,
              smc_lookback_bars,
            };
            const row = await runCase(request, candles, {
              name: `harmonic+SMC ${smc_scope} ${smc_tag} lb${smc_lookback_bars}`,
              file: 'pine_harmonic_patterns.py',
              params,
            });
            rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
          }
        }
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.slice(0, 25).map(({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailySimple, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-learning-grid') {
      const symbol = process.argv[3] || 'ETHUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const top8 = [
        f('5-0', 25, 'bullish'),
        f('Yengec', 20, 'bearish'),
        f('5-0', 20, 'bullish'),
        f('AB=CD', 10, 'bearish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('5-0', 25, 'bearish'),
        f('5-0', 15, 'bullish'),
        f('White Swan', 25, 'bearish'),
      ];
      const btcTop5 = [
        f('AB=CD', 10, 'bearish'),
        f('Yengec', 5, 'bearish'),
        f('5-0', 25, 'bullish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('Kelebek', 5, 'bearish'),
      ];
      const sets = [
        ['all patterns', null, null],
        ['ETH top8', top8, null],
        ['BTC top5', btcTop5, null],
        ['only 5-0', null, ['5-0']],
      ];
      const rows = [];
      for (const [setName, trade_filters, enabled_patterns] of sets) {
        for (const learning_group of ['pattern_direction', 'pattern_length_direction']) {
          for (const learning_min_samples of [2, 3, 4]) {
            for (const learning_min_win_rate of [50, 55, 60]) {
              const params = {
                allow_repaint: true,
                allow_short: true,
                exit_mode: 'tp2_trail',
                take_profit_mode: 'target_1',
                stop_loss_mode: 'strategy',
                stop_loss_target_ratio: 1,
                min_reward_risk: 0.5,
                recent_signal_bars: 3,
                breakeven_buffer_pct: 0.02,
                trail_atr_period: 14,
                trail_atr_mult: 1.5,
                learning_filter: true,
                learning_group,
                learning_min_samples,
                learning_min_win_rate,
                learning_min_expectancy_r: 0,
                learning_horizon_bars: 96,
              };
              if (trade_filters) params.trade_filters = trade_filters;
              if (enabled_patterns) params.enabled_patterns = enabled_patterns;
              const row = await runCase(request, candles, {
                name: `${setName} learn ${learning_group} n${learning_min_samples} wr${learning_min_win_rate}`,
                file: 'pine_harmonic_patterns.py',
                params,
              });
              rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
            }
          }
        }
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.map(({ name, ret, dailyCompound, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailyCompound, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-learning-best') {
      const symbol = process.argv[3] || 'ETHUSDT';
      const interval = process.argv[4] || '15m';
      const days = Number(process.argv[5] || 90);
      const candles = await fetchCandles(symbol, interval, days);
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const top8 = [
        f('5-0', 25, 'bullish'),
        f('Yengec', 20, 'bearish'),
        f('5-0', 20, 'bullish'),
        f('AB=CD', 10, 'bearish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('5-0', 25, 'bearish'),
        f('5-0', 15, 'bullish'),
        f('White Swan', 25, 'bearish'),
      ];
      const btcTop5 = [
        f('AB=CD', 10, 'bearish'),
        f('Yengec', 5, 'bearish'),
        f('5-0', 25, 'bullish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('Kelebek', 5, 'bearish'),
      ];
      const base = {
        allow_repaint: true,
        allow_short: true,
        exit_mode: 'tp2_trail',
        take_profit_mode: 'target_1',
        stop_loss_mode: 'strategy',
        stop_loss_target_ratio: 1,
        min_reward_risk: 0.5,
        recent_signal_bars: 3,
        breakeven_buffer_pct: 0.02,
        trail_atr_period: 14,
        trail_atr_mult: 1.5,
      };
      const learning = {
        learning_filter: true,
        learning_group: 'pattern_direction',
        learning_min_samples: 2,
        learning_min_win_rate: 50,
        learning_min_expectancy_r: 0,
        learning_horizon_bars: 96,
      };
      const bestCases = [
        ['top8 learning pdir n2 wr50', { ...base, ...learning, trade_filters: top8 }],
        ['top8 baseline trail', { ...base, trade_filters: top8 }],
        ['top8 single lower SL', { ...base, exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 0.75, min_reward_risk: 0.75, trade_filters: top8 }],
        ['btcTop5 learning pdir n2 wr50', { ...base, ...learning, trade_filters: btcTop5 }],
        ['btcTop5 single', { ...base, exit_mode: 'single', take_profit_mode: 'target_1', stop_loss_target_ratio: 1, min_reward_risk: 0.75, trade_filters: btcTop5 }],
      ];
      const rows = [];
      for (const [name, params] of bestCases) {
        const row = await runCase(request, candles, { name, file: 'pine_harmonic_patterns.py', params });
        rows.push(attachBenchmark({ symbol, interval, days, ...row, params }, candles, days));
      }
      rows.sort((a, b) => b.ret - a.ret);
      console.table(rows.map(({ name, ret, dailyCompound, benchmark, excess, win, pf, trades, dd }) => ({ name, ret, dailyCompound, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ rows }, null, 2));
      return;
    }

    if (mode === 'harmonic-learning-basket') {
      const interval = process.argv[3] || '15m';
      const days = Number(process.argv[4] || 90);
      const targetCount = Number(process.argv[5] || 50);
      const candidates = await fetchTopUsdtSymbols(Math.max(targetCount * 2, 90));
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const top8 = [
        f('5-0', 25, 'bullish'),
        f('Yengec', 20, 'bearish'),
        f('5-0', 20, 'bullish'),
        f('AB=CD', 10, 'bearish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('5-0', 25, 'bearish'),
        f('5-0', 15, 'bullish'),
        f('White Swan', 25, 'bearish'),
      ];
      const params = {
        allow_repaint: true,
        allow_short: true,
        exit_mode: 'tp2_trail',
        take_profit_mode: 'target_1',
        stop_loss_mode: 'strategy',
        stop_loss_target_ratio: 1,
        min_reward_risk: 0.5,
        recent_signal_bars: 3,
        breakeven_buffer_pct: 0.02,
        trail_atr_period: 14,
        trail_atr_mult: 1.5,
        learning_filter: true,
        learning_group: 'pattern_direction',
        learning_min_samples: 2,
        learning_min_win_rate: 50,
        learning_min_expectancy_r: 0,
        learning_horizon_bars: 96,
        trade_filters: top8,
      };
      const rows = [];
      const failures = [];
      for (const symbol of candidates) {
        if (rows.length >= targetCount) break;
        try {
          const candles = await fetchCandles(symbol, interval, days);
          if (candles.length < 500) {
            failures.push({ symbol, reason: `not enough candles (${candles.length})` });
            continue;
          }
          const row = await runCase(request, candles, {
            name: 'top8 learning pdir n2 wr50',
            file: 'pine_harmonic_patterns.py',
            params,
          });
          const enriched = attachBenchmark({ symbol, interval, days, candles: candles.length, ...row }, candles, days);
          rows.push(enriched);
          console.log(`[${rows.length}/${targetCount}] ${symbol} ret=${enriched.ret}% daily=${enriched.dailyCompound?.toFixed?.(3)}% dd=${enriched.dd}% trades=${enriched.trades}`);
        } catch (err) {
          failures.push({ symbol, reason: err.message || String(err) });
        }
      }

      rows.sort((a, b) => b.ret - a.ret);
      const total = rows.length;
      const summary = {
        tested: total,
        failed: failures.length,
        profitable: rows.filter((row) => row.ret > 0).length,
        profitablePct: pct(rows.filter((row) => row.ret > 0).length, total),
        beatBenchmark: rows.filter((row) => row.excess > 0).length,
        beatBenchmarkPct: pct(rows.filter((row) => row.excess > 0).length, total),
        dailyCompoundAbove1: rows.filter((row) => row.dailyCompound >= 1).length,
        dailyCompoundAbove1Pct: pct(rows.filter((row) => row.dailyCompound >= 1).length, total),
        avgReturn: average(rows.map((row) => row.ret)),
        medianReturn: median(rows.map((row) => row.ret)),
        avgDailyCompound: average(rows.map((row) => row.dailyCompound)),
        medianDailyCompound: median(rows.map((row) => row.dailyCompound)),
        avgMaxDrawdown: average(rows.map((row) => row.dd)),
        medianMaxDrawdown: median(rows.map((row) => row.dd)),
      };
      console.log('Basket summary:', summary);
      console.table(rows.map(({ symbol, ret, dailyCompound, benchmark, excess, win, pf, trades, dd }) => ({ symbol, ret, dailyCompound, benchmark, excess, win, pf, trades, dd })));
      console.log(JSON.stringify({ interval, days, leverage: LEVERAGE, params, summary, rows, failures }, null, 2));
      return;
    }

    if (mode === 'harmonic-regime-basket') {
      const interval = process.argv[3] || '15m';
      const days = Number(process.argv[4] || 90);
      const targetCount = Number(process.argv[5] || 20);
      const candidates = await fetchTopUsdtSymbols(Math.max(targetCount * 2, 90));
      const f = (pattern, zigzag_length, direction) => ({ pattern, zigzag_length, direction });
      const top8 = [
        f('5-0', 25, 'bullish'),
        f('Yengec', 20, 'bearish'),
        f('5-0', 20, 'bullish'),
        f('AB=CD', 10, 'bearish'),
        f('ABCD Uzanti', 15, 'bullish'),
        f('5-0', 25, 'bearish'),
        f('5-0', 15, 'bullish'),
        f('White Swan', 25, 'bearish'),
      ];
      const base = {
        allow_repaint: true,
        allow_short: true,
        exit_mode: 'tp2_trail',
        take_profit_mode: 'target_1',
        stop_loss_mode: 'strategy',
        stop_loss_target_ratio: 1,
        min_reward_risk: 0.5,
        recent_signal_bars: 3,
        breakeven_buffer_pct: 0.02,
        trail_atr_period: 14,
        trail_atr_mult: 1.5,
        learning_filter: true,
        learning_group: 'pattern_direction',
        learning_min_samples: 2,
        learning_min_win_rate: 50,
        learning_min_expectancy_r: 0,
        learning_horizon_bars: 96,
        trade_filters: top8,
      };
      const presetFilterArg = process.argv[6] || '';
      const presetNames = new Set(presetFilterArg.split(',').map((item) => item.trim()).filter(Boolean));
      const presets = [
        ['base', {}],
        ['adx18', { adx_filter: true, min_adx: 18 }],
        ['adx25', { adx_filter: true, min_adx: 25 }],
        ['atr020', { atr_pct_filter: true, min_atr_pct: 0.2 }],
        ['atr040', { atr_pct_filter: true, min_atr_pct: 0.4 }],
        ['vol120', { volume_filter: true, min_volume_ratio: 1.2 }],
        ['vol150', { volume_filter: true, min_volume_ratio: 1.5 }],
        ['adx18_vol120', { adx_filter: true, min_adx: 18, volume_filter: true, min_volume_ratio: 1.2 }],
        ['adx18_atr020', { adx_filter: true, min_adx: 18, atr_pct_filter: true, min_atr_pct: 0.2 }],
        ['adx18_atr020_vol120', { adx_filter: true, min_adx: 18, atr_pct_filter: true, min_atr_pct: 0.2, volume_filter: true, min_volume_ratio: 1.2 }],
        ['trend100', { trend_filter: 'with_trend', trend_ema_period: 100 }],
        ['trend100_adx18', { trend_filter: 'with_trend', trend_ema_period: 100, adx_filter: true, min_adx: 18 }],
        ['slope100', { ema_slope_filter: true, ema_slope_period: 100, min_ema_slope_pct: 0.03 }],
        ['slope_reversal100', { ema_slope_filter: true, ema_slope_mode: 'reversal', ema_slope_period: 100, min_ema_slope_pct: 0.03 }],
        ['reversal100', { trend_filter: 'reversal', trend_ema_period: 100 }],
        ['reversal100_adx18', { trend_filter: 'reversal', trend_ema_period: 100, adx_filter: true, min_adx: 18 }],
        ['rsi45_55', { rsi_filter: true, rsi_long_max: 45, rsi_short_min: 55 }],
        ['reversal100_rsi45_55', { trend_filter: 'reversal', trend_ema_period: 100, rsi_filter: true, rsi_long_max: 45, rsi_short_min: 55 }],
        ['long_only', { allow_short: false }],
        ['long_slope100', { allow_short: false, ema_slope_filter: true, ema_slope_period: 100, min_ema_slope_pct: 0.03 }],
        ['long_adx18_atr020', { allow_short: false, adx_filter: true, min_adx: 18, atr_pct_filter: true, min_atr_pct: 0.2 }],
        ['htf4h_reversal', { htf_regime_filter: 'reversal', htf_timeframe: '4h', htf_allow_unknown: false }],
        ['htf4h_prefer_reversal', { htf_regime_filter: 'prefer_reversal', htf_timeframe: '4h', htf_allow_unknown: false }],
        ['htf4h_reversal_adx18', { htf_regime_filter: 'reversal', htf_timeframe: '4h', htf_allow_unknown: false, adx_filter: true, min_adx: 18 }],
        ['htf4h_with_trend', { htf_regime_filter: 'with_trend', htf_timeframe: '4h', htf_allow_unknown: false }],
        ['htf4h_prefer_trend', { htf_regime_filter: 'prefer_with_trend', htf_timeframe: '4h', htf_allow_unknown: false }],
        ['htf4h_bear_long', { allow_short: false, htf_regime_filter: 'custom', htf_timeframe: '4h', htf_long_regime: 'bear', htf_allow_unknown: false }],
        ['htf4h_bear_mixed_long', { allow_short: false, htf_regime_filter: 'custom', htf_timeframe: '4h', htf_long_regime: 'bear_or_mixed', htf_allow_unknown: false }],
        ['htf1d_reversal', { htf_regime_filter: 'reversal', htf_timeframe: '1d', htf_allow_unknown: false }],
        ['htf1d_bear_long', { allow_short: false, htf_regime_filter: 'custom', htf_timeframe: '1d', htf_long_regime: 'bear', htf_allow_unknown: false }],
      ];
      const activePresets = presetNames.size ? presets.filter(([name]) => presetNames.has(name)) : presets;
      const presetRows = new Map(activePresets.map(([name]) => [name, []]));
      const failures = [];
      const symbols = [];
      for (const symbol of candidates) {
        if (symbols.length >= targetCount) break;
        try {
          const candles = await fetchCandles(symbol, interval, days);
          if (candles.length < 500) {
            failures.push({ symbol, reason: `not enough candles (${candles.length})` });
            continue;
          }
          symbols.push(symbol);
          for (const [presetName, presetParams] of activePresets) {
            const params = { ...base, ...presetParams };
            const row = await runCase(request, candles, {
              name: presetName,
              file: 'pine_harmonic_patterns.py',
              params,
            });
            presetRows.get(presetName).push(attachBenchmark({ symbol, interval, days, ...row }, candles, days));
          }
          console.log(`[${symbols.length}/${targetCount}] ${symbol} tamam`);
        } catch (err) {
          failures.push({ symbol, reason: err.message || String(err) });
        }
      }
      const summaries = activePresets.map(([presetName, presetParams]) => {
        const rows = presetRows.get(presetName) || [];
        const total = rows.length;
        return {
          preset: presetName,
          tested: total,
          profitable: rows.filter((row) => row.ret > 0).length,
          profitablePct: pct(rows.filter((row) => row.ret > 0).length, total),
          beatBenchmark: rows.filter((row) => row.excess > 0).length,
          beatBenchmarkPct: pct(rows.filter((row) => row.excess > 0).length, total),
          dailyCompoundAbove1: rows.filter((row) => row.dailyCompound >= 1).length,
          dailyCompoundAbove1Pct: pct(rows.filter((row) => row.dailyCompound >= 1).length, total),
          avgReturn: average(rows.map((row) => row.ret)),
          medianReturn: median(rows.map((row) => row.ret)),
          avgDailyCompound: average(rows.map((row) => row.dailyCompound)),
          medianDailyCompound: median(rows.map((row) => row.dailyCompound)),
          avgMaxDrawdown: average(rows.map((row) => row.dd)),
          medianMaxDrawdown: median(rows.map((row) => row.dd)),
          avgTrades: average(rows.map((row) => row.trades)),
          params: presetParams,
        };
      }).sort((a, b) => (b.medianDailyCompound || -999) - (a.medianDailyCompound || -999));
      console.table(summaries.map(({ preset, profitablePct, beatBenchmarkPct, dailyCompoundAbove1Pct, avgReturn, medianReturn, avgDailyCompound, medianDailyCompound, medianMaxDrawdown, avgTrades }) => ({
        preset,
        profitablePct,
        beatBenchmarkPct,
        dailyCompoundAbove1Pct,
        avgReturn,
        medianReturn,
        avgDailyCompound,
        medianDailyCompound,
        medianMaxDrawdown,
        avgTrades,
      })));
      console.log(JSON.stringify({ interval, days, leverage: LEVERAGE, symbols, summaries, failures }, null, 2));
      return;
    }

    if (mode === 'harmonic-symbol-optimizer-basket') {
      const interval = process.argv[3] || '15m';
      const days = Number(process.argv[4] || 90);
      const targetCount = Number(process.argv[5] || 50);
      const trainDays = Number(process.argv[6] || 60);
      const topN = Number(process.argv[7] || 1);
      const minSamples = Number(process.argv[8] || 4);
      const minWinRate = Number(process.argv[9] || 60);
      const candidateN = Number(process.argv[10] || 12);
      const validationDays = Math.max(1, days - trainDays);
      const candidates = await fetchTopUsdtSymbols(Math.max(targetCount * 2, 90));
      const baseParams = {
        allow_repaint: true,
        allow_short: true,
        exit_mode: 'tp2_trail',
        take_profit_mode: 'target_1',
        stop_loss_mode: 'strategy',
        stop_loss_target_ratio: 1,
        min_reward_risk: 0.5,
        recent_signal_bars: 3,
        breakeven_buffer_pct: 0.02,
        trail_atr_period: 14,
        trail_atr_mult: 1.5,
        learning_horizon_bars: 96,
      };
      const rows = [];
      const failures = [];
      for (const symbol of candidates) {
        if (rows.length >= targetCount) break;
        try {
          const candles = await fetchCandles(symbol, interval, days);
          if (candles.length < 500) {
            failures.push({ symbol, reason: `not enough candles (${candles.length})` });
            continue;
          }
          const cutoff = candles.at(-1).t - validationDays * DAY;
          const trainCandles = candles.filter((candle) => candle.t < cutoff);
          const validationCandles = candles.filter((candle) => candle.t >= cutoff);
          if (trainCandles.length < 500 || validationCandles.length < 100) {
            failures.push({ symbol, reason: `not enough split candles train=${trainCandles.length} validation=${validationCandles.length}` });
            continue;
          }
          const optimized = await request('optimize_harmonic', {
            strategy_file: 'pine_harmonic_patterns.py',
            candles: trainCandles,
            params: baseParams,
            top_n: candidateN,
            min_samples: minSamples,
            min_win_rate: minWinRate,
            min_expectancy_r: 0,
          }, 420_000);
          const candidatesFromStats = optimized.selected || [];
          const trainRows = [];
          for (const candidate of candidatesFromStats) {
            const trainRow = await runCase(request, trainCandles, {
              name: `${candidate.pattern} L${candidate.zigzag_length} ${candidate.direction}`,
              file: 'pine_harmonic_patterns.py',
              params: { ...baseParams, trade_filters: [candidate] },
            });
            if ((trainRow.trades || 0) > 0) {
              const enrichedTrain = attachBenchmark({ ...trainRow, candidate }, trainCandles, trainDays);
              enrichedTrain.score = (
                (enrichedTrain.ret || 0)
                + Math.max(0, enrichedTrain.excess || 0) * 0.5
                + Math.max(0, enrichedTrain.win || 0) * 0.05
                - Math.max(0, enrichedTrain.dd || 0) * 0.25
              );
              trainRows.push(enrichedTrain);
            }
          }
          trainRows.sort((a, b) => b.score - a.score);
          const selected = trainRows
            .filter((row) => (row.trades || 0) >= 2 && (row.ret || 0) > 0 && (row.pf == null || row.pf >= 1.1))
            .slice(0, topN)
            .map((row) => row.candidate);
          if (!selected.length) {
            rows.push({
              symbol,
              interval,
              days: validationDays,
              trainDays,
              ret: 0,
              dailySimple: 0,
              dailyCompound: 0,
              benchmark: benchmarkReturn(validationCandles),
              excess: -benchmarkReturn(validationCandles),
              win: 0,
              pf: null,
              trades: 0,
              dd: 0,
              selected,
              trainRows: trainRows.slice(0, 5),
              observedPatterns: optimized.observed_patterns || 0,
            });
            console.log(`[${rows.length}/${targetCount}] ${symbol} selected=0 ret=0% daily=0.000%`);
            continue;
          }
          const params = { ...baseParams, trade_filters: selected };
          const row = await runCase(request, candles, {
            name: 'symbol-optimized top6',
            file: 'pine_harmonic_patterns.py',
            params,
            start_time: cutoff,
          });
          const enriched = attachBenchmark({
            symbol,
            interval,
            days: validationDays,
            trainDays,
            candles: validationCandles.length,
            ...row,
            selected,
            trainRows: trainRows.slice(0, 5),
            observedPatterns: optimized.observed_patterns || 0,
          }, validationCandles, validationDays);
          rows.push(enriched);
          console.log(`[${rows.length}/${targetCount}] ${symbol} filters=${selected.length} ret=${enriched.ret}% daily=${enriched.dailyCompound?.toFixed?.(3)}% dd=${enriched.dd}% trades=${enriched.trades}`);
        } catch (err) {
          failures.push({ symbol, reason: err.message || String(err) });
        }
      }

      rows.sort((a, b) => b.ret - a.ret);
      const total = rows.length;
      const summary = {
        tested: total,
        failed: failures.length,
        trainDays,
        validationDays,
        topN,
        minSamples,
        minWinRate,
        candidateN,
        profitable: rows.filter((row) => row.ret > 0).length,
        profitablePct: pct(rows.filter((row) => row.ret > 0).length, total),
        beatBenchmark: rows.filter((row) => row.excess > 0).length,
        beatBenchmarkPct: pct(rows.filter((row) => row.excess > 0).length, total),
        dailyCompoundAbove1: rows.filter((row) => row.dailyCompound >= 1).length,
        dailyCompoundAbove1Pct: pct(rows.filter((row) => row.dailyCompound >= 1).length, total),
        avgReturn: average(rows.map((row) => row.ret)),
        medianReturn: median(rows.map((row) => row.ret)),
        avgDailyCompound: average(rows.map((row) => row.dailyCompound)),
        medianDailyCompound: median(rows.map((row) => row.dailyCompound)),
        avgMaxDrawdown: average(rows.map((row) => row.dd)),
        medianMaxDrawdown: median(rows.map((row) => row.dd)),
      };
      console.log('Symbol optimizer summary:', summary);
      console.table(rows.map(({ symbol, ret, dailyCompound, benchmark, excess, win, pf, trades, dd, selected }) => ({ symbol, ret, dailyCompound, benchmark, excess, win, pf, trades, dd, filters: selected?.length || 0 })));
      console.log(JSON.stringify({ interval, days, leverage: LEVERAGE, baseParams, summary, rows, failures }, null, 2));
      return;
    }

    const candles = await fetchCandles('BTCUSDT', '15m', 90);
    const rows = [];
    for (const item of cases) {
      rows.push(await runCase(request, candles, item));
    }
    rows.sort((a, b) => b.ret - a.ret);
    console.table(rows.map(({ name, ret, win, pf, trades, dd }) => ({ name, ret, win, pf, trades, dd })));
    console.log(JSON.stringify({
      dataset: {
        symbol: 'BTCUSDT',
        interval: '15m',
        days: 90,
        candles: candles.length,
        first: new Date(candles[0].t).toISOString(),
        last: new Date(candles.at(-1).t).toISOString(),
      },
      rows,
    }, null, 2));
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
