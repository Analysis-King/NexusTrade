const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const OUTPUT_STEM = process.argv[2] || 'multi_strategy_50_symbol_comparison_20260613';

const SOURCES = [
  ['Donchian RR3.5', 'donchian_rr35_paper_top50_90d_warmup180_20260613.json'],
  ['DEMA Long', 'multi50_dema_90d_warmup180_20260613.json'],
  ['Trend ATR', 'multi50_trend_atr_90d_warmup180_20260613.json'],
  ['MOST 5/2', 'multi50_most_90d_warmup180_20260613.json'],
  ['Bollinger Squeeze', 'multi50_bollinger_90d_warmup180_20260613.json'],
  ['Mined Reversal', 'multi50_mined_90d_warmup180_20260613.json'],
  ['SMC Swing CHoCH', 'multi50_smc_90d_warmup180_20260613.json'],
  ['Supply/Demand', 'multi50_supply_demand_90d_warmup180_20260613.json'],
  ['Orphan Market Reader', 'multi50_orphan_90d_warmup180_20260613.json'],
];

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function dailyCompoundPct(totalReturnPct, days) {
  const growth = 1 + totalReturnPct / 100;
  if (!(growth > 0) || !(days > 0)) return null;
  return (growth ** (1 / days) - 1) * 100;
}

function rowFromWindow(strategy, source, window) {
  const totalReturnPct = Number(window.summary?.totalReturnPct || 0);
  const days = Number(window.windowDays || source.lookbackDays || 90);
  return {
    strategy,
    strategyFile: source.strategyFile,
    symbol: window.symbol,
    interval: window.interval,
    days,
    totalReturnPct,
    dailySimplePct: totalReturnPct / days,
    dailyCompoundPct: dailyCompoundPct(totalReturnPct, days),
    maxDrawdownPct: Number(window.summary?.maxDrawdownPct || 0),
    trades: Number(window.summary?.totalTrades || 0),
    winRatePct: Number(window.summary?.winRatePct || 0),
    profitFactor: Number(window.summary?.profitFactor || 0),
  };
}

function strategySummary(strategy, source, rows) {
  const sorted = [...rows].sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  const positive = rows.filter((row) => row.totalReturnPct > 0);
  const active = rows.filter((row) => row.trades > 0);
  const target08 = rows.filter((row) => Number(row.dailyCompoundPct) >= 0.8);
  const target05 = rows.filter((row) => Number(row.dailyCompoundPct) >= 0.5);
  const blown = rows.filter((row) => row.totalReturnPct <= -100);
  return {
    strategy,
    strategyFile: source.strategyFile,
    symbols: rows.length,
    activeSymbols: active.length,
    positiveSymbols: positive.length,
    positivePct: round(positive.length / rows.length * 100, 2),
    target08Symbols: target08.length,
    target05Symbols: target05.length,
    blownSymbols: blown.length,
    avgReturnPct: round(mean(rows.map((row) => row.totalReturnPct)), 2),
    medianReturnPct: round(median(rows.map((row) => row.totalReturnPct)), 2),
    avgDailySimplePct: round(mean(rows.map((row) => row.dailySimplePct)), 4),
    medianDailySimplePct: round(median(rows.map((row) => row.dailySimplePct)), 4),
    avgDailyCompoundPct: round(mean(rows.map((row) => row.dailyCompoundPct)), 4),
    medianDailyCompoundPct: round(median(rows.map((row) => row.dailyCompoundPct)), 4),
    avgMaxDrawdownPct: round(mean(rows.map((row) => row.maxDrawdownPct)), 2),
    medianMaxDrawdownPct: round(median(rows.map((row) => row.maxDrawdownPct)), 2),
    totalTrades: rows.reduce((sum, row) => sum + row.trades, 0),
    bestSymbol: sorted[0]?.symbol || null,
    bestReturnPct: round(sorted[0]?.totalReturnPct, 2),
    bestDailyCompoundPct: round(sorted[0]?.dailyCompoundPct, 4),
    worstSymbol: sorted.at(-1)?.symbol || null,
    worstReturnPct: round(sorted.at(-1)?.totalReturnPct, 2),
  };
}

function markdown(report) {
  const lines = [];
  lines.push('# 50 Sembol Coklu Strateji Karsilastirmasi');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('Kosullar: 1h, son 90 gun, 180 gun warmup, 1000 USDT, 2x, maks 2000 USDT pozisyon, 10 bps komisyon, 2 bps slippage.');
  lines.push('');
  lines.push('## Strateji Ozeti');
  lines.push('');
  lines.push('| Strateji | Pozitif | >=0.8%/gun | >=0.5%/gun | Batik | Ort. Getiri % | Medyan % | Ort. Gunluk Basit % | Medyan Gunluk Basit % | Ort. DD % | Islem | En Iyi |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const row of report.strategies) {
    lines.push(`| ${row.strategy} | ${row.positiveSymbols}/${row.symbols} | ${row.target08Symbols} | ${row.target05Symbols} | ${row.blownSymbols} | ${row.avgReturnPct} | ${row.medianReturnPct} | ${row.avgDailySimplePct} | ${row.medianDailySimplePct} | ${row.avgMaxDrawdownPct} | ${row.totalTrades} | ${row.bestSymbol} ${row.bestReturnPct}% |`);
  }
  lines.push('');
  lines.push('## Sembol Bazinda En Iyi Strateji');
  lines.push('');
  lines.push('| Sembol | Strateji | Getiri % | Gunluk Bilesik % | DD % | Islem |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const row of report.bestBySymbol) {
    lines.push(`| ${row.symbol} | ${row.strategy} | ${round(row.totalReturnPct, 2)} | ${round(row.dailyCompoundPct, 4)} | ${round(row.maxDrawdownPct, 2)} | ${row.trades} |`);
  }
  lines.push('');
  lines.push('## En Iyi 30 Strateji-Sembol Eslesmesi');
  lines.push('');
  lines.push('| # | Sembol | Strateji | Getiri % | Gunluk Bilesik % | DD % | Islem |');
  lines.push('|---:|---|---|---:|---:|---:|---:|');
  report.topPairs.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.symbol} | ${row.strategy} | ${round(row.totalReturnPct, 2)} | ${round(row.dailyCompoundPct, 4)} | ${round(row.maxDrawdownPct, 2)} | ${row.trades} |`);
  });
  return `${lines.join('\n')}\n`;
}

const loaded = SOURCES.map(([strategy, filename]) => {
  const source = JSON.parse(fs.readFileSync(path.join(DATA, filename), 'utf8'));
  const rows = source.results
    .filter((window) => !window.error && window.summary)
    .map((window) => rowFromWindow(strategy, source, window));
  return { strategy, filename, source, rows };
});

const allRows = loaded.flatMap((item) => item.rows);
const symbols = [...new Set(allRows.map((row) => row.symbol))].sort();
const bestBySymbol = symbols.map((symbol) => (
  allRows.filter((row) => row.symbol === symbol).sort((a, b) => b.totalReturnPct - a.totalReturnPct)[0]
));

const report = {
  generatedAt: new Date().toISOString(),
  conditions: {
    interval: '1h',
    reportDays: 90,
    warmupDays: 180,
    capitalUsd: 1000,
    leverage: 2,
    maxPositionUsd: 2000,
    feeBps: 10,
    slippageBps: 2,
  },
  sources: loaded.map(({ strategy, filename, source }) => ({
    strategy,
    filename,
    strategyFile: source.strategyFile,
  })),
  strategies: loaded
    .map(({ strategy, source, rows }) => strategySummary(strategy, source, rows))
    .sort((a, b) => b.medianDailySimplePct - a.medianDailySimplePct),
  bestBySymbol: bestBySymbol.sort((a, b) => b.totalReturnPct - a.totalReturnPct),
  topPairs: [...allRows].sort((a, b) => b.totalReturnPct - a.totalReturnPct).slice(0, 30),
  allRows,
};

fs.writeFileSync(path.join(DATA, `${OUTPUT_STEM}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(DATA, `${OUTPUT_STEM}.md`), markdown(report));
console.table(report.strategies);
console.log(`JSON: ${path.join(DATA, `${OUTPUT_STEM}.json`)}`);
console.log(`MD: ${path.join(DATA, `${OUTPUT_STEM}.md`)}`);
