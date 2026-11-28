'use strict';

// Cok sembollu paper portfoy (F1-7): tum kurallar Python portfoy cekirdeginde
// (python/workers/portfolio_core.py), backtest ile ayni kod. Bu dosya sadece veriyi getirir,
// durumu saklar ve rapor yazar.
//
// Her calismada (supervisor 30 dakikada bir `once` calistirir):
//   1. her (sembol, periyot) icin son islenen mumdan bu yana kapanan mumlar ve stratejinin
//      penceresi kadar oncesi Binance'ten alinir (kapali kalinan sure dahil, sayfalanarak)
//   2. worker `portfolio_run` bu mumlari zaman sirasiyla isler; durum geri doner ve saklanir
// Strateji modulu her calismada yeniden yuklenir; kararini sadece mum penceresinden ve portfoy
// durumundan veren stratejiler backtest ile ayni sonucu verir (bkz. tests/portfolioParity.test.ts).

const path = require('node:path');
const { spawn } = require('node:child_process');
const lifecycle = require('./paper_lifecycle.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const DAY = 86_400_000;
const ENGINE = 'portfolio_core';
const STATE_VERSION = 2;
const KLINE_PAGE_LIMIT = 1000;
const SCORE_MODES = ['target_distance', 'quality', 'quality_target'];
const INTERVAL_UNIT_MS = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY };
// Sinyal anahtarlari ve test duzeni bu alanlara bagli; calisan bir testte degistirilemez.
const LOCKED_CONFIG_KEYS = [
  'strategyFile', 'strategyCode', 'params', 'entryIntervals', 'confirmIntervals', 'confirmBars',
  'maxPositions', 'portfolioLeverage', 'initialCapital', 'feeBps', 'slippageBps', 'scoreMode',
  'maxHistoryBars',
];

function intervalMs(interval) {
  const match = /^(\d+)([mhdw])$/.exec(String(interval || '').trim());
  if (!match) throw new Error(`Gecersiz periyot: ${interval}`);
  return Number(match[1]) * INTERVAL_UNIT_MS[match[2]];
}

function sortIntervals(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
    .sort((a, b) => intervalMs(a) - intervalMs(b));
}

/** Komut satiri ayarlarindan dogrulanmis, kilitlenecek portfoy ayari. */
function buildConfig(input) {
  const entryIntervals = sortIntervals(input.entryIntervals || ['1h']);
  const confirmIntervals = sortIntervals(input.confirmIntervals || []);
  if (!entryIntervals.length) throw new Error('En az bir giris periyodu gerekli.');
  if (!input.strategyFile && !input.strategyCode) throw new Error('Strateji dosyasi gerekli (--strategy).');
  const scoreMode = String(input.scoreMode || 'target_distance');
  if (!SCORE_MODES.includes(scoreMode)) throw new Error(`Bilinmeyen puan modu: ${scoreMode}`);
  const positive = (value, name) => {
    const number = Number(value);
    if (!(number > 0)) throw new Error(`${name} 0'dan buyuk olmali.`);
    return number;
  };
  const config = {
    engine: ENGINE,
    botName: String(input.botName || '').trim() || 'Paper portfoy',
    strategyFile: input.strategyFile || null,
    params: input.params && typeof input.params === 'object' ? input.params : {},
    entryIntervals,
    confirmIntervals,
    intervals: sortIntervals([...entryIntervals, ...confirmIntervals]),
    // Arayuzun bayatlik kontrolu ve grafik varsayilani bu alani okur.
    interval: entryIntervals[0],
    confirmBars: Math.max(1, Math.floor(Number(input.confirmBars) || 3)),
    durationDays: positive(input.durationDays ?? 30, 'Sure (gun)'),
    symbolCount: Math.max(1, Math.floor(Number(input.symbolCount) || 0)),
    maxPositions: Math.max(1, Math.floor(positive(input.maxPositions ?? 10, 'Pozisyon sayisi'))),
    portfolioLeverage: positive(input.portfolioLeverage ?? 1, 'Kaldirac'),
    initialCapital: positive(input.initialCapital ?? 1000, 'Sermaye'),
    feeBps: Math.max(0, Number(input.feeBps ?? 10)),
    slippageBps: Math.max(0, Number(input.slippageBps ?? 2)),
    scoreMode,
    maxHistoryBars: Math.max(1, Math.floor(Number(input.maxHistoryBars) || 500)),
  };
  if (input.strategyCode) config.strategyCode = String(input.strategyCode);
  return config;
}

function createState(config, symbols, now = Date.now()) {
  if (!symbols.length) throw new Error('Sembol listesi bos.');
  return {
    version: STATE_VERSION,
    engine: ENGINE,
    status: 'running',
    startedAt: now,
    startedAtIso: new Date(now).toISOString(),
    stopAt: now + config.durationDays * DAY,
    stopAtIso: new Date(now + config.durationDays * DAY).toISOString(),
    config: { ...config, symbolCount: symbols.length },
    symbols: [...symbols],
    initialCapital: config.initialCapital,
    core: null,
    positions: {},
    trades: [],
    cycles: 0,
    lastCycleAt: null,
    lastCycleAtIso: null,
    failures: [],
    warnings: [],
  };
}

function isPortfolioState(state) {
  return Boolean(state) && state.engine === ENGINE && state.version === STATE_VERSION;
}

function validateState(state, config) {
  if (!isPortfolioState(state)) {
    throw new Error('Bu durum dosyasi cok sembollu paper modunun degil (eski script ile olusturulmus).');
  }
  if (!config) return;
  for (const key of LOCKED_CONFIG_KEYS) {
    if (JSON.stringify(state.config?.[key] ?? null) !== JSON.stringify(config[key] ?? null)) {
      throw new Error(`Mevcut test ayari farkli (${key}). Durumu silmeden kural degistirilemez.`);
    }
  }
}

function portfolioKeys(state) {
  const keys = [];
  for (const symbol of state.symbols) {
    for (const interval of state.config.intervals) keys.push(`${symbol}|${interval}`);
  }
  return keys;
}

/**
 * Bir anahtar icin bu calismada gereken mum araligi. Son islenen mumdan sonraki ilk mum, tam
 * strateji penceresiyle (maxHistoryBars) islenebilsin diye pencere kadar oncesinden baslar.
 * Yeni mum yoksa null.
 */
function fetchWindow(state, key, now) {
  const interval = key.split('|')[1];
  const step = intervalMs(interval);
  const lastT = state.core?.last_t?.[key];
  const latestClosedT = Math.floor(now / step) * step - step;
  const firstNeededT = lastT == null
    ? Math.floor(state.startedAt / step) * step
    : Number(lastT) + step;
  if (latestClosedT < firstNeededT) return null;
  const startTime = firstNeededT - state.config.maxHistoryBars * step;
  return { startTime, endTime: latestClosedT, step };
}

async function fetchKeyCandles(symbol, interval, window, fetchCandles) {
  const rows = [];
  let startTime = window.startTime;
  while (startTime <= window.endTime) {
    const page = await fetchCandles(symbol, interval, { startTime, limit: KLINE_PAGE_LIMIT });
    if (!page.length) break;
    for (const candle of page) {
      if (candle.t >= startTime && candle.t <= window.endTime) rows.push(candle);
    }
    const lastT = page.at(-1).t;
    if (lastT >= window.endTime || page.length < KLINE_PAGE_LIMIT) break;
    startTime = lastT + window.step;
  }
  return rows;
}

function coreRequest(state, extra) {
  const { config } = state;
  const request = {
    params: config.params,
    initial_capital: config.initialCapital,
    fee_bps: config.feeBps,
    slippage_bps: config.slippageBps,
    max_positions: config.maxPositions,
    leverage: config.portfolioLeverage,
    score_mode: config.scoreMode,
    entry_intervals: config.entryIntervals,
    confirm_intervals: config.confirmIntervals,
    confirm_bars: config.confirmBars,
    max_history_bars: config.maxHistoryBars,
    start_time: state.startedAt,
    require_full_window: true,
    state: state.core,
    ...extra,
  };
  if (config.strategyCode) request.strategy_code = config.strategyCode;
  else request.strategy_file = config.strategyFile;
  return request;
}

/**
 * Bir paper calismasi. Planlanan bitis gectiyse ya da test durdurulduysa yeni giris yok; acik
 * pozisyonlarin anahtarlari islenmeye devam eder (SL/TP, strateji kapanis sinyali).
 */
async function runCycle(state, deps) {
  const { now, fetchCandles, worker, log = () => undefined } = deps;
  const accepting = lifecycle.acceptingEntries(state, now);
  const tracked = (key) => Boolean(state.core?.positions?.[key] || state.core?.pending?.[key]);
  const keys = portfolioKeys(state).filter((key) => accepting || tracked(key));
  const failures = [];
  const datasets = {};
  const windows = new Map();
  for (const key of keys) {
    const window = fetchWindow(state, key, now);
    if (window) windows.set(key, window);
  }

  await mapLimit([...windows.keys()], deps.concurrency ?? 8, async (key) => {
    const [symbol, interval] = key.split('|');
    try {
      const candles = await fetchKeyCandles(symbol, interval, windows.get(key), fetchCandles);
      if (candles.length) datasets[key] = candles.map(stripCandle);
    } catch (error) {
      failures.push({ symbol, interval, stage: 'fetch', error: error.message });
    }
  });

  if (windows.size && !Object.keys(datasets).length) {
    throw new Error('Binance mum verisi alinamadi.');
  }
  if (Object.keys(datasets).length) {
    const result = await worker.request('portfolio_run', coreRequest(state, {
      datasets: sortedObject(datasets),
      accept_entries: accepting,
    }));
    applyResult(state, result, log);
  }
  finishCycle(state, now, failures);
  return state;
}

/** Elle durdurma: kapanmis mumlar islenir, kalan pozisyonlar son fiyattan kapanir. */
async function stopPortfolio(state, deps) {
  const { now, fetchCandles, worker, log = () => undefined } = deps;
  if (state.status === 'stopped') return state;
  const keys = Object.keys(state.core?.positions || {});
  const datasets = {};
  const lastPrices = {};
  for (const key of keys) {
    const [symbol, interval] = key.split('|');
    const window = fetchWindow(state, key, now) || {
      startTime: Math.floor(now / intervalMs(interval)) * intervalMs(interval),
      endTime: now,
      step: intervalMs(interval),
    };
    const candles = await fetchKeyCandles(symbol, interval, { ...window, endTime: now }, fetchCandles);
    if (!candles.length) throw new Error(`${symbol} icin fiyat alinamadi.`);
    // Son (henuz kapanmamis) mumun fiyati kapanis fiyati olur; strateji sadece kapananlari gorur.
    lastPrices[key] = candles.at(-1).c;
    const closed = candles.filter((candle) => candle.t + window.step <= now);
    if (closed.length) datasets[key] = closed.map(stripCandle);
  }
  if (keys.length) {
    const result = await worker.request('portfolio_run', coreRequest(state, {
      datasets: Object.keys(datasets).length ? sortedObject(datasets) : emptyDatasets(keys),
      accept_entries: false,
      close_all_at: lastPrices,
      close_time: now,
    }));
    applyResult(state, result, log);
  }
  state.status = 'stopped';
  state.stoppedAt = now;
  state.stoppedAtIso = new Date(now).toISOString();
  finishCycle(state, now, []);
  return state;
}

function emptyDatasets(keys) {
  return Object.fromEntries(keys.map((key) => [key, []]));
}

function applyResult(state, result, log) {
  state.core = result.state;
  state.positions = result.state.positions || {};
  for (const position of result.opened || []) {
    log(`ACILDI ${position.key} ${String(position.side).toUpperCase()} hedef=${round(position.target_pct ?? 0, 3)}%`);
  }
  for (const trade of result.closed || []) {
    const mapped = reportTrade(trade);
    state.trades.push(mapped);
    log(`KAPANDI ${trade.key} ${String(trade.reason).toUpperCase()} PnL=${trade.netPnl} USDT`);
  }
}

function finishCycle(state, now, failures) {
  state.cycles += 1;
  state.lastCycleAt = now;
  state.lastCycleAtIso = new Date(now).toISOString();
  state.failures = failures;
  state.warnings = cycleWarnings(state, now);
}

function cycleWarnings(state, now) {
  const counters = state.core?.counters || {};
  const warnings = [];
  for (const key of Object.keys(state.core?.positions || {})) {
    const step = intervalMs(key.split('|')[1]);
    const lastT = Number(state.core?.last_t?.[key] ?? 0);
    const missed = Math.floor((now - (lastT + step)) / step);
    if (state.status !== 'stopped' && missed > 3) {
      warnings.push(`${key}: acik pozisyon var ama ${missed} mumdur veri gelmiyor (islemden kalkmis olabilir).`);
    }
  }
  if (counters.short_window_bars) {
    warnings.push(`${counters.short_window_bars} mumda strateji penceresi dolmadigi icin strateji calismadi.`);
  }
  if (counters.late_bars) {
    warnings.push(`${counters.late_bars} mum gec islendi (veri alinamamisti): SL/TP islendi, strateji calismadi.`);
  }
  return warnings;
}

function reportTrade(trade) {
  return {
    id: trade.positionId || trade.id,
    tradeId: trade.id,
    key: trade.key,
    symbol: trade.symbol,
    interval: trade.interval,
    side: trade.side,
    signalTime: trade.signalTime,
    entryTime: trade.entryTime,
    entryTimeIso: new Date(trade.entryTime).toISOString(),
    entryPrice: trade.entryPrice,
    slPrice: trade.slPrice,
    tpPrice: trade.tpPrice,
    exitTime: trade.exitTime,
    exitTimeIso: new Date(trade.exitTime).toISOString(),
    exitPrice: trade.exitPrice,
    qty: trade.qty,
    allocation: trade.notional,
    netPnl: trade.netPnl,
    pnlPct: trade.pnlPct,
    accountReturnPct: trade.accountReturnPct,
    fees: trade.feePaid,
    targetPct: trade.targetPct,
    reason: trade.reason,
    meta: trade.meta || {},
  };
}

function reportPosition(position) {
  return {
    id: position.id,
    key: position.key,
    symbol: position.symbol,
    interval: position.interval,
    side: position.side,
    entry: round(position.entry_price, 8),
    sl: position.sl,
    tp: position.tp,
    targetPct: round(position.target_pct ?? 0, 4),
    qty: position.qty,
    allocation: round(position.notional, 4),
    entryFee: round(position.entry_fee, 4),
    signalTime: position.signal_time,
    entryTime: position.entry_time,
    openedAtIso: new Date(position.entry_time).toISOString(),
    meta: position.meta || {},
  };
}

function buildReport(state, now = Date.now()) {
  const core = state.core || {};
  const equity = Number(core.equity ?? state.initialCapital);
  const markEquity = Number(core.mark_equity ?? equity);
  const elapsedDays = Math.max((lifecycle.reportEndTime(state, now) - state.startedAt) / DAY, 1 / 1440);
  const closed = state.trades.length;
  const wins = state.trades.filter((trade) => trade.netPnl > 0).length;
  const totalReturnPct = (equity / state.initialCapital - 1) * 100;
  const markReturnPct = (markEquity / state.initialCapital - 1) * 100;
  const counters = core.counters || {};
  const patternStats = {};
  for (const trade of state.trades) {
    const meta = trade.meta || {};
    const name = meta.pattern
      ? `${meta.pattern} L${meta.zigzag_length ?? '?'} ${meta.direction || trade.side}`
      : `${trade.interval} ${trade.side}`;
    const row = patternStats[name] || { trades: 0, wins: 0, pnl: 0 };
    row.trades += 1;
    row.wins += trade.netPnl > 0 ? 1 : 0;
    row.pnl += trade.netPnl;
    patternStats[name] = row;
  }
  const { strategyCode: _code, ...config } = state.config;
  return {
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    engine: ENGINE,
    startedAtIso: state.startedAtIso,
    stopAtIso: state.stopAtIso,
    stoppedAtIso: state.stoppedAtIso || null,
    status: lifecycle.lifecycleStatus(state, now),
    elapsedDays: round(elapsedDays, 4),
    remainingDays: round(lifecycle.remainingMs(state, now) / DAY, 4),
    assumptions: {
      paperOnly: true,
      data: `Binance public spot klines (${state.config.intervals.join(', ')})`,
      engine: 'python/workers/portfolio_core.py (backtest ile ayni kurallar)',
      entry: 'sinyal mumundan sonraki mumun acilisi, kayma dahil',
      exit: 'pessimistic OHLC: ayni mumda SL+TP ise once SL; boslukta acilistan cikis',
      htfConfirmation: state.config.confirmIntervals.length
        ? `giris sinyali ${state.config.confirmIntervals.join(', ')} periyodunda ayni yonde, son ${state.config.confirmBars} mum icinde sinyal ister`
        : null,
      strategyState: 'strateji her calismada yeniden yuklenir; karar sadece mum penceresi ve portfoy durumundan',
      fundingAndLiquidation: 'modellenmiyor',
    },
    config,
    symbols: state.symbols,
    metrics: {
      initialCapital: round(state.initialCapital, 2),
      realizedEquity: round(equity, 2),
      markEquity: round(markEquity, 2),
      realizedPnl: round(Number(core.realized_pnl ?? 0), 4),
      totalReturnPct: round(totalReturnPct, 4),
      markReturnPct: round(markReturnPct, 4),
      compoundDailyReturnPct: round(compoundDaily(totalReturnPct, elapsedDays), 4),
      markCompoundDailyReturnPct: round(compoundDaily(markReturnPct, elapsedDays), 4),
      closedTrades: closed,
      openPositions: Object.keys(state.positions || {}).length,
      winRatePct: closed ? round((wins / closed) * 100, 2) : null,
      realizedMaxDrawdownPct: round(Number(core.max_drawdown_pct ?? 0), 4),
      markMaxDrawdownPct: round(Number(core.mark_max_drawdown_pct ?? 0), 4),
      rejectedSignals: counters.rejected_signals ?? 0,
      rejectedHtfConfirmations: counters.rejected_htf ?? 0,
      duplicateSignals: counters.duplicate_signals ?? 0,
      rejectedAtEntry: counters.rejected_at_entry ?? 0,
      cycles: state.cycles,
    },
    patternStats: Object.fromEntries(Object.entries(patternStats).map(([name, row]) => [name, {
      ...row,
      pnl: round(row.pnl, 4),
      winRatePct: round((row.wins / row.trades) * 100, 2),
    }])),
    openPositions: Object.values(state.positions || {}).map(reportPosition),
    recentTrades: state.trades.slice(-100),
    failures: state.failures || [],
    warnings: state.warnings || [],
  };
}

function renderMarkdown(report) {
  const m = report.metrics;
  const patterns = Object.entries(report.patternStats).map(([name, row]) =>
    `| ${name} | ${row.trades} | ${row.winRatePct}% | ${row.pnl} |`).join('\n');
  return [
    `# ${report.config.botName} (paper)`, '',
    `- Durum: ${report.status}`,
    `- Strateji: ${report.config.strategyFile || 'satir ici'}`,
    `- Periyotlar: giris ${report.config.entryIntervals.join(', ')}` +
      (report.config.confirmIntervals.length ? `, onay ${report.config.confirmIntervals.join(', ')}` : ''),
    `- Baslangic: ${report.startedAtIso}`,
    `- Planlanan bitis: ${report.stopAtIso}`,
    `- Gecen sure: ${report.elapsedDays} gun`,
    `- Sembol: ${report.symbols.length}`,
    '', '## Sonuc', '',
    `- Gerceklesen sermaye: ${m.realizedEquity} USDT`,
    `- Acik islemler dahil sermaye: ${m.markEquity} USDT`,
    `- Gerceklesen getiri: ${m.totalReturnPct}%`,
    `- Acik islemler dahil getiri: ${m.markReturnPct}%`,
    `- Bilesik gunluk getiri: ${m.compoundDailyReturnPct}%`,
    `- Kapanan islem: ${m.closedTrades}`,
    `- Acik pozisyon: ${m.openPositions}`,
    `- Kazanma orani: ${m.winRatePct ?? '-'}%`,
    `- Acik islemler dahil maksimum dusus: ${m.markMaxDrawdownPct}%`,
    `- Yer olmadigi icin alinmayan sinyal: ${m.rejectedSignals}`,
    `- Ust periyot onayi olmadigi icin alinmayan sinyal: ${m.rejectedHtfConfirmations}`,
    '', '## Formasyonlar', '',
    '| Formasyon | Islem | Win rate | Net PnL |',
    '| --- | ---: | ---: | ---: |',
    patterns || '| Henuz kapanan islem yok | 0 | - | 0 |',
    ...(report.warnings.length ? ['', '## Uyarilar', '', ...report.warnings.map((item) => `- ${item}`)] : []),
    '', 'Paper testidir; gercek emir gondermez.', '',
  ].join('\n');
}

function startWorker(options = {}) {
  const python = options.python || process.env.PYTHON_BIN || 'python';
  const child = spawn(python, ['-u', 'python/workers/pool_worker.py'], {
    cwd: options.cwd || ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (options.onStderr || ((text) => process.stderr.write(text)))(chunk));
  let buffer = '';
  let sequence = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.data);
      else waiter.reject(new Error(message.error || 'Python worker hatasi'));
    }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Python worker kapandi: ${code}`));
    pending.clear();
  });
  return {
    request(cmd, payload, timeout = options.timeoutMs ?? 540_000) {
      const id = `portfolio_${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Worker timeout: ${cmd}`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
      });
    },
    close() { child.kill(); },
  };
}

/** Binance spot kline'lari; mum acilis zamanina gore. */
async function fetchBinanceCandles(symbol, interval, { startTime, limit = KLINE_PAGE_LIMIT }, fetchJson) {
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('startTime', String(startTime));
  url.searchParams.set('limit', String(limit));
  const rows = await fetchJson(url);
  return rows.map((row) => ({
    t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]),
    c: Number(row[4]), v: Number(row[5]),
  }));
}

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 500);
    }
  }
  throw lastError;
}

/**
 * Islem hacmine gore sembol secimi: sadece TRADING durumundaki USDT spot sembolleri, stabil ve
 * kaldiracli tokenlar haric, en uzun periyotta stratejinin penceresi kadar guncel gecmisi olanlar.
 */
async function selectSymbols(limit, config, deps = {}) {
  const getJson = deps.fetchJson || fetchJson;
  const now = deps.now ?? Date.now();
  const stableOrFiat = new Set([
    'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1', 'RLUSD',
    'XUSD', 'EUR', 'EURI', 'TRY', 'BRL', 'ARS', 'AEUR', 'BFUSD', 'PAXG', 'XAUT',
  ]);
  const [tickers, exchangeInfo] = await Promise.all([
    getJson('https://api.binance.com/api/v3/ticker/24hr'),
    getJson('https://api.binance.com/api/v3/exchangeInfo'),
  ]);
  const trading = new Set((exchangeInfo.symbols || [])
    .filter((item) => item.status === 'TRADING' && item.isSpotTradingAllowed !== false)
    .map((item) => item.symbol));
  const ranked = tickers.filter((item) => {
    const symbol = String(item.symbol || '');
    if (!/^[A-Z0-9]+USDT$/.test(symbol) || !trading.has(symbol)) return false;
    const base = symbol.slice(0, -4);
    return base.length >= 2 && !stableOrFiat.has(base) && !/(UP|DOWN|BULL|BEAR)$/.test(base)
      && Number(item.quoteVolume || 0) > 0;
  }).sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0));

  const probe = config.intervals.at(-1);
  const step = intervalMs(probe);
  const selected = [];
  for (const ticker of ranked) {
    if (selected.length >= limit) break;
    try {
      const candles = await fetchBinanceCandles(ticker.symbol, probe, {
        startTime: Math.floor(now / step) * step - (config.maxHistoryBars + 1) * step,
        limit: config.maxHistoryBars + 2,
      }, getJson);
      const closed = candles.filter((candle) => candle.t + step <= now);
      const fresh = closed.length && now - (closed.at(-1).t + step) <= step * 3;
      if (closed.length >= config.maxHistoryBars && fresh) selected.push(ticker.symbol);
    } catch {
      // Islemden kalkmis ya da gecici olarak alinamayan sembol atlanir.
    }
    await sleep(25);
  }
  if (selected.length < limit) throw new Error(`Yalnizca ${selected.length}/${limit} olgun sembol bulundu.`);
  return selected;
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(runners);
}

function sortedObject(values) {
  return Object.fromEntries(Object.keys(values).sort().map((key) => [key, values[key]]));
}

function stripCandle(candle) {
  return { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v };
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function compoundDaily(totalReturnPct, days) {
  if (totalReturnPct <= -100) return -100;
  return (Math.pow(1 + totalReturnPct / 100, 1 / Math.max(days, 1 / 1440)) - 1) * 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ENGINE,
  STATE_VERSION,
  intervalMs,
  buildConfig,
  createState,
  isPortfolioState,
  validateState,
  portfolioKeys,
  fetchWindow,
  runCycle,
  stopPortfolio,
  buildReport,
  renderMarkdown,
  startWorker,
  fetchBinanceCandles,
  fetchJson,
  selectSymbols,
};
