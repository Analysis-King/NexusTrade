import { spawn } from 'node:child_process';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('paper-portfolio-supervisor');
const INTERVAL_MS = 30 * 60 * 1000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

type PaperJob = {
  name: string;
  script: string;
  args: string[];
};

const jobs: PaperJob[] = [
  {
    name: 'harmonic_portfolio',
    script: 'harmonic_portfolio_paper.cjs',
    args: ['--action=once', '--days=15'],
  },
  {
    name: 'harmonic_scanner_v2',
    script: 'harmonic_scanner_paper_v2.cjs',
    args: ['--action=once'],
  },
  {
    name: 'harmonic_scanner_htf_confirm',
    script: 'harmonic_scanner_htf_confirm_paper.cjs',
    args: ['--action=once'],
  },
  {
    name: 'harmonic_quality_target_4x',
    script: 'harmonic_portfolio_paper.cjs',
    args: [
      '--action=once',
      '--days=15',
      '--name=Harmonik_QualityTarget_4x',
      '--leverage=4',
      '--positions=2',
      '--score=quality_target',
      '--state=data/harmonic_quality_target_4x_paper_state.json',
      '--report=data/harmonic_quality_target_4x_paper_report.json',
    ],
  },
  {
    name: 'harmonic_quality_target_10x',
    script: 'harmonic_portfolio_paper.cjs',
    args: [
      '--action=once',
      '--days=15',
      '--name=Harmonik_QualityTarget_10x',
      '--leverage=10',
      '--positions=2',
      '--score=quality_target',
      '--state=data/harmonic_quality_target_10x_paper_state.json',
      '--report=data/harmonic_quality_target_10x_paper_report.json',
    ],
  },
];

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startPaperPortfolioSupervisor(): () => void {
  void runAll('startup');
  timer = setInterval(() => {
    void runAll('interval');
  }, INTERVAL_MS);
  timer.unref();

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

async function runAll(reason: string): Promise<void> {
  if (running) {
    log.warn({ reason }, 'Paper portfolio guncellemesi zaten calisiyor');
    return;
  }
  running = true;
  try {
    for (const job of jobs) {
      await runJob(job, reason);
    }
  } finally {
    running = false;
  }
}

function runJob(job: PaperJob, reason: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.resolve(process.cwd(), 'scripts', job.script),
      ...job.args,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      log.error(
        { job: job.name, reason, timeoutMs: JOB_TIMEOUT_MS },
        'Paper portfolio guncellemesi zaman asimina ugradi'
      );
      child.kill();
      finish();
    }, JOB_TIMEOUT_MS);
    timeout.unref();

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      log.error({ err, job: job.name, reason }, 'Paper portfolio guncellemesi baslatilamadi');
      finish();
    });
    child.on('close', (code) => {
      const alreadyRunning =
        stderr.includes('zaten calisiyor') || stdout.includes('zaten calisiyor');
      if (code && !alreadyRunning) {
        log.error({ job: job.name, reason, code, stderr: stderr.trim() }, 'Paper portfolio guncellemesi hata verdi');
      } else {
        log.info({ job: job.name, reason, code }, 'Paper portfolio guncellemesi tamamlandi');
      }
      finish();
    });
  });
}
