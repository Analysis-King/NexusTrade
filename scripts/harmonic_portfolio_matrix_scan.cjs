#!/usr/bin/env node
// Harmonik Portfoy stratejisini (harmonic_portfolio_candidate.py) 50 sembol x 4 zaman dilimi x 4 periyot
// matrisinde backtest eden tek seferlik arastirma scripti. Uretim/canli akisla ilgisi yoktur.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SYMBOL_COUNT = 50;
const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
const PERIODS = [
  { label: '2y', days: 730 },
  { label: '1y', days: 365 },
  { label: '6m', days: 182 },
  { label: '3m', days: 91 },
];
const MAX_DAYS = Math.max(...PERIODS.map((p) => p.days));
const STRATEGY_FILE = 'harmonic_portfolio_candidate.py';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_JSON = path.resolve(ROOT, `data/harmonic_portfolio_matrix_${stamp}.json`);
const OUT_MD = path.resolve(ROOT, `data/harmonic_portfolio_matrix_${stamp}.md`);
const PROGRESS_PATH = path.resolve(ROOT, `data/harmonic_portfolio_matrix_${stamp}.progress.json`);

main().catch((error) => {
  console.error(`Matrix scan durdu: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  console.log(`[${new Date().toISOString()}] Sembol listesi cekiliyor...`);
  const symbols = await fetchTopUsdtSymbols(SYMBOL_COUNT);
  console.log(`Secilen ${symbols.length} sembol: ${symbols.join(', ')}`);

  const worker = startWorker();
  const results = [];
  let done = 0;
  const totalRuns = symbols.length * TIMEFRAMES.length * PERIODS.length;

  try {
    for (const symbol of symbols) {
      for (const interval of TIMEFRAMES) {
        let candles;
        try {
          candles = await fetchCandles(symbol, interval, MAX_DAYS);
        } catch (error) {
          console.error(`[SKIP] ${symbol} ${interval} veri alinamadi: ${error.message}`);
          done += PERIODS.length;
          continue;
        }
        if (candles.length < 60) {
          console.error(`[SKIP] ${symbol} ${interval} yetersiz mum (${candles.length})`);
          done += PERIODS.length;
          continue;
        }
        const firstT = candles[0].t;
        const lastT = candles.at(-1).t;
        const actualDays = Math.round((lastT - firstT) / DAY);

        for (const period of PERIODS) {
          done += 1;
          const startTime = Date.now() - period.days * DAY;
          const instance = `mx_${symbol}_${interval}_${period.label}_${Math.random().toString(16).slice(2, 8)}`;
          try {
            await worker.request('load', { instance, strategy_file: STRATEGY_FILE, params: {} });
            const result = await worker.request('backtest', {
              instance,
              candles,
              initial_capital: 1000,
              fee_bps: 10,
              slippage_bps: 2,
              fill_model: 'pessimistic_ohlc',
              start_time: startTime,
              params: {},
            }, 600_000);
            await worker.request('drop', { instance }).catch(() => {});
            const summary = result.summary || {};
            results.push({
              symbol,
              interval,
              period: period.label,
              nominalDays: period.days,
              dataCoverageDays: actualDays,
              candleCount: candles.length,
              totalReturnPct: summary.totalReturnPct ?? null,
              finalCapital: summary.finalCapital ?? null,
              maxDrawdownPct: summary.maxDrawdownPct ?? null,
              winRatePct: summary.winRatePct ?? null,
              profitFactor: summary.profitFactor ?? null,
              sharpe: summary.sharpe ?? null,
              totalTrades: summary.totalTrades ?? null,
              avgTradePct: summary.avgTradePct ?? null,
              bestTradePct: summary.bestTradePct ?? null,
              worstTradePct: summary.worstTradePct ?? null,
            });
          } catch (error) {
            console.error(`[ERR] ${symbol} ${interval} ${period.label}: ${error.message}`);
            results.push({
              symbol, interval, period: period.label, nominalDays: period.days,
              dataCoverageDays: actualDays, candleCount: candles.length, error: error.message,
            });
          }
          if (done % 20 === 0 || done === totalRuns) {
            console.log(`[${new Date().toISOString()}] ${done}/${totalRuns} tamamlandi (son: ${symbol} ${interval} ${period.label})`);
            fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ done, totalRuns, results }, null, 2));
          }
        }
      }
    }
  } finally {
    worker.child.kill();
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT_MD, buildReport(results, symbols));
  try { fs.unlinkSync(PROGRESS_PATH); } catch (_) {}
  console.log(`\nTamamlandi. JSON: ${OUT_JSON}\nMD: ${OUT_MD}`);
}

function average(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((sum, v) => sum + v, 0) / nums.length : null;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function buildReport(results, symbols) {
  const lines = [];
  lines.push(`# Harmonik Portfoy Matrix Backtest — ${stamp}`);
  lines.push('');
  lines.push(`Strateji: \`${STRATEGY_FILE}\` (harmonic_portfolio_candidate.py, kilitli trade_filters ile pine_harmonic_patterns.py cekirdegini kullanir)`);
  lines.push(`Sembol sayisi: ${symbols.length} (Binance USDT ciftleri, 24s hacme gore siralanmis)`);
  lines.push(`Ayarlar: initial_capital=1000, fee_bps=10, slippage_bps=2, leverage=1, fill_model=pessimistic_ohlc, start_time ile periyot kesimi (zigzag warmup icin tam gecmis kullanilir)`);
  lines.push('');
  lines.push('## Ozet Matris (tum semboller uzerinden ortalama)');
  lines.push('');
  lines.push('| Zaman Dilimi | Periyot | Ort. Getiri % | Medyan Getiri % | Ort. WinRate % | Ort. Trade Sayisi | Ort. Max DD % | Karli Sembol % | Hata |');
  lines.push('|---|---|---|---|---|---|---|---|---|');

  for (const interval of TIMEFRAMES) {
    for (const period of PERIODS) {
      const rows = results.filter((r) => r.interval === interval && r.period === period.label && !r.error);
      const errCount = results.filter((r) => r.interval === interval && r.period === period.label && r.error).length;
      const rets = rows.map((r) => r.totalReturnPct);
      const profitable = rows.filter((r) => Number.isFinite(r.totalReturnPct) && r.totalReturnPct > 0).length;
      lines.push(`| ${interval} | ${period.label} | ${fmt(average(rets))} | ${fmt(median(rets))} | ${fmt(average(rows.map((r) => r.winRatePct)))} | ${fmt(average(rows.map((r) => r.totalTrades)), 1)} | ${fmt(average(rows.map((r) => r.maxDrawdownPct)))} | ${rows.length ? fmt((profitable / rows.length) * 100, 0) : 'n/a'} | ${errCount || ''} |`);
    }
  }

  lines.push('');
  lines.push('## Ham Sonuclar (sembol bazinda)');
  lines.push('');
  lines.push('| Sembol | TF | Periyot | Getiri % | WinRate % | Trades | MaxDD % | PF | Kapsam(g) |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.symbol} | ${r.interval} | ${r.period} | HATA: ${r.error} | | | | | |`);
      continue;
    }
    lines.push(`| ${r.symbol} | ${r.interval} | ${r.period} | ${fmt(r.totalReturnPct)} | ${fmt(r.winRatePct)} | ${r.totalTrades} | ${fmt(r.maxDrawdownPct)} | ${r.profitFactor ?? 'n/a'} | ${r.dataCoverageDays} |`);
  }
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
      const probe = await fetchCandles(ticker.symbol, '1d', 60);
      if (probe.length >= 50) selected.push(ticker.symbol);
    } catch (_) {
      // atla
    }
    await sleep(40);
  }
  return selected;
}

function startWorker() {
  const child = spawn('python', ['-u', 'python/workers/pool_worker.py'], {
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
  function request(cmd, payload, timeout = 120_000) {
    const id = `mx_${++seq}`;
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
