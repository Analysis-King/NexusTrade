#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const sourceReport = path.join(ROOT, 'data', 'harmonic_portfolio_paper_report.json');

if (!fs.existsSync(sourceReport)) {
  throw new Error(`Sembol kaynagi bulunamadi: ${sourceReport}`);
}

const symbols = JSON.parse(fs.readFileSync(sourceReport, 'utf8')).symbols;
if (!Array.isArray(symbols) || symbols.length === 0) {
  throw new Error('Paper botlar icin sembol listesi bos.');
}

const sharedArgs = [
  path.join(ROOT, 'scripts', 'harmonic_portfolio_paper.cjs'),
  '--action=start',
  '--days=15',
  '--positions=2',
  '--score=quality_target',
  `--list=${symbols.join(',')}`,
];

for (const leverage of [4, 10]) {
  const prefix = `harmonic_quality_target_${leverage}x_paper`;
  const lockPath = path.join(ROOT, 'data', `${prefix}_state.json.lock`);
  if (hasLiveLock(lockPath)) {
    console.log(`${leverage}x harmonik paper bot zaten calisiyor.`);
    continue;
  }
  const stdout = fs.openSync(path.join(ROOT, 'data', `${prefix}_stdout.log`), 'a');
  const stderr = fs.openSync(path.join(ROOT, 'data', `${prefix}_stderr.log`), 'a');
  const child = spawn(process.execPath, [
    ...sharedArgs,
    `--name=Harmonik_QualityTarget_${leverage}x`,
    `--leverage=${leverage}`,
    `--state=data/${prefix}_state.json`,
    `--report=data/${prefix}_report.json`,
  ], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
  });
  child.unref();
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  console.log(`${leverage}x harmonik paper bot baslatildi (PID ${child.pid}).`);
}

function hasLiveLock(lockPath) {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    process.kill(pid, 0);
    return true;
  } catch {
    fs.rmSync(lockPath, { force: true });
    return false;
  }
}
