#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const symbols = readSymbols();

const jobs = [
  {
    label: 'Harmonik portfolio',
    prefix: 'harmonic_portfolio_paper',
    script: 'harmonic_portfolio_paper.cjs',
    args: ['--action=start', '--days=15'],
  },
  {
    label: 'Harmonik scanner v2',
    prefix: 'harmonic_scanner_v2_paper',
    script: 'harmonic_scanner_paper_v2.cjs',
    args: ['--action=start'],
  },
  {
    label: 'Harmonik scanner HTF confirm',
    prefix: 'harmonic_scanner_htf_confirm_paper',
    script: 'harmonic_scanner_htf_confirm_paper.cjs',
    args: ['--action=start'],
  },
  {
    label: 'Harmonik QualityTarget 4x',
    prefix: 'harmonic_quality_target_4x_paper',
    script: 'harmonic_portfolio_paper.cjs',
    args: [
      '--action=start',
      '--days=15',
      '--name=Harmonik_QualityTarget_4x',
      '--leverage=4',
      '--positions=2',
      '--score=quality_target',
      '--state=data/harmonic_quality_target_4x_paper_state.json',
      '--report=data/harmonic_quality_target_4x_paper_report.json',
      ...symbolsArg(symbols),
    ],
  },
  {
    label: 'Harmonik QualityTarget 10x',
    prefix: 'harmonic_quality_target_10x_paper',
    script: 'harmonic_portfolio_paper.cjs',
    args: [
      '--action=start',
      '--days=15',
      '--name=Harmonik_QualityTarget_10x',
      '--leverage=10',
      '--positions=2',
      '--score=quality_target',
      '--state=data/harmonic_quality_target_10x_paper_state.json',
      '--report=data/harmonic_quality_target_10x_paper_report.json',
      ...symbolsArg(symbols),
    ],
  },
];

for (const job of jobs) {
  startJob(job);
}

function startJob(job) {
  const lockPath = path.join(DATA, `${job.prefix}_state.json.lock`);
  if (hasLiveLock(lockPath)) {
    console.log(`${job.label} zaten calisiyor.`);
    return;
  }

  fs.mkdirSync(DATA, { recursive: true });
  const stdout = fs.openSync(path.join(DATA, `${job.prefix}_stdout.log`), 'a');
  const stderr = fs.openSync(path.join(DATA, `${job.prefix}_stderr.log`), 'a');
  const child = spawn(process.execPath, [
    path.join(ROOT, 'scripts', job.script),
    ...job.args,
  ], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
  });
  child.unref();
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  console.log(`${job.label} baslatildi (PID ${child.pid}).`);
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

function readSymbols() {
  const sourceReport = path.join(DATA, 'harmonic_portfolio_paper_report.json');
  if (!fs.existsSync(sourceReport)) return [];
  try {
    const report = JSON.parse(stripBom(fs.readFileSync(sourceReport, 'utf8')));
    return Array.isArray(report.symbols)
      ? report.symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function symbolsArg(values) {
  return values.length ? [`--list=${values.join(',')}`] : [];
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
