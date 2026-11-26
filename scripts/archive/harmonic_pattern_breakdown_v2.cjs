#!/usr/bin/env node
// V2 arastirma scripti: harmonic_all_patterns_v2.py (tum pattern/yon/zigzag serbest) ile backtest
// calistirip TUM islemleri (meta.pattern/direction dahil) toplar, ardindan pattern bazinda
// win rate / profit factor / ort. islem getirisi kirilimi cikarir. Amac: hangi pattern alt-kumesinin
// gercekten pozitif edge'e sahip oldugunu (yeterli ornek boyutuyla) bulmak. Uretim/canli akisla ilgisi yoktur.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SYMBOL_COUNT = 30;
const TIMEFRAMES = ['1h', '4h'];
const PERIODS = [
  { label: '1y', days: 365 },
  { label: '3m', days: 91 },
];
const MAX_DAYS = Math.max(...PERIODS.map((p) => p.days));
const STRATEGY_FILE = 'harmonic_all_patterns_v2.py';
const WORKER_FILE = 'python/workers/pool_worker_v2.py';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_JSON = path.resolve(ROOT, `data/harmonic_pattern_breakdown_v2_${stamp}.json`);
const OUT_MD = path.resolve(ROOT, `data/harmonic_pattern_breakdown_v2_${stamp}.md`);
const PROGRESS_PATH = path.resolve(ROOT, `data/harmonic_pattern_breakdown_v2_${stamp}.progress.json`);

main().catch((error) => {
  console.error(`Pattern breakdown durdu: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  console.log(`[${new Date().toISOString()}] Sembol listesi cekiliyor...`);
  const symbols = await fetchTopUsdtSymbols(SYMBOL_COUNT);
  console.log(`Secilen ${symbols.length} sembol: ${symbols.join(', ')}`);

  const worker = startWorker();
  const allTrades = []; // her trade: {symbol, interval, period, pattern, direction, zigzagLength, pnlPct, won}
  const runMeta = [];
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
          done += PERIODS.length;
          continue;
        }

        for (const period of PERIODS) {
          done += 1;
          const startTime = Date.now() - period.days * DAY;
          const instance = `pb_${symbol}_${interval}_${period.label}_${Math.random().toString(16).slice(2, 8)}`;
          try {
            const runParams = { max_position_pct: 100 };
            await worker.request('load', { instance, strategy_file: STRATEGY_FILE, params: runParams });
            const result = await worker.request('backtest', {
              instance,
              candles,
              initial_capital: 1000,
              fee_bps: 10,
              slippage_bps: 2,
              fill_model: 'pessimistic_ohlc',
              start_time: startTime,
              params: runParams,
            }, 300_000);
            await worker.request('drop', { instance }).catch(() => {});
            const trades = result.trades || [];
            for (const t of trades) {
              const meta = t.meta || {};
              allTrades.push({
                symbol,
                interval,
                period: period.label,
                pattern: meta.pattern || 'BILINMEYEN',
                direction: meta.direction || (t.side === 'long' ? 'bullish' : 'bearish'),
                zigzagLength: meta.zigzag_length ?? null,
                side: t.side,
                pnlPct: t.pnlPct,
                netPnl: t.netPnl,
                reason: t.reason,
              });
            }
            runMeta.push({ symbol, interval, period: period.label, totalTrades: trades.length });
          } catch (error) {
            console.error(`[ERR] ${symbol} ${interval} ${period.label}: ${error.message}`);
          }
          if (done % 10 === 0 || done === totalRuns) {
            console.log(`[${new Date().toISOString()}] ${done}/${totalRuns} tamamlandi (son: ${symbol} ${interval} ${period.label}, toplanan islem: ${allTrades.length})`);
            fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ done, totalRuns, tradeCount: allTrades.length }, null, 2));
          }
        }
      }
    }
  } finally {
    worker.child.kill();
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({ runMeta, trades: allTrades }, null, 2));
  fs.writeFileSync(OUT_MD, buildReport(allTrades, symbols));
  try { fs.unlinkSync(PROGRESS_PATH); } catch (_) {}
  console.log(`\nTamamlandi. Toplam islem: ${allTrades.length}\nJSON: ${OUT_JSON}\nMD: ${OUT_MD}`);
}

function average(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((sum, v) => sum + v, 0) / nums.length : null;
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function buildReport(trades, symbols) {
  const lines = [];
  lines.push(`# Harmonik Pattern Kirilimi (V2) — ${stamp}`);
  lines.push('');
  lines.push(`Strateji: \`${STRATEGY_FILE}\` (tum pattern/yon/zigzag serbest), Motor: \`${WORKER_FILE}\``);
  lines.push(`Sembol sayisi: ${symbols.length}, Zaman dilimleri: ${TIMEFRAMES.join(', ')}, Periyotlar: ${PERIODS.map((p) => p.label).join(', ')}`);
  lines.push(`Ayarlar: initial_capital=1000, fee_bps=10, slippage_bps=2, leverage=1, max_position_pct=100, fill_model=pessimistic_ohlc`);
  lines.push(`Toplam islem sayisi (tum pattern/sembol/periyotlar): ${trades.length}`);
  lines.push('');
  lines.push('## Pattern + Yon Bazinda Kirilim (en az 5 islem sarti, Profit Factor\'a gore siralandi)');
  lines.push('');
  lines.push('| Pattern | Yon | Islem Sayisi | WinRate % | Ort. PnL % | Profit Factor | Toplam PnL % (basit toplam) |');
  lines.push('|---|---|---|---|---|---|---|');

  const groups = new Map();
  for (const t of trades) {
    const key = `${t.pattern}|||${t.direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const rows = [];
  for (const [key, list] of groups) {
    const [pattern, direction] = key.split('|||');
    const wins = list.filter((t) => Number.isFinite(t.netPnl) && t.netPnl > 0);
    const losses = list.filter((t) => Number.isFinite(t.netPnl) && t.netPnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : null);
    rows.push({
      pattern, direction,
      count: list.length,
      winRate: (wins.length / list.length) * 100,
      avgPnl: average(list.map((t) => t.pnlPct)),
      pf,
      totalPnl: list.reduce((s, t) => s + (Number.isFinite(t.pnlPct) ? t.pnlPct : 0), 0),
    });
  }

  rows
    .filter((r) => r.count >= 5)
    .sort((a, b) => (b.pf ?? -1) - (a.pf ?? -1))
    .forEach((r) => {
      lines.push(`| ${r.pattern} | ${r.direction} | ${r.count} | ${fmt(r.winRate)} | ${fmt(r.avgPnl)} | ${r.pf == null ? 'n/a' : fmt(r.pf)} | ${fmt(r.totalPnl)} |`);
    });

  lines.push('');
  lines.push('## Ornek boyutu az olanlar (< 5 islem, guvenilir degil - referans amacli)');
  lines.push('');
  lines.push('| Pattern | Yon | Islem Sayisi | WinRate % | Ort. PnL % |');
  lines.push('|---|---|---|---|---|');
  rows
    .filter((r) => r.count < 5)
    .sort((a, b) => b.count - a.count)
    .forEach((r) => {
      lines.push(`| ${r.pattern} | ${r.direction} | ${r.count} | ${fmt(r.winRate)} | ${fmt(r.avgPnl)} |`);
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
    const id = `pb_${++seq}`;
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
