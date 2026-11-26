#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(ROOT, args.manifest || 'data/paper_forward_candidates.json');
const baseUrl = String(args.baseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const action = String(args.action || 'report');
const shouldStart = toBool(args.start, false);

main().catch((error) => {
  console.error(`Paper forward manager hatasi: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  validateManifest(manifest);

  if (action === 'provision') {
    const result = await provision(manifest);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action !== 'report') {
    throw new Error(`Bilinmeyen action: ${action}`);
  }

  const report = await buildReport(manifest);
  const jsonPath = path.resolve(ROOT, args.out || 'data/paper_forward_latest.json');
  const mdPath = jsonPath.replace(/\.json$/i, '.md');
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, renderMarkdown(report), 'utf8');
  console.log(`Rapor yazildi: ${jsonPath}`);
  console.log(`Ozet yazildi: ${mdPath}`);
}

async function provision(manifest) {
  const existing = await api('/api/bots');
  const result = { created: [], updated: [], unchanged: [], started: [], warnings: [] };

  for (const candidate of manifest.candidates) {
    const desired = desiredBot(manifest.defaults, candidate);
    let bot = existing.find((item) => item.name === desired.name);

    if (!bot) {
      bot = await api('/api/bots', { method: 'POST', body: desired });
      existing.push(bot);
      result.created.push(summary(bot));
    } else {
      const patch = configPatch(bot, desired);
      if (Object.keys(patch).length === 0) {
        result.unchanged.push(summary(bot));
      } else if (bot.status === 'running' || bot.status === 'paused') {
        result.warnings.push({
          name: bot.name,
          reason: `Ayar farki var fakat bot ${bot.status}; otomatik degistirilmedi.`,
        });
      } else {
        bot = await api(`/api/bots/${bot.id}`, { method: 'PATCH', body: patch });
        result.updated.push(summary(bot));
      }
    }

    if (shouldStart && bot.status !== 'running') {
      const endpoint = bot.status === 'paused' ? 'resume' : 'start';
      const snapshot = await api(`/api/bots/${bot.id}/${endpoint}`, { method: 'POST' });
      bot = snapshot.config;
      result.started.push(summary(bot));
    }
  }

  return result;
}

async function buildReport(manifest) {
  const [bots, workerStats] = await Promise.all([
    api('/api/bots'),
    api('/api/dev/pool/stats').catch(() => null),
  ]);
  const rows = [];

  for (const candidate of manifest.candidates) {
    const bot = bots.find((item) => item.name === candidate.name);
    if (!bot) {
      rows.push({
        key: candidate.key,
        name: candidate.name,
        symbol: candidate.symbol,
        interval: candidate.interval,
        health: { status: 'missing', reasons: ['Paper bot henuz olusturulmamis.'] },
      });
      continue;
    }

    const [snapshot, trades] = await Promise.all([
      api(`/api/bots/${bot.id}`),
      api(`/api/bots/${bot.id}/trades?limit=500`),
    ]);
    rows.push(candidateReport(manifest.defaults, candidate, snapshot, trades));
  }

  return {
    version: 1,
    generatedAt: Date.now(),
    generatedAtIso: new Date().toISOString(),
    baseUrl,
    assumptions: {
      note: 'Paper dolumlari her botun fee_bps ve slippage_bps ayarlariyla hesaplanir.',
      healthIsAdvisory: true,
      autoStopEnabled: false,
    },
    workerStats,
    candidates: rows,
  };
}

function candidateReport(defaults, candidate, snapshot, trades) {
  const bot = snapshot.config;
  const state = snapshot.state;
  const healthConfig = { ...(defaults.health || {}), ...(candidate.health || {}) };
  const sorted = [...trades].sort((a, b) => a.createdAt - b.createdAt);
  const closes = sorted.filter((trade) => Number.isFinite(trade.pnlUsd));
  const totalPnlUsd = sum(closes.map((trade) => trade.pnlUsd));
  const grossProfitUsd = sum(closes.filter((trade) => trade.pnlUsd > 0).map((trade) => trade.pnlUsd));
  const grossLossUsd = Math.abs(sum(closes.filter((trade) => trade.pnlUsd < 0).map((trade) => trade.pnlUsd)));
  const feesUsd = sum(sorted.map((trade) => finite(trade.feeUsd)));
  const estimatedSlippageUsd = sum(sorted.map(slippageFromTrade));
  const elapsedDays = Math.max((Date.now() - bot.createdAt) / 86_400_000, 1 / 24);
  const rollingStart = Date.now() - 7 * 86_400_000;
  const rollingCloses = closes.filter((trade) => trade.createdAt >= rollingStart);
  const rollingDays = Math.min(elapsedDays, 7);
  const rollingPnlUsd = sum(rollingCloses.map((trade) => trade.pnlUsd));
  const maxDrawdownPct = equityDrawdownPct(bot.capitalUsd, closes);
  const totalReturnPct = pct(totalPnlUsd, bot.capitalUsd);
  const dailyReturnPct = compoundDailyPct(totalPnlUsd, bot.capitalUsd, elapsedDays);
  const rollingDailyReturnPct = compoundDailyPct(
    rollingPnlUsd,
    bot.capitalUsd,
    Math.max(rollingDays, 1 / 24)
  );
  const metrics = {
    elapsedDays: round(elapsedDays, 3),
    closedTrades: closes.length,
    winningTrades: closes.filter((trade) => trade.pnlUsd > 0).length,
    losingTrades: closes.filter((trade) => trade.pnlUsd < 0).length,
    winRatePct: closes.length ? round(pct(closes.filter((trade) => trade.pnlUsd > 0).length, closes.length), 2) : null,
    profitFactor: grossLossUsd > 0 ? round(grossProfitUsd / grossLossUsd, 3) : grossProfitUsd > 0 ? null : 0,
    totalPnlUsd: round(totalPnlUsd, 4),
    totalReturnPct: round(totalReturnPct, 4),
    compoundDailyReturnPct: round(dailyReturnPct, 4),
    rolling7dPnlUsd: round(rollingPnlUsd, 4),
    rolling7dDailyReturnPct: round(rollingDailyReturnPct, 4),
    maxDrawdownPct: round(maxDrawdownPct, 4),
    feesUsd: round(feesUsd, 4),
    estimatedSlippageUsd: round(estimatedSlippageUsd, 4),
  };

  return {
    key: candidate.key,
    name: bot.name,
    botId: bot.id,
    symbol: bot.symbol,
    interval: bot.interval,
    strategyId: bot.strategyId,
    status: bot.status,
    capitalUsd: bot.capitalUsd,
    baseline: candidate.baseline || {},
    costs: {
      feeBps: finite(bot.strategyParams?.fee_bps, 10),
      slippageBps: finite(bot.strategyParams?.slippage_bps, 2),
    },
    openPosition: state.position,
    lastSignal: state.lastSignal,
    lastTickAt: state.lastTickAt,
    metrics,
    health: health(metrics, bot, healthConfig),
  };
}

function health(metrics, bot, config) {
  const reasons = [];
  const maxDrawdownPct = finite(config.maximumDrawdownPct, 30);
  const warmupDays = finite(config.warmupDays, 14);
  const warmupClosedTrades = finite(config.warmupClosedTrades, 10);
  const minimumDailyReturnPct = finite(config.minimumDailyReturnPct, 0);
  const targetDailyReturnPct = finite(config.targetDailyReturnPct, 0.8);

  if (bot.status === 'error') {
    return { status: 'stop', reasons: [bot.lastError || 'Bot hata durumunda.'] };
  }
  if (metrics.maxDrawdownPct > maxDrawdownPct) {
    reasons.push(`Maksimum dusus %${metrics.maxDrawdownPct}, sinir %${maxDrawdownPct}.`);
    return { status: 'stop', reasons };
  }
  if (metrics.elapsedDays < warmupDays || metrics.closedTrades < warmupClosedTrades) {
    reasons.push(
      `Isinma: ${metrics.elapsedDays}/${warmupDays} gun, ${metrics.closedTrades}/${warmupClosedTrades} kapanan islem.`
    );
    if (bot.status !== 'running') reasons.push(`Bot durumu: ${bot.status}.`);
    return { status: 'warming_up', reasons };
  }
  if (metrics.rolling7dDailyReturnPct < minimumDailyReturnPct) {
    reasons.push(
      `Son 7 gunluk gunluk getiri %${metrics.rolling7dDailyReturnPct}, alt sinir %${minimumDailyReturnPct}.`
    );
  } else if (metrics.rolling7dDailyReturnPct < targetDailyReturnPct) {
    reasons.push(
      `Son 7 gunluk gunluk getiri %${metrics.rolling7dDailyReturnPct}, hedef %${targetDailyReturnPct}.`
    );
  }
  if (bot.status !== 'running') reasons.push(`Bot durumu: ${bot.status}.`);
  return { status: reasons.length ? 'watch' : 'healthy', reasons };
}

function desiredBot(defaults, candidate) {
  return {
    name: candidate.name,
    symbol: candidate.symbol,
    interval: candidate.interval,
    mode: candidate.mode || defaults.mode || 'paper',
    strategyId: candidate.strategyId,
    strategyParams: {
      ...(defaults.strategyParams || {}),
      ...(candidate.strategyParams || {}),
      forward_candidate_key: candidate.key,
    },
    capitalUsd: candidate.capitalUsd || defaults.capitalUsd || 1000,
    risk: { ...(defaults.risk || {}), ...(candidate.risk || {}) },
  };
}

function configPatch(bot, desired) {
  const patch = {};
  for (const key of ['name', 'symbol', 'interval', 'mode', 'strategyId', 'capitalUsd']) {
    if (!same(bot[key], desired[key])) patch[key] = desired[key];
  }
  if (!same(bot.strategyParams, desired.strategyParams)) patch.strategyParams = desired.strategyParams;
  if (!same(bot.risk, desired.risk)) patch.risk = desired.risk;
  return patch;
}

async function api(endpoint, options = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`);
  }
  return payload?.data ?? payload;
}

function renderMarkdown(report) {
  const lines = [
    '# Paper Forward Son Durum',
    '',
    `Olusturulma: ${report.generatedAtIso}`,
    '',
    ...(report.workerStats
      ? [
          `Worker kapasitesi: ${report.workerStats.alive}/${report.workerStats.size} aktif, ${report.workerStats.instances} strateji instance'i.`,
          '',
        ]
      : []),
    '| Aday | Durum | Saglik | Gun | Islem | Win | Gunluk | Son 7g Gunluk | Max DD | Net PnL |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.candidates) {
    if (!row.metrics) {
      lines.push(`| ${row.name} | yok | ${row.health.status} | - | - | - | - | - | - | - |`);
      continue;
    }
    lines.push(
      `| ${row.name} | ${row.status} | ${row.health.status} | ${row.metrics.elapsedDays} | ${row.metrics.closedTrades} | ${fmtPct(row.metrics.winRatePct)} | ${fmtPct(row.metrics.compoundDailyReturnPct)} | ${fmtPct(row.metrics.rolling7dDailyReturnPct)} | ${fmtPct(row.metrics.maxDrawdownPct)} | $${row.metrics.totalPnlUsd} |`
    );
  }
  lines.push('', '## Saglik Notlari', '');
  for (const row of report.candidates) {
    lines.push(`- **${row.name}:** ${row.health.reasons.length ? row.health.reasons.join(' ') : 'Esiklerin icinde.'}`);
  }
  lines.push(
    '',
    'Saglik durumu tavsiye niteligindedir; arac botlari otomatik durdurmaz.',
    ''
  );
  return lines.join('\n');
}

function equityDrawdownPct(capital, closes) {
  let equity = capital;
  let peak = capital;
  let maxDrawdown = 0;
  for (const trade of closes) {
    equity += trade.pnlUsd;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
  }
  return maxDrawdown;
}

function slippageFromTrade(trade) {
  const meta = trade.meta || {};
  for (const key of ['paperExecutionOpen', 'paperExecutionClose']) {
    const value = meta[key]?.estimatedSlippageUsd;
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function compoundDailyPct(pnl, capital, days) {
  const ratio = 1 + pnl / capital;
  if (ratio <= 0) return -100;
  return (Math.pow(ratio, 1 / days) - 1) * 100;
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.candidates) || manifest.candidates.length === 0) {
    throw new Error('Manifest icinde candidates listesi bulunamadi.');
  }
}

function summary(bot) {
  return { id: bot.id, name: bot.name, status: bot.status };
}

function parseArgs(values) {
  return Object.fromEntries(
    values
      .filter((value) => value.startsWith('--'))
      .map((value) => {
        const [key, ...rest] = value.slice(2).split('=');
        return [key, rest.length ? rest.join('=') : true];
      })
  );
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sum(values) {
  return values.reduce((total, value) => total + finite(value), 0);
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pct(value, total) {
  return total ? (value / total) * 100 : 0;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmtPct(value) {
  return value === null || value === undefined ? '-' : `%${value}`;
}
