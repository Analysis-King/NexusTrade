import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import {
  getPaperPortfolioActionState,
  isManagedPaperPortfolio,
  requestPaperPortfolioAction,
} from '../services/paperPortfolioSupervisor.js';
import { asyncHandler } from './middleware.js';

export const paperPortfolioRouter = Router();

const extendSchema = z.object({
  days: z.number().int().min(1).max(365),
});

type PaperPortfolioFile = Record<string, unknown> & {
  sourceFile: string;
  generatedAt?: unknown;
};

type PaperPortfolioRuntime = {
  runtimeAlive: boolean;
  runtimePid: number | null;
  runtimeStale: boolean;
  runtimeStatus: string;
};

paperPortfolioRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const dataDir = path.resolve(process.cwd(), 'data');
    let files: string[] = [];
    try {
      files = await fs.readdir(dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const reports = await Promise.all(
      files
        .filter((file) => file.endsWith('_paper_report.json'))
        .map(async (file) => {
          try {
            const raw = await fs.readFile(path.join(dataDir, file), 'utf8');
            const report = JSON.parse(raw) as Record<string, unknown>;
            const runtime = await getPaperRuntime(dataDir, file, report);
            const actionState = getPaperPortfolioActionState(file);
            return {
              ...report,
              ...runtime,
              sourceFile: file,
              controllable: isManagedPaperPortfolio(file),
              pendingAction: actionState?.status === 'pending' ? actionState.action : null,
              actionError: actionState?.status === 'failed' ? actionState.error ?? 'Komut basarisiz' : null,
            } as PaperPortfolioFile;
          } catch {
            return null;
          }
        })
    );

    const validReports = reports.filter(
      (report): report is NonNullable<typeof report> => report !== null
    );

    res.json({
      ok: true,
      data: validReports.sort(
        (a, b) => Number(b.generatedAt ?? 0) - Number(a.generatedAt ?? 0)
      ),
    });
  })
);

// Durdur: acik pozisyonlar son fiyattan kapatilir, portfoy bir daha islem acmaz.
paperPortfolioRouter.post(
  '/:sourceFile/stop',
  asyncHandler(async (req, res) => {
    requestPaperPortfolioAction(String(req.params.sourceFile), 'stop');
    res.status(202).json({ ok: true, data: { queued: true } });
  })
);

// Uzat: planlanan bitis ileri alinir, portfoy yeniden yeni islem acar.
paperPortfolioRouter.post(
  '/:sourceFile/extend',
  asyncHandler(async (req, res) => {
    const { days } = extendSchema.parse(req.body ?? {});
    requestPaperPortfolioAction(String(req.params.sourceFile), 'extend', days);
    res.status(202).json({ ok: true, data: { queued: true } });
  })
);

async function getPaperRuntime(
  dataDir: string,
  reportFile: string,
  report: Record<string, unknown>
): Promise<PaperPortfolioRuntime> {
  const status = String(report.status ?? 'unknown');
  // closing: bitis gecti ama acik pozisyonlar hala izleniyor; guncel olup olmadigi onemli.
  if (status !== 'running' && status !== 'closing') {
    return {
      runtimeAlive: false,
      runtimePid: null,
      runtimeStale: false,
      runtimeStatus: status,
    };
  }

  const lockFile = reportFile.replace(/_report\.json$/i, '_state.json.lock');
  const runtimePid = await getLivePid(path.join(dataDir, lockFile));
  const runtimeAlive = runtimePid !== null;
  const runtimeStale = paperReportIsStale(report);

  return {
    runtimeAlive,
    runtimePid,
    runtimeStale,
    runtimeStatus: runtimeStale ? 'stale' : status,
  };
}

async function getLivePid(lockPath: string): Promise<number | null> {
  let pid: number;
  try {
    pid = Number(await fs.readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return pid;
    return null;
  }
}

function paperReportIsStale(report: Record<string, unknown>): boolean {
  const generatedAt = Number(report.generatedAt);
  if (!Number.isFinite(generatedAt)) return true;
  const config = report.config as { interval?: unknown } | undefined;
  const intervalMs = intervalToMs(String(config?.interval ?? '1h'));
  return Date.now() - generatedAt > intervalMs * 2.5;
}

function intervalToMs(interval: string): number {
  const match = interval.match(/^(\d+)([mhd])$/i);
  if (!match) return 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}
