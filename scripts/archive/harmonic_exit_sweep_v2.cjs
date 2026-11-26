#!/usr/bin/env node
// V2 arastirma scripti: harmonic_edge_candidates_v2.py (PF>1 cikan pattern alt-kumesi) uzerinde
// cikis parametrelerini (take_profit_mode, stop_loss_target_ratio, min_reward_risk, min_quality)
// tarayip win rate + profit factor'u en iyilestiren konfigurasyonu bulur. Kaba/hizli bir arama
// asamasidir - kazanan config ayrica genis ornekte dogrulanmalidir. Uretim/canli akisla ilgisi yoktur.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SYMBOL_COUNT = 15;
const TIMEFRAME = '1h';
const PERIOD_DAYS = 365;
const STRATEGY_FILE = 'harmonic_edge_candidates_v2.py';
const WORKER_FILE = 'python/workers/pool_worker_v2.py';

const GRID = [];
for (const take_profit_mode of ['target_1', 'target_2']) {
  for (const stop_loss_target_ratio of [0.2, 0.4, 0.6, 1.0]) {
    for (const min_reward_risk of [0.3, 0.5]) {
      for (const min_quality of [0, 60]) {
        GRID.push({ take_profit_mode, stop_loss_mode: 'target_ratio', stop_loss_target_ratio, min_reward_risk, min_quality });
      }
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_JSON = path.resolve(ROOT, `data/harmonic_exit_sweep_v2_${stamp}.json`);
const OUT_MD = path.resolve(ROOT, `data/harmonic_exit_sweep_v2_${stamp}.md`);
const PROGRESS_PATH = path.resolve(ROOT, `data/harmonic_exit_sweep_v2_${stamp}.progress.json`);

main().catch((error) => {
  console.error(`Exit sweep durdu: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  console.log(`[${new Date().toISOString()}] Sembol listesi cekiliyor...`);
  const symbols = await fetchTopUsdtSymbols(SYMBOL_COUNT);
  console.log(`Secilen ${symbols.length} sembol: ${symbols.join(', ')}`);
  console.log(`Grid boyutu: ${GRID.length} config x ${symbols.length} sembol = ${GRID.length * symbols.length} calistirma`);

  console.log('Mum verileri cekiliyor (bir kez, tum configler icin yeniden kullanilacak)...');
  const candlesBySymbol = new Map();
  for (const symbol of symbols) {
    try {
      const candles = await fetchCandles(symbol, TIMEFRAME, PERIOD_DAYS);
      if (candles.length >= 60) candlesBySymbol.set(symbol, candles);
    } catch (error) {
      console.error(`[SKIP] ${symbol} veri alinamadi: ${error.message}`);
    }
  }
  console.log(`${candlesBySymbol.size} sembol icin veri hazir.`);

  const worker = startWorker();
  const results = [];
  let done = 0;
  const totalRuns = GRID.length * candlesBySymbol.size;

  try {
    for (const config of GRID) {
      const configLabel = `tp=${config.take_profit_mode},sl_ratio=${config.stop_loss_target_ratio},rr=${config.min_reward_risk},q=${config.min_quality}`;
      const configTrades = [];
      for (const [symbol, candles] of candlesBySymbol) {
        done += 1;
        const instance = `sw_${symbol}_${Math.random().toString(16).slice(2, 8)}`;
        try {
          const runParams = { max_position_pct: 100, ...config };
          await worker.request('load', { instance, strategy_file: STRATEGY_FILE, params: runParams });
          const result = await worker.request('backtest', {
            instance,
            candles,
            initial_capital: 1000,
            fee_bps: 10,
            slippage_bps: 2,
            fill_model: 'pessimistic_ohlc',
            start_time: Date.now() - PERIOD_DAYS * DAY,
            params: runParams,
          }, 300_000);
          await worker.request('drop', { instance }).catch(() => {});
          for (const t of result.trades || []) {
            configTrades.push({ pnlPct: t.pnlPct, netPnl: t.netPnl });
          }
        } catch (error) {
          console.error(`[ERR] ${configLabel} ${symbol}: ${error.message}`);
        }
        if (done % 40 === 0 || done === totalRuns) {
          console.log(`[${new Date().toISOString()}] ${done}/${totalRuns} tamamlandi (config: ${configLabel})`);
          fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ done, totalRuns }, null, 2));
        }
      }
      const wins = configTrades.filter((t) => Number.isFinite(t.netPnl) && t.netPnl > 0);
      const losses = configTrades.filter((t) => Number.isFinite(t.netPnl) && t.netPnl < 0);
      const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
      const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : null);
      results.push({
        ...config,
        tradeCount: configTrades.length,
        winRatePct: configTrades.length ? (wins.length / configTrades.length) * 100 : null,
        avgPnlPct: configTrades.length ? configTrades.reduce((s, t) => s + (Number.isFinite(t.pnlPct) ? t.pnlPct : 0), 0) / configTrades.length : null,
        profitFactor: pf,
        totalPnlPct: configTrades.reduce((s, t) => s + (Number.isFinite(t.pnlPct) ? t.pnlPct : 0), 0),
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

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function buildReport(results, symbols) {
  const lines = [];
  lines.push(`# Harmonik Cikis Parametresi Taramasi (V2) — ${stamp}`);
  lines.push('');
  lines.push(`Strateji: \`${STRATEGY_FILE}\` (PF>1 pattern alt-kumesi kilitli, cikis parametreleri taraniyor)`);
  lines.push(`Sembol sayisi: ${symbols.length}, Zaman dilimi: ${TIMEFRAME}, Periyot: ${PERIOD_DAYS}g`);
  lines.push('');
  lines.push('## Sonuclar (Profit Factor\'a gore siralandi, en az 20 islem sarti)');
  lines.push('');
  lines.push('| take_profit_mode | sl_ratio | min_rr | min_quality | Islem | WinRate% | Ort.PnL% | PF | Toplam PnL% |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  [...results]
    .filter((r) => r.tradeCount >= 20)
    .sort((a, b) => (b.profitFactor ?? -1) - (a.profitFactor ?? -1))
    .forEach((r) => {
      lines.push(`| ${r.take_profit_mode} | ${r.stop_loss_target_ratio} | ${r.min_reward_risk} | ${r.min_quality} | ${r.tradeCount} | ${fmt(r.winRatePct)} | ${fmt(r.avgPnlPct)} | ${r.profitFactor == null ? 'n/a' : fmt(r.profitFactor)} | ${fmt(r.totalPnlPct)} |`);
    });
  lines.push('');
  lines.push('## Dusuk ornekli sonuclar (< 20 islem)');
  lines.push('');
  lines.push('| take_profit_mode | sl_ratio | min_rr | min_quality | Islem | WinRate% | PF |');
  lines.push('|---|---|---|---|---|---|---|');
  [...results]
    .filter((r) => r.tradeCount < 20)
    .sort((a, b) => b.tradeCount - a.tradeCount)
    .forEach((r) => {
      lines.push(`| ${r.take_profit_mode} | ${r.stop_loss_target_ratio} | ${r.min_reward_risk} | ${r.min_quality} | ${r.tradeCount} | ${fmt(r.winRatePct)} | ${r.profitFactor == null ? 'n/a' : fmt(r.profitFactor)} |`);
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
    const id = `sw_${++seq}`;
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
