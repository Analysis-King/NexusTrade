#!/usr/bin/env node

// Cok sembollu paper portfoy (F1-7). Kurallar backtest ile ayni Python portfoy cekirdeginde;
// ayrinti: scripts/lib/paper_portfolio.cjs ve python/workers/portfolio_core.py.
//
// Yeni portfoy:
//   node scripts/paper_portfolio.cjs --action=create --name=HTF_Onay_Retest \
//     --strategy=harmonic_scanner_v2.py --intervals=1h,4h --confirm-intervals=4h,1d \
//     --symbols=380 --positions=15 --days=90
// Sonra backend'deki supervisor 30 dakikada bir `--action=once` calistirir. Elle:
//   --action=once|start|report|stop --state=data/<ad>_paper_state.json
//   --action=extend --extend-days=30 --state=...
//
// Ayarlar:
//   --strategy           python/strategies altindaki dosya (zorunlu)
//   --intervals          giris periyotlari (varsayilan 1h)
//   --confirm-intervals  ust periyot onayi (bos = onay yok); --confirm-bars (varsayilan 3)
//   --symbols / --list   hacme gore ilk N sembol ya da virgulle liste
//   --positions --leverage --capital --fee-bps --slippage-bps --days
//   --score              target_distance | quality | quality_target
//   --params             strateji parametreleri, JSON
//   --state / --report   varsayilan data/<ad>_paper_state.json ve _report.json

const fs = require('node:fs');
const path = require('node:path');
const lifecycle = require('./lib/paper_lifecycle.cjs');
const portfolio = require('./lib/paper_portfolio.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOUR = 3_600_000;

const args = parseArgs(process.argv.slice(2));
const action = String(args.action || 'once').toLowerCase();
const slug = args.name ? slugify(args.name) : null;
const statePath = path.resolve(ROOT, args.state || (slug ? `data/${slug}_paper_state.json` : ''));
const reportPath = path.resolve(
  ROOT,
  args.report || statePath.replace(/_state\.json$/i, '_report.json'),
);
const lockPath = `${statePath}.lock`;

main().catch((error) => {
  console.error(`Paper portfoy durdu: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  if (!args.state && !slug) throw new Error('--state ya da --name gerekli.');
  if (!/_state\.json$/i.test(statePath)) throw new Error('Durum dosyasi _state.json ile bitmeli.');
  if (!['create', 'start', 'once', 'stop', 'extend', 'report'].includes(action)) {
    throw new Error(`Bilinmeyen action: ${action}`);
  }
  if (action === 'report') {
    printReport(writeReport(readState()));
    return;
  }

  const releaseLock = acquireLock();
  let worker;
  try {
    let state;
    if (action === 'create') {
      if (fs.existsSync(statePath)) throw new Error(`Bu adla bir portfoy zaten var: ${statePath}`);
      const config = portfolio.buildConfig(configFromArgs());
      const symbols = explicitSymbols().length
        ? explicitSymbols()
        : await portfolio.selectSymbols(Math.max(1, Math.floor(Number(args.symbols) || 50)), config);
      state = portfolio.createState(config, symbols, Date.now());
      saveState(state);
      console.log(`Yeni paper portfoy: ${symbols.length} sembol, ${config.durationDays} gun, ${statePath}`);
      console.log('Ilk islem, olusturma anindan sonra kapanan ilk mumdan itibaren.');
    } else {
      state = readState();
      portfolio.validateState(state);
    }

    if (action === 'extend') {
      lifecycle.extendStopAt(state, Number(args['extend-days']), Date.now());
      saveState(state);
      printReport(writeReport(state));
      return;
    }

    worker = portfolio.startWorker();
    const deps = () => ({
      now: Date.now(),
      worker,
      fetchCandles: (symbol, interval, options) =>
        portfolio.fetchBinanceCandles(symbol, interval, options, portfolio.fetchJson),
      log: (line) => console.log(line),
    });

    if (action === 'stop') {
      await portfolio.stopPortfolio(state, deps());
      saveState(state);
      printReport(writeReport(state));
      return;
    }

    do {
      await portfolio.runCycle(state, deps());
      saveState(state);
      printReport(writeReport(state));
      if (action !== 'start' || lifecycle.lifecycleStatus(state, Date.now()) === 'completed') break;
      if (state.status === 'stopped') break;
      const next = Math.floor(Date.now() / HOUR + 1) * HOUR + 15_000;
      const waitMs = Math.max(10_000, next - Date.now());
      console.log(`Sonraki mum bekleniyor: ${new Date(Date.now() + waitMs).toLocaleString('tr-TR')}`);
      await sleep(waitMs);
    } while (true);
  } finally {
    if (worker) worker.close();
    releaseLock();
  }
}

function configFromArgs() {
  return {
    botName: String(args.name || '').replaceAll('_', ' '),
    strategyFile: args.strategy,
    entryIntervals: listArg(args.intervals || '1h'),
    confirmIntervals: listArg(args['confirm-intervals'] || ''),
    confirmBars: args['confirm-bars'],
    durationDays: args.days ?? 30,
    maxPositions: args.positions ?? 10,
    portfolioLeverage: args.leverage ?? 1,
    initialCapital: args.capital ?? 1000,
    feeBps: args['fee-bps'] ?? 10,
    slippageBps: args['slippage-bps'] ?? 2,
    scoreMode: args.score || 'target_distance',
    params: args.params ? JSON.parse(args.params) : {},
  };
}

function explicitSymbols() {
  return listArg(args.list || '').map((symbol) => symbol.toUpperCase());
}

function writeReport(state) {
  const report = portfolio.buildReport(state, Date.now());
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(reportPath.replace(/\.json$/i, '.md'), portfolio.renderMarkdown(report));
  return report;
}

function printReport(report) {
  const m = report.metrics;
  console.log([
    `Durum=${report.status}`,
    `gun=${report.elapsedDays}`,
    `equity=${m.realizedEquity}`,
    `mark=${m.markEquity}`,
    `getiri=${m.totalReturnPct}%`,
    `islem=${m.closedTrades}`,
    `acik=${m.openPositions}`,
    `DD=${m.markMaxDrawdownPct}%`,
    `yerYok=${m.rejectedSignals}`,
    `htfRed=${m.rejectedHtfConfirmations}`,
  ].join(' | '));
  for (const warning of report.warnings) console.log(`UYARI: ${warning}`);
  console.log(`Rapor: ${reportPath}`);
}

function readState() {
  if (!fs.existsSync(statePath)) throw new Error(`Paper portfoy durumu bulunamadi: ${statePath}`);
  const text = fs.readFileSync(statePath, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`);
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
      throw new Error(`Paper portfoy zaten calisiyor (PID ${pid}).`);
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

function parseArgs(values) {
  return Object.fromEntries(values.filter((value) => value.startsWith('--')).map((value) => {
    const [key, ...rest] = value.slice(2).split('=');
    return [key, rest.length ? rest.join('=') : 'true'];
  }));
}

function listArg(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function slugify(value) {
  const text = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!text) throw new Error('--name harf ya da rakam icermeli.');
  return text.endsWith('_paper') ? text.slice(0, -'_paper'.length) : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
