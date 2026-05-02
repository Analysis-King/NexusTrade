/**
 * Python worker pool — birden fazla pool_worker.py process'ini yönetir.
 *
 * - Pool size: default `os.cpus().length` ama default 2 (CPU paylaşımı önemli)
 * - Round-robin instance dağıtımı: yeni bot eklendiğinde en az yüklü worker'a gider
 * - Bir process ölürse otomatik restart, instance'ları yeniden yükle
 * - Graceful shutdown: SIGTERM, sonra timeout → SIGKILL
 *
 * Kullanım:
 *   const pool = new WorkerPool();
 *   await pool.start();
 *   const config = await pool.load(botId, 'rsi_mean_reversion.py');
 *   const sig = await pool.tick(botId, { candle, candles, portfolio });
 *   await pool.drop(botId);
 *   await pool.shutdown();
 */

import { createLogger } from '../utils/logger.js';
import { WorkerError } from '../utils/errors.js';
import { WorkerProcess } from './process.js';
import type {
  BacktestRequest,
  BacktestResponse,
  LoadResponse,
  TickRequest,
  TickResponse,
} from './types.js';

const log = createLogger('worker-pool');

export interface WorkerPoolOptions {
  size?: number;
  /** Worker bir tick için max kaç ms bekleyebilir */
  tickTimeoutMs?: number;
  /** Backtest için max ms (uzun sürer) */
  backtestTimeoutMs?: number;
}

interface InstanceMeta {
  workerIdx: number;
  strategyFile: string;
}

export class WorkerPool {
  private workers: WorkerProcess[] = [];
  private instanceMap = new Map<string, InstanceMeta>();
  private readonly size: number;
  private readonly tickTimeoutMs: number;
  private readonly backtestTimeoutMs: number;
  private shuttingDown = false;
  /** Round-robin imleci yeni instance dağıtımı için */
  private rrCursor = 0;

  constructor(opts: WorkerPoolOptions = {}) {
    this.size = Math.max(1, opts.size ?? 2);
    this.tickTimeoutMs = opts.tickTimeoutMs ?? 5_000;
    this.backtestTimeoutMs = opts.backtestTimeoutMs ?? 180_000;
  }

  async start(): Promise<void> {
    log.info({ size: this.size }, 'Worker pool baslatiliyor');
    for (let i = 0; i < this.size; i++) {
      this.spawnAt(i);
    }
    // Sağlık kontrolü — hepsi cevap veriyor mu?
    await Promise.all(
      this.workers.map((w, i) =>
        w.request('ping', {}, 5000).catch((err) => {
          log.error({ idx: i, err }, 'Worker ping basarisiz');
        })
      )
    );
    log.info('Worker pool hazir');
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info('Worker pool kapatiliyor');
    await Promise.all(this.workers.map((w) => w.kill()));
    this.workers = [];
    this.instanceMap.clear();
  }

  /* ─── Bot operasyonları ────────────────────────────────── */

  async load(instanceId: string, strategyFile: string): Promise<LoadResponse> {
    if (this.instanceMap.has(instanceId)) {
      // Zaten yüklü — drop & yeniden yükle
      await this.drop(instanceId).catch(() => undefined);
    }
    const idx = this.pickWorker();
    const worker = this.workers[idx]!;

    try {
      const data = await worker.request<LoadResponse>('load', {
        instance: instanceId,
        strategy_file: strategyFile,
      });
      this.instanceMap.set(instanceId, { workerIdx: idx, strategyFile });
      worker.loadedInstances.add(instanceId);
      return data;
    } catch (err) {
      throw new WorkerError(`Strateji yuklenemedi: ${(err as Error).message}`);
    }
  }

  async drop(instanceId: string): Promise<void> {
    const meta = this.instanceMap.get(instanceId);
    if (!meta) return;
    const worker = this.workers[meta.workerIdx];
    this.instanceMap.delete(instanceId);
    worker?.loadedInstances.delete(instanceId);
    if (worker?.isAlive) {
      await worker.request('drop', { instance: instanceId }, 2000).catch(() => undefined);
    }
  }

  async tick(instanceId: string, req: Omit<TickRequest, 'instance'>): Promise<TickResponse> {
    const meta = this.instanceMap.get(instanceId);
    if (!meta) {
      throw new WorkerError(`Bot yuklu degil: ${instanceId}`);
    }
    const worker = this.workers[meta.workerIdx];
    if (!worker || !worker.isAlive) {
      throw new WorkerError(`Bot worker'i olu: ${instanceId}`);
    }
    return worker.request<TickResponse>(
      'tick',
      { instance: instanceId, ...req },
      this.tickTimeoutMs
    );
  }

  async backtest(
    instanceId: string,
    req: Omit<BacktestRequest, 'instance'>
  ): Promise<BacktestResponse> {
    const meta = this.instanceMap.get(instanceId);
    if (!meta) throw new WorkerError(`Bot yuklu degil: ${instanceId}`);
    const worker = this.workers[meta.workerIdx];
    if (!worker || !worker.isAlive) throw new WorkerError(`Worker olu: ${instanceId}`);

    return worker.request<BacktestResponse>(
      'backtest',
      { instance: instanceId, ...req },
      this.backtestTimeoutMs
    );
  }

  /* ─── İç durum ─────────────────────────────────────────── */

  /** Pool durumu — monitoring için */
  getStats(): {
    size: number;
    alive: number;
    instances: number;
    perWorker: Array<{ idx: number; alive: boolean; instances: number; inflight: number }>;
  } {
    return {
      size: this.workers.length,
      alive: this.workers.filter((w) => w.isAlive).length,
      instances: this.instanceMap.size,
      perWorker: this.workers.map((w, idx) => ({
        idx,
        alive: w.isAlive,
        instances: w.loadedInstances.size,
        inflight: w.inflight,
      })),
    };
  }

  /* ─── Internal ─────────────────────────────────────────── */

  private spawnAt(idx: number): void {
    const w = new WorkerProcess();
    w.start();
    w.on('dead', (err) => {
      log.warn({ idx, err: err.message }, 'Worker oldu, restart');
      if (this.shuttingDown) return;
      const old = this.workers[idx];
      const lostInstances = [...(old?.loadedInstances ?? [])];

      // Replace
      setTimeout(() => {
        if (this.shuttingDown) return;
        this.spawnAt(idx);
        // Lost instance'lari yeniden yukle
        for (const instId of lostInstances) {
          const meta = this.instanceMap.get(instId);
          if (!meta) continue;
          this.workers[idx]
            ?.request('load', {
              instance: instId,
              strategy_file: meta.strategyFile,
            })
            .then(() => {
              this.workers[idx]?.loadedInstances.add(instId);
              log.info({ instId, idx }, 'Instance yeniden yuklendi');
            })
            .catch((e) => log.error({ instId, err: e.message }, 'Reload basarisiz'));
        }
      }, 1000);
    });
    this.workers[idx] = w;
  }

  /** En az yüklü worker'ı seç (instance count bazlı). */
  private pickWorker(): number {
    let bestIdx = 0;
    let bestCount = Infinity;
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i];
      if (!w?.isAlive) continue;
      if (w.loadedInstances.size < bestCount) {
        bestCount = w.loadedInstances.size;
        bestIdx = i;
      }
    }
    // Round-robin fallback (eşit yüklülerde)
    if (bestCount === Infinity) {
      bestIdx = this.rrCursor % this.workers.length;
      this.rrCursor++;
    }
    return bestIdx;
  }
}

/* ─── Singleton ────────────────────────────────────────── */

let pool: WorkerPool | null = null;

export function getWorkerPool(): WorkerPool {
  if (!pool) pool = new WorkerPool();
  return pool;
}

export async function shutdownWorkerPool(): Promise<void> {
  if (pool) {
    await pool.shutdown();
    pool = null;
  }
}
