#!/usr/bin/env node
// V2 arastirma: harmonic_robust_search_v2.py ile pattern + HTF rejim filtresi kombinasyonlarini
// ORTUSMEYEN iki donemde (train: 365-91 gun once, test: son 91 gun) tarar. Amac: sadece TEK
// bir donemde degil, HER IKI donemde de pozitif PF veren gercekten tutarli bir aday bulmak.
// Uretim/canli akisla ilgisi yoktur.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SYMBOL_COUNT = 30;
const TIMEFRAMES = ['1h', '4h'];
const FULL_DAYS = 365;
const TEST_DAYS = 91; // son 91 gun = test (out-of-sample)
const STRATEGY_FILE = 'harmonic_robust_search_v2.py';
const WORKER_FILE = 'python/workers/pool_worker_v2.py';

const PATTERN_CANDIDATES = [
  { pattern: 'AB=CD', direction: 'bullish' },
  { pattern: 'Derin Yengec', direction: 'bullish' },
  { pattern: 'Derin Yengec', direction: 'bearish' },
  { pattern: 'Yengec', direction: 'bearish' },
  { pattern: 'Kelebek', direction: 'bearish' },
  { pattern: '3 Basamak', direction: 'bearish' },
];
const REGIME_MODES = ['off', 'with_trend', 'prefer_with_trend'];

const GRID = [];
for (const pc of PATTERN_CANDIDATES) {
  for (const htf_regime_filter of REGIME_MODES) {
    GRID.push({ trade_filters: [pc], htf_regime_filter, label: `${pc.pattern}/${pc.direction}/${htf_regime_filter}` });
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_JSON = path.resolve(ROOT, `data/harmonic_robustness_search_v2_${stamp}.json`);
const OUT_MD = path.resolve(ROOT, `data/harmonic_robustness_search_v2_${stamp}.md`);
const PROGRESS_PATH = path.resolve(ROOT, `data/harmonic_robustness_search_v2_${stamp}.progress.json`);

main().catch((error) => {
  console.error(`Robustness search durdu: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  console.log(`[${new Date().toISOString()}] Sembol listesi cekiliyor...`);
  const symbols = await fetchTopUsdtSymbols(SYMBOL_COUNT);
  console.log(`Secilen ${symbols.length} sembol. Grid: ${GRID.length} config x 2 donem (train+test)`);

  console.log('Mum verileri cekiliyor (bir kez, tum configler icin yeniden kullanilacak)...');
  const dataBySymbol = new Map(); // key -> { full: candles[], trainSlice: candles[] }
  const testCutoff = Date.now() - TEST_DAYS * DAY;
  for (const symbol of symbols) {
    for (const interval of TIMEFRAMES) {
      try {
        const candles = await fetchCandles(symbol, interval, FULL_DAYS);
        if (candles.length < 100) continue;
        const trainSlice = candles.filter((c) => c.t < testCutoff);
        if (trainSlice.length < 60) continue;
        dataBySymbol.set(`${symbol}|${interval}`, { full: candles, trainSlice });
      } catch (error) {
        console.error(`[SKIP] ${symbol} ${interval} veri alinamadi: ${error.message}`);
      }
    }
  }
  console.log(`${dataBySymbol.size} sembol/TF kombinasyonu icin veri hazir.`);

  const worker = startWorker();
  const results = [];
  let done = 0;
  const totalRuns = GRID.length * dataBySymbol.size * 2;

  try {
    for (const config of GRID) {
      const trainTrades = [];
      const testTrades = [];
      for (const [key, data] of dataBySymbol) {
        const runParams = {
          max_position_pct: 100,
          trade_filters: config.trade_filters,
          htf_regime_filter: config.htf_regime_filter,
        };

        // TRAIN: sadece testCutoff'tan ONCEKI mumlar (gercek disari-sizinti yok)
        done += 1;
        try {
          const instance = `rb_tr_${key.replace('|', '_')}_${Math.random().toString(16).slice(2, 8)}`;
          await worker.request('load', { instance, strategy_file: STRATEGY_FILE, params: runParams });
          const result = await worker.request('backtest', {
            instance, candles: data.trainSlice, initial_capital: 1000, fee_bps: 10, slippage_bps: 2,
            fill_model: 'pessimistic_ohlc', start_time: 0, params: runParams,
          }, 300_000);
          await worker.request('drop', { instance }).catch(() => {});
          for (const t of result.trades || []) trainTrades.push({ pnlPct: t.pnlPct, netPnl: t.netPnl });
        } catch (error) {
          console.error(`[ERR-TRAIN] ${config.label} ${key}: ${error.message}`);
        }

        // TEST: tam veri + start_time=testCutoff (sadece son 91 gunde acilan islemler)
        done += 1;
        try {
          const instance = `rb_te_${key.replace('|', '_')}_${Math.random().toString(16).slice(2, 8)}`;
          await worker.request('load', { instance, strategy_file: STRATEGY_FILE, params: runParams });
          const result = await worker.request('backtest', {
            instance, candles: data.full, initial_capital: 1000, fee_bps: 10, slippage_bps: 2,
            fill_model: 'pessimistic_ohlc', start_time: testCutoff, params: runParams,
          }, 300_000);
          await worker.request('drop', { instance }).catch(() => {});
          for (const t of result.trades || []) testTrades.push({ pnlPct: t.pnlPct, netPnl: t.netPnl });
        } catch (error) {
          console.error(`[ERR-TEST] ${config.label} ${key}: ${error.message}`);
        }

        if (done % 60 === 0 || done === totalRuns) {
          console.log(`[${new Date().toISOString()}] ${done}/${totalRuns} tamamlandi (config: ${config.label})`);
          fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ done, totalRuns }, null, 2));
        }
      }
      results.push({
        label: config.label,
        pattern: config.trade_filters[0].pattern,
        direction: config.trade_filters[0].direction,
        htf_regime_filter: config.htf_regime_filter,
        train: summarize(trainTrades),
        test: summarize(testTrades),
      });
    }
  } finally {
    worker.child.kill();
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT_MD, buildReport(results, symbols));
  try { fs.unlinkSync(PROGRESS_PATH); } catch (_) {}
  console.log(`\nTamamlandi.\nJSON: ${OUT_JSON}\nMD: ${OUT_MD}`);
}

function summarize(trades) {
  const wins = trades.filter((t) => Number.isFinite(t.netPnl) && t.netPnl > 0);
  const losses = trades.filter((t) => Number.isFinite(t.netPnl) && t.netPnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : null);
  return {
    count: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: pf,
    totalPnlPct: trades.reduce((s, t) => s + (Number.isFinite(t.pnlPct) ? t.pnlPct : 0), 0),
  };
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function buildReport(results, symbols) {
  const lines = [];
  lines.push(`# Harmonik Dayaniklilik Aramasi (Train/Test, V2) — ${stamp}`);
  lines.push('');
  lines.push(`Sembol sayisi: ${symbols.length}, TF: ${TIMEFRAMES.join(', ')}`);
  lines.push(`TRAIN donemi: ${FULL_DAYS - TEST_DAYS} gun (${FULL_DAYS} gun once -> ${TEST_DAYS} gun once), TEST donemi: son ${TEST_DAYS} gun (ORTUSMUYOR)`);
  lines.push('');
  lines.push('## Sonuclar (TEST Profit Factor\'a gore siralandi, en az 15 islem sarti her iki donemde)');
  lines.push('');
  lines.push('| Pattern | Yon | Rejim Filtresi | Train N | Train WR% | Train PF | Test N | Test WR% | Test PF | Her ikisi PF>1? |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  [...results]
    .filter((r) => r.train.count >= 15 && r.test.count >= 15)
    .sort((a, b) => (b.test.profitFactor ?? -1) - (a.test.profitFactor ?? -1))
    .forEach((r) => {
      const bothPositive = (r.train.profitFactor ?? 0) > 1 && (r.test.profitFactor ?? 0) > 1;
      lines.push(`| ${r.pattern} | ${r.direction} | ${r.htf_regime_filter} | ${r.train.count} | ${fmt(r.train.winRatePct)} | ${fmt(r.train.profitFactor)} | ${r.test.count} | ${fmt(r.test.winRatePct)} | ${fmt(r.test.profitFactor)} | ${bothPositive ? '**EVET**' : ''} |`);
    });
  lines.push('');
  lines.push('## Dusuk ornekli sonuclar (< 15 islem herhangi bir donemde)');
  lines.push('');
  lines.push('| Pattern | Yon | Rejim Filtresi | Train N | Train PF | Test N | Test PF |');
  lines.push('|---|---|---|---|---|---|---|');
  [...results]
    .filter((r) => r.train.count < 15 || r.test.count < 15)
    .forEach((r) => {
      lines.push(`| ${r.pattern} | ${r.direction} | ${r.htf_regime_filter} | ${r.train.count} | ${fmt(r.train.profitFactor)} | ${r.test.count} | ${fmt(r.test.profitFactor)} |`);
    });
  return lines.join('\n');
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
    const res = await fetchWithRetry(url);
    const raw = await res.json();
    if (!raw.length) break;
    for (const k of raw) {
      all.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    }
    const next = +raw.at(-1)[6] + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(60);
  }
  return [...new Map(all.map((candle) => [candle.t, candle])).values()].sort((a, b) => a.t - b.t);
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 418) {
        await sleep(2000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
      return res;
    } catch (error) {
      lastError = error;
      await sleep(500 * attempt);
    }
  }
  throw lastError || new Error('fetch basarisiz');
}

async function fetchTopUsdtSymbols(limit) {
  const stableOrFiat = new Set([
    'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1',
    'RLUSD', 'XUSD', 'EUR', 'EURI', 'TRY', 'BRL', 'ARS', 'AEUR', 'BFUSD', 'PAXG', 'XAUT',
  ]);
  const res = await fetchWithRetry(new URL('https://api.binance.com/api/v3/ticker/24hr'));
  const tickers = await res.json();
  const ranked = tickers
    .filter((item) => {
      const symbol = String(item.symbol || '');
      if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
      const base = symbol.slice(0, -4);
      if (base.length < 2) return false;
      if (stableOrFiat.has(base)) return false;
      if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
      return Number(item.quoteVolume || 0) > 0;
    })
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0));

  const selected = [];
  for (const ticker of ranked) {
    if (selected.length >= limit) break;
    try {
      const probe = await fetchCandles(ticker.symbol, '1d', 400);
      if (probe.length >= 380) selected.push(ticker.symbol);
    } catch (_) {
      // atla
    }
    await sleep(40);
  }
  return selected;
}

function startWorker() {
  const child = spawn('python', ['-u', WORKER_FILE], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (String(chunk).trim()) process.stderr.write(`[worker] ${chunk}`);
  });
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
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.data);
      else waiter.reject(new Error(msg.error || 'worker error'));
    }
  });
  function request(cmd, payload, timeout = 300_000) {
    const id = `rb_${++seq}`;
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
