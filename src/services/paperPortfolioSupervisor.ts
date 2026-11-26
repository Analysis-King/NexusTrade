import { spawn } from 'node:child_process';
import path from 'node:path';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('paper-portfolio-supervisor');
const INTERVAL_MS = 30 * 60 * 1000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

type PaperJob = {
  name: string;
  script: string;
  args: string[];
  /** data/ altindaki rapor dosyasi; arayuz portfoyu bu adla tanir. */
  reportFile: string;
};

type JobResult = {
  ok: boolean;
  error?: string;
};

export type PaperPortfolioAction = 'stop' | 'extend';

export type PaperPortfolioActionState = {
  action: PaperPortfolioAction;
  status: 'pending' | 'failed';
  requestedAt: number;
  error?: string;
};

const jobs: PaperJob[] = [
  {
    name: 'harmonic_portfolio',
    script: 'harmonic_portfolio_paper.cjs',
    args: ['--action=once', '--days=15'],
    reportFile: 'harmonic_portfolio_paper_report.json',
  },
  {
    name: 'harmonic_scanner_v2',
    script: 'harmonic_scanner_paper_v2.cjs',
    args: ['--action=once'],
    reportFile: 'harmonic_scanner_v2_paper_report.json',
  },
  {
    name: 'harmonic_scanner_htf_confirm',
    script: 'harmonic_scanner_htf_confirm_paper.cjs',
    args: ['--action=once'],
    reportFile: 'harmonic_scanner_htf_confirm_paper_report.json',
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
    reportFile: 'harmonic_quality_target_4x_paper_report.json',
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
    reportFile: 'harmonic_quality_target_10x_paper_report.json',
  },
];

let timer: NodeJS.Timeout | null = null;
let running = false;

// Ayni portfoyun script'leri ayni state dosyasini kilitler; dongu ve elle verilen
// komutlar (durdur/uzat) portfoy basina sirayla calisir.
const jobQueues = new Map<string, Promise<void>>();
const actionStates = new Map<string, PaperPortfolioActionState>();

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

/** Supervisor'in yonettigi portfoy mu (durdur/uzat verilebilir mi)? */
export function isManagedPaperPortfolio(reportFile: string): boolean {
  return jobs.some((job) => job.reportFile === reportFile);
}

export function getPaperPortfolioActionState(
  reportFile: string
): PaperPortfolioActionState | undefined {
  return actionStates.get(reportFile);
}

/**
 * Durdur: acik pozisyonlar son fiyattan kapatilir, portfoy bir daha islem acmaz.
 * Uzat: planlanan bitis `extendDays` gun ileri alinir, portfoy yeniden islem acar.
 * Komut kuyruga alinir; sonucu portfoy listesinde (pendingAction/actionError) gorunur.
 */
export function requestPaperPortfolioAction(
  reportFile: string,
  action: PaperPortfolioAction,
  extendDays?: number
): void {
  const job = jobs.find((item) => item.reportFile === reportFile);
  if (!job) throw new NotFoundError('Paper portfoy');
  if (actionStates.get(reportFile)?.status === 'pending') {
    throw new ConflictError('Bu portfoy icin bekleyen bir komut var');
  }

  const requestedAt = Date.now();
  actionStates.set(reportFile, { action, status: 'pending', requestedAt });
  const args = job.args.map((arg) => (arg.startsWith('--action=') ? `--action=${action}` : arg));
  if (action === 'extend') args.push(`--extend-days=${extendDays}`);

  void enqueue(job, async () => {
    const result = await runJob(job, args, `action:${action}`);
    if (result.ok) {
      actionStates.delete(reportFile);
    } else {
      actionStates.set(reportFile, { action, status: 'failed', requestedAt, error: result.error });
    }
  });
}

function enqueue(job: PaperJob, task: () => Promise<void>): Promise<void> {
  const previous = jobQueues.get(job.name) ?? Promise.resolve();
  const next = previous.then(task, task);
  jobQueues.set(job.name, next.catch(() => undefined));
  return next;
}

async function runAll(reason: string): Promise<void> {
  if (running) {
    log.warn({ reason }, 'Paper portfolio guncellemesi zaten calisiyor');
    return;
  }
  running = true;
  try {
    for (const job of jobs) {
      await enqueue(job, async () => {
        await runJob(job, job.args, reason);
      });
    }
  } finally {
    running = false;
  }
}

function runJob(job: PaperJob, args: string[], reason: string): Promise<JobResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.resolve(process.cwd(), 'scripts', job.script),
      ...args,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: JobResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      log.error(
        { job: job.name, reason, timeoutMs: JOB_TIMEOUT_MS },
        'Paper portfolio guncellemesi zaman asimina ugradi'
      );
      child.kill();
      finish({ ok: false, error: 'Zaman asimi' });
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
      finish({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      const alreadyRunning =
        stderr.includes('zaten calisiyor') || stdout.includes('zaten calisiyor');
      if (code && !alreadyRunning) {
        log.error({ job: job.name, reason, code, stderr: stderr.trim() }, 'Paper portfolio guncellemesi hata verdi');
      } else {
        log.info({ job: job.name, reason, code }, 'Paper portfolio guncellemesi tamamlandi');
      }
      finish(code === 0 ? { ok: true } : { ok: false, error: scriptErrorMessage(stderr, code) });
    });
  });
}

// Script hatasi "Harmonik paper testi durdu: Error: <mesaj>\n    at ..." seklinde gelir.
function scriptErrorMessage(stderr: string, code: number | null): string {
  const firstLine = stderr.trim().split(/\r?\n/)[0] ?? '';
  const message = firstLine.replace(/^.*?durdu:\s*/, '').replace(/^Error:\s*/, '').trim();
  return message || `Script ${code ?? '?'} koduyla cikti`;
}
