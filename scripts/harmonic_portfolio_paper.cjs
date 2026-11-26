#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lifecycle = require('./lib/paper_lifecycle.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOUR = 3_600_000;
const DAY = 86_400_000;

const args = parseArgs(process.argv.slice(2));
const statePath = path.resolve(ROOT, args.state || 'data/harmonic_portfolio_paper_state.json');
const reportPath = path.resolve(ROOT, args.report || 'data/harmonic_portfolio_paper_report.json');
const lockPath = `${statePath}.lock`;
const explicitSymbols = String(args.list || '')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);

const config = Object.freeze({
  botName: String(args.name || 'Harmonik Portfoy').replaceAll('_', ' '),
  strategyFile: 'harmonic_portfolio_candidate.py',
  interval: '1h',
  durationDays: numberArg(args.days, 15),
  symbolCount: explicitSymbols.length || integerArg(args.symbols, 50),
  maxPositions: integerArg(args.positions, 10),
  portfolioLeverage: numberArg(args.leverage, 12),
  initialCapital: numberArg(args.capital, 1000),
  feeBps: numberArg(args['fee-bps'], 10),
  slippageBps: numberArg(args['slippage-bps'], 2),
  stopTargetRatio: 0.2,
  scoreMode: String(args.score || 'target_distance'),
  candleLimit: 600,
});

main().catch((error) => {
  console.error(`Harmonik paper testi durdu: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const action = String(args.action || 'start').toLowerCase();
  if (action === 'report') {
    const state = readState();
    const report = writeReport(state);
    printReport(report);
    return;
  }
  if (!['start', 'once', 'stop', 'extend'].includes(action)) {
    throw new Error(`Bilinmeyen action: ${action}`);
  }

  const releaseLock = acquireLock();
  let worker;
  try {
    let state = readState(false);
    if (action === 'stop' || action === 'extend') {
      if (!state) throw new Error(`Paper test durumu bulunamadi: ${statePath}`);
      validateState(state);
      await applyLifecycleAction(action, state);
      return;
    }
    if (!state) {
      const symbols = explicitSymbols.length
        ? explicitSymbols.slice(0, config.symbolCount)
        : await selectSymbols(config.symbolCount);
      state = createState(symbols);
      saveState(state);
      console.log(`Yeni paper testi olusturuldu: ${symbols.length} sembol, ${config.durationDays} gun.`);
    } else {
      validateState(state);
      console.log(`Paper testi devam ediyor: ${state.symbols.length} sembol, baslangic ${state.startedAtIso}.`);
    }

    if (!lifecycle.acceptingEntries(state)) {
      await runManageOnlyCycle(state);
      return;
    }

    worker = startWorker();
    await loadStrategies(worker, state.symbols);

    do {
      await runCycle(worker, state);
      saveState(state);
      const report = writeReport(state);
      printReport(report);
      if (action === 'once' || !lifecycle.acceptingEntries(state)) break;
      const next = Math.floor(Date.now() / HOUR + 1) * HOUR + 15_000;
      const waitMs = Math.max(10_000, next - Date.now());
      console.log(`Sonraki 1 saatlik mum bekleniyor: ${new Date(Date.now() + waitMs).toLocaleString('tr-TR')}`);
      await sleep(waitMs);
    } while (true);
  } finally {
    if (worker) worker.close();
    releaseLock();
  }
}

// Planlanan bitis gectiyse ya da test durdurulduysa yeni islem acilmaz; sadece acik pozisyonlar izlenir.
async function runManageOnlyCycle(state) {
  const now = Date.now();
  if (Object.keys(state.positions).length) {
    state.failures = await lifecycle.manageOpenPositions(state, lifecycleDeps(now));
    updateMarkToMarket(state);
    state.lastCycleAt = now;
    state.lastCycleAtIso = new Date(now).toISOString();
    state.cycles += 1;
    saveState(state);
  }
  printReport(writeReport(state));
}

async function applyLifecycleAction(action, state) {
  const now = Date.now();
  if (action === 'stop') {
    await lifecycle.stopAndCloseAll(state, lifecycleDeps(now));
    updateMarkToMarket(state);
  } else {
    lifecycle.extendStopAt(state, Number(args['extend-days']), now);
  }
  saveState(state);
  printReport(writeReport(state));
}

function lifecycleDeps(now) {
  return {
    now,
    candleLimit: config.candleLimit,
    positionInterval: () => config.interval,
    fetchCandles,
    processPositionCandles,
    closePosition,
  };
}

async function runCycle(worker, state) {
  const now = Date.now();
  const datasets = new Map();
  const failures = [];
  await mapLimit(state.symbols, 6, async (symbol) => {
    try {
      datasets.set(symbol, await fetchCandles(symbol, config.interval, config.candleLimit));
    } catch (error) {
      failures.push({ symbol, error: error.message });
    }
  });
  if (!datasets.size) throw new Error('Binance mum verisi alinamadi.');

  for (const [symbol, dataset] of datasets) {
    const closed = dataset.filter((candle) => candle.closeTime < now);
    if (!closed.length) continue;
    processPositionCandles(state, symbol, closed);
    state.lastMarks[symbol] = closed.at(-1).c;
  }

  const candidates = [];
  for (const [symbol, dataset] of datasets) {
    const closed = dataset.filter((candle) => candle.closeTime < now);
    if (closed.length < 40) continue;
    const latest = closed.at(-1);
    if (Number(state.lastSignalCandles[symbol] || 0) >= latest.t) continue;

    const position = state.positions[symbol];
    let result;
    try {
      result = await worker.request('tick', {
        instance: instanceId(symbol),
        candle: stripCandle(latest),
        candles: closed.map(stripCandle),
        include_drawings: false,
        portfolio: {
          usdt: state.equity,
          has_position: Boolean(position),
          pnl: state.equity - state.initialCapital,
          side: position ? (position.side === 'long' ? 'BUY' : 'SELL') : undefined,
        },
      });
    } catch (error) {
      state.lastSignalCandles[symbol] = latest.t;
      failures.push({ symbol, stage: 'tick', error: error.message });
      continue;
    }
    state.lastSignalCandles[symbol] = latest.t;
    if (position || !['buy', 'sell'].includes(result.signal)) continue;

    const side = result.signal === 'buy' ? 'long' : 'short';
    const current = dataset.find((candle) => candle.t > latest.t) || latest;
    const rawEntry = Number(current.o || latest.c);
    const tp = Number(result.tp_price || 0);
    const slipRate = config.slippageBps / 10_000;
    const entry = rawEntry * (side === 'long' ? 1 + slipRate : 1 - slipRate);
    const validTarget = side === 'long' ? tp > entry : tp > 0 && tp < entry;
    if (!validTarget) continue;

    const targetDistance = Math.abs(tp - entry);
    const sl = side === 'long'
      ? entry - targetDistance * config.stopTargetRatio
      : entry + targetDistance * config.stopTargetRatio;
    const targetPct = targetDistance / entry * 100;
    const signalKey = patternSignalKey(symbol, result.meta, latest.t);
    if (signalAlreadyTraded(state, signalKey)) continue;
    candidates.push({
      symbol,
      side,
      rawEntry,
      entry,
      sl,
      tp,
      targetPct,
      signalTime: latest.t,
      entryTime: current.t,
      signalKey,
      meta: result.meta || {},
    });
  }

  const slots = Math.max(0, config.maxPositions - Object.keys(state.positions).length);
  candidates.sort((a, b) => candidateScore(b) - candidateScore(a));
  for (const candidate of candidates.slice(0, slots)) openPosition(state, candidate);
  state.rejectedSignals += Math.max(0, candidates.length - slots);
  if (state.seenSignalKeys.length > 5000) state.seenSignalKeys.splice(0, state.seenSignalKeys.length - 5000);
  updateMarkToMarket(state);
  state.lastCycleAt = now;
  state.lastCycleAtIso = new Date(now).toISOString();
  state.cycles += 1;
  state.failures = failures;
}

function candidateScore(candidate) {
  const quality = Math.max(0, Number(candidate.meta?.quality || 0));
  if (config.scoreMode === 'quality_target') {
    return quality * Math.sqrt(Math.max(0, candidate.targetPct));
  }
  if (config.scoreMode === 'quality') return quality;
  return candidate.targetPct;
}

function processPositionCandles(state, symbol, candles) {
  const position = state.positions[symbol];
  if (!position) return;
  for (const candle of candles) {
    if (candle.t <= position.lastCheckedT) continue;
    position.lastCheckedT = candle.t;
    const exit = stopOrTarget(position, candle);
    if (!exit) continue;
    closePosition(state, position, exit.price, candle.t, exit.reason);
    break;
  }
}

function stopOrTarget(position, candle) {
  const open = Number(candle.o);
  const high = Number(candle.h);
  const low = Number(candle.l);
  if (position.side === 'long') {
    if (open <= position.sl) return { price: open, reason: 'sl_gap' };
    if (open >= position.tp) return { price: open, reason: 'tp_gap' };
    const hitSl = low <= position.sl;
    const hitTp = high >= position.tp;
    if (hitSl) return { price: position.sl, reason: hitTp ? 'sl_same_candle' : 'sl' };
    if (hitTp) return { price: position.tp, reason: 'tp' };
  } else {
    if (open >= position.sl) return { price: open, reason: 'sl_gap' };
    if (open <= position.tp) return { price: open, reason: 'tp_gap' };
    const hitSl = high >= position.sl;
    const hitTp = low <= position.tp;
    if (hitSl) return { price: position.sl, reason: hitTp ? 'sl_same_candle' : 'sl' };
    if (hitTp) return { price: position.tp, reason: 'tp' };
  }
  return null;
}

function openPosition(state, candidate) {
  const allocation = state.equity / config.maxPositions * config.portfolioLeverage;
  if (!(allocation > 0)) return;
  const feeRate = config.feeBps / 10_000;
  const qty = allocation / candidate.entry;
  state.positions[candidate.symbol] = {
    id: `hp_${++state.positionSequence}`,
    ...candidate,
    allocation,
    qty,
    entryFee: allocation * feeRate,
    lastCheckedT: candidate.signalTime,
    openedAtIso: new Date(candidate.entryTime).toISOString(),
  };
  state.seenSignalKeys.push(candidate.signalKey);
  state.entries += 1;
  console.log(`ACILDI ${candidate.symbol} ${candidate.side.toUpperCase()} hedef=${candidate.targetPct.toFixed(3)}%`);
}

// Ayni pattern'e (ayni D noktasi) tek islem. Anahtar mum sirasini (signal_i) icermez:
// signal_i her yeni mumda bir kaydigi icin, stop olan pattern son birkac mum icinde
// sinyal vermeye devam ettikce "yeni sinyal" sayilip tekrar giriliyordu.
function patternSignalKey(prefix, meta, signalTime) {
  const dTime = Number(meta?.d_time);
  const anchor = Number.isFinite(dTime) && dTime > 0 ? dTime : `signal-${signalTime}`;
  return [prefix, meta?.pattern, meta?.zigzag_length, meta?.direction, anchor].join('|');
}

// Eski formatli anahtarlar ("...|d_time|signal_i") ayni pattern'in devami sayilir.
function signalAlreadyTraded(state, signalKey) {
  const legacyPrefix = `${signalKey}|`;
  return state.seenSignalKeys.some((seen) => seen === signalKey || seen.startsWith(legacyPrefix));
}

function closePosition(state, position, rawExit, exitTime, reason) {
  const feeRate = config.feeBps / 10_000;
  const slipRate = config.slippageBps / 10_000;
  const exit = Number(rawExit) * (position.side === 'long' ? 1 - slipRate : 1 + slipRate);
  const gross = position.side === 'long'
    ? (exit - position.entry) * position.qty
    : (position.entry - exit) * position.qty;
  const exitFee = Math.abs(exit * position.qty) * feeRate;
  const netPnl = gross - position.entryFee - exitFee;
  state.equity += netPnl;
  state.realizedPnl += netPnl;
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  state.realizedMaxDrawdownPct = Math.max(
    state.realizedMaxDrawdownPct,
    state.peakEquity > 0 ? (state.peakEquity - state.equity) / state.peakEquity * 100 : 0,
  );
  const trade = {
    id: position.id,
    symbol: position.symbol,
    side: position.side,
    entryTime: position.entryTime,
    entryTimeIso: position.openedAtIso,
    entryPrice: round(position.entry, 8),
    slPrice: round(position.sl, 8),
    tpPrice: round(position.tp, 8),
    exitTime,
    exitTimeIso: new Date(exitTime).toISOString(),
    exitPrice: round(exit, 8),
    allocation: round(position.allocation, 4),
    netPnl: round(netPnl, 4),
    pnlPct: round(netPnl / position.allocation * 100, 4),
    accountReturnPct: round(netPnl / Math.max(1, state.equity - netPnl) * 100, 4),
    fees: round(position.entryFee + exitFee, 4),
    reason,
    meta: position.meta,
  };
  state.trades.push(trade);
  delete state.positions[position.symbol];
  console.log(`KAPANDI ${position.symbol} ${reason.toUpperCase()} PnL=${trade.netPnl} USDT`);
}

function updateMarkToMarket(state) {
  let markEquity = state.equity;
  const feeRate = config.feeBps / 10_000;
  const slipRate = config.slippageBps / 10_000;
  for (const position of Object.values(state.positions)) {
    const raw = Number(state.lastMarks[position.symbol] || position.entry);
    const mark = raw * (position.side === 'long' ? 1 - slipRate : 1 + slipRate);
    const gross = position.side === 'long'
      ? (mark - position.entry) * position.qty
      : (position.entry - mark) * position.qty;
    markEquity += gross - position.entryFee - Math.abs(mark * position.qty) * feeRate;
  }
  state.markEquity = markEquity;
  state.markPeakEquity = Math.max(state.markPeakEquity, markEquity);
  state.markMaxDrawdownPct = Math.max(
    state.markMaxDrawdownPct,
    state.markPeakEquity > 0 ? (state.markPeakEquity - markEquity) / state.markPeakEquity * 100 : 0,
  );
}

function createState(symbols) {
  const startedAt = Date.now();
  return {
    version: 1,
    status: 'running',
    startedAt,
    startedAtIso: new Date(startedAt).toISOString(),
    stopAt: startedAt + config.durationDays * DAY,
    stopAtIso: new Date(startedAt + config.durationDays * DAY).toISOString(),
    config: { ...config },
    symbols,
    initialCapital: config.initialCapital,
    equity: config.initialCapital,
    markEquity: config.initialCapital,
    realizedPnl: 0,
    peakEquity: config.initialCapital,
    markPeakEquity: config.initialCapital,
    realizedMaxDrawdownPct: 0,
    markMaxDrawdownPct: 0,
    positions: {},
    trades: [],
    lastMarks: {},
    lastSignalCandles: {},
    seenSignalKeys: [],
    entries: 0,
    rejectedSignals: 0,
    positionSequence: 0,
    cycles: 0,
    failures: [],
  };
}

function validateState(state) {
  const locked = [
    'strategyFile', 'interval', 'maxPositions', 'portfolioLeverage', 'feeBps',
    'slippageBps', 'stopTargetRatio', 'scoreMode',
  ];
  for (const key of locked) {
    if (state.config?.[key] !== config[key]) {
      throw new Error(`Mevcut test ayari farkli (${key}). Durumu silmeden kural degistirilemez.`);
    }
  }
}

function buildReport(state) {
  updateMarkToMarket(state);
  const now = Date.now();
  const elapsedDays = Math.max((lifecycle.reportEndTime(state, now) - state.startedAt) / DAY, 1 / 1440);
  const closed = state.trades.length;
  const wins = state.trades.filter((trade) => trade.netPnl > 0).length;
  const totalReturnPct = (state.equity / state.initialCapital - 1) * 100;
  const markReturnPct = (state.markEquity / state.initialCapital - 1) * 100;
  const daily = compoundDaily(totalReturnPct, elapsedDays);
  const markDaily = compoundDaily(markReturnPct, elapsedDays);
  const patternStats = {};
  for (const trade of state.trades) {
    const key = `${trade.meta?.pattern || 'unknown'} L${trade.meta?.zigzag_length || '?'} ${trade.meta?.direction || trade.side}`;
    const row = patternStats[key] || { trades: 0, wins: 0, pnl: 0 };
    row.trades += 1;
    row.wins += trade.netPnl > 0 ? 1 : 0;
    row.pnl += trade.netPnl;
    patternStats[key] = row;
  }
  return {
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    startedAtIso: state.startedAtIso,
    stopAtIso: state.stopAtIso,
    stoppedAtIso: state.stoppedAtIso || null,
    status: lifecycle.lifecycleStatus(state, now),
    elapsedDays: round(elapsedDays, 4),
    remainingDays: round(lifecycle.remainingMs(state, now) / DAY, 4),
    assumptions: {
      paperOnly: true,
      data: 'Binance public spot 1h klines',
      entry: 'next candle open with slippage',
      exit: 'pessimistic OHLC, stop first',
      fundingAndLiquidation: 'not modelled',
    },
    config: state.config,
    symbols: state.symbols,
    metrics: {
      initialCapital: round(state.initialCapital, 2),
      realizedEquity: round(state.equity, 2),
      markEquity: round(state.markEquity, 2),
      realizedPnl: round(state.realizedPnl, 4),
      totalReturnPct: round(totalReturnPct, 4),
      markReturnPct: round(markReturnPct, 4),
      compoundDailyReturnPct: round(daily, 4),
      markCompoundDailyReturnPct: round(markDaily, 4),
      closedTrades: closed,
      openPositions: Object.keys(state.positions).length,
      winRatePct: closed ? round(wins / closed * 100, 2) : null,
      realizedMaxDrawdownPct: round(state.realizedMaxDrawdownPct, 4),
      markMaxDrawdownPct: round(state.markMaxDrawdownPct, 4),
      rejectedSignals: state.rejectedSignals,
      cycles: state.cycles,
    },
    patternStats: Object.fromEntries(Object.entries(patternStats).map(([key, row]) => [key, {
      ...row,
      pnl: round(row.pnl, 4),
      winRatePct: round(row.wins / row.trades * 100, 2),
    }])),
    openPositions: Object.values(state.positions),
    recentTrades: state.trades.slice(-100),
    failures: state.failures || [],
  };
}

function writeReport(state) {
  const report = buildReport(state);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(reportPath.replace(/\.json$/i, '.md'), renderMarkdown(report));
  return report;
}

function renderMarkdown(report) {
  const m = report.metrics;
  const patterns = Object.entries(report.patternStats).map(([name, row]) =>
    `| ${name} | ${row.trades} | ${row.winRatePct}% | ${row.pnl} |`).join('\n');
  return [
    '# Harmonik Portfoy Paper Testi', '',
    `- Durum: ${report.status}`,
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
    '', '## Formasyonlar', '',
    '| Formasyon | Islem | Win rate | Net PnL |',
    '| --- | ---: | ---: | ---: |',
    patterns || '| Henuz kapanan islem yok | 0 | - | 0 |',
    '', 'Paper testidir; gercek emir gondermez.', '',
  ].join('\n');
}

function printReport(report) {
  const m = report.metrics;
  console.log([
    `Durum=${report.status}`,
    `gun=${report.elapsedDays}`,
    `equity=${m.realizedEquity}`,
    `mark=${m.markEquity}`,
    `getiri=${m.totalReturnPct}%`,
    `gunluk=${m.compoundDailyReturnPct}%`,
    `islem=${m.closedTrades}`,
    `acik=${m.openPositions}`,
    `DD=${m.markMaxDrawdownPct}%`,
  ].join(' | '));
  console.log(`Rapor: ${reportPath}`);
}

async function selectSymbols(limit) {
  const stableOrFiat = new Set([
    'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1', 'RLUSD',
    'XUSD', 'EUR', 'EURI', 'TRY', 'BRL', 'ARS', 'AEUR', 'BFUSD', 'PAXG', 'XAUT',
  ]);
  const tickers = await fetchJson('https://api.binance.com/api/v3/ticker/24hr');
  const ranked = tickers.filter((item) => {
    const symbol = String(item.symbol || '');
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
    const base = symbol.slice(0, -4);
    return base.length >= 2 && !stableOrFiat.has(base) && !/(UP|DOWN|BULL|BEAR)$/.test(base)
      && Number(item.quoteVolume || 0) > 0;
  }).sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0));

  const selected = [];
  for (const ticker of ranked) {
    if (selected.length >= limit) break;
    try {
      const candles = await fetchCandles(ticker.symbol, config.interval, config.candleLimit);
      const closed = candles.filter((candle) => candle.closeTime < Date.now());
      if (closed.length >= 500) selected.push(ticker.symbol);
    } catch (_) {
      // Delisted or temporarily unavailable symbols are skipped.
    }
    await sleep(25);
  }
  if (selected.length < limit) throw new Error(`Yalnizca ${selected.length}/${limit} olgun sembol bulundu.`);
  return selected;
}

async function fetchCandles(symbol, interval, limit) {
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));
  const rows = await fetchJson(url);
  return rows.map((row) => ({
    t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]),
    c: Number(row[4]), v: Number(row[5]), closeTime: Number(row[6]),
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

function startWorker() {
  const child = spawn('python', ['-u', 'python/workers/pool_worker.py'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
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
      try { message = JSON.parse(line); } catch (_) { continue; }
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
    request(cmd, payload, timeout = 600_000) {
      const id = `hpaper_${++sequence}`;
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

async function loadStrategies(worker, symbols) {
  for (const symbol of symbols) {
    await worker.request('load', {
      instance: instanceId(symbol),
      strategy_file: config.strategyFile,
      params: {},
    });
  }
}

function instanceId(symbol) { return `harmonic_paper_${symbol}`; }
function stripCandle(candle) { return { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v }; }

function readState(required = true) {
  if (!fs.existsSync(statePath)) {
    if (required) throw new Error(`Paper test durumu bulunamadi: ${statePath}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, statePath);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new Error(`Paper testi zaten calisiyor (PID ${pid}).`);
    } catch (probe) {
      if (probe.message?.includes('zaten calisiyor')) throw probe;
      fs.rmSync(lockPath, { force: true });
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    }
  }
  const release = () => fs.rmSync(lockPath, { force: true });
  process.once('exit', release);
  process.once('SIGINT', () => { release(); process.exit(130); });
  process.once('SIGTERM', () => { release(); process.exit(143); });
  return release;
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(workers);
}

function parseArgs(values) {
  return Object.fromEntries(values.filter((value) => value.startsWith('--')).map((value) => {
    const [key, ...rest] = value.slice(2).split('=');
    return [key, rest.length ? rest.join('=') : 'true'];
  }));
}
function numberArg(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function integerArg(value, fallback) { return Math.max(1, Math.floor(numberArg(value, fallback))); }
function round(value, digits = 4) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function compoundDaily(totalReturnPct, days) {
  if (totalReturnPct <= -100) return -100;
  return (Math.pow(1 + totalReturnPct / 100, 1 / Math.max(days, 1 / 1440)) - 1) * 100;
}
