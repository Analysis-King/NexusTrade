/**
 * Tek bir Python pool_worker.py process'ini sarar.
 *
 * - NDJSON protokolüyle stdin/stdout üzerinden iletişim
 * - Per-request id ile request/response eşleştirme
 * - Timeout, kill, restart desteği
 * - Çöken process'i otomatik yeniden doğurur (workerPool tarafından yönetilir)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { env } from '../config/env.js';
import { WorkerError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('py-process');

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  cmd: string;
}

export interface WorkerProcessOptions {
  /** pool_worker.py'nin tam yolu */
  scriptPath?: string;
  /** Default request timeout */
  defaultTimeoutMs?: number;
}

const DEFAULT_SCRIPT = path.resolve(process.cwd(), 'python/workers/pool_worker.py');

export class WorkerProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private dead = false;
  private readonly scriptPath: string;
  private readonly defaultTimeoutMs: number;
  /** Bu process'te yüklü instance ID'leri — pool restart için gerekli */
  public loadedInstances = new Set<string>();
  /** Uçan request sayısı — pool yük dağıtımında kullanır */
  public inflight = 0;

  constructor(opts: WorkerProcessOptions = {}) {
    super();
    this.scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? env.WORKER_TIMEOUT_MS;
  }

  get isAlive(): boolean {
    return !this.dead && this.child !== null && !this.child.killed;
  }

  start(): void {
    if (this.child) return;
    log.info({ script: this.scriptPath }, 'Python worker basliyor');

    this.child = spawn(env.PYTHON_BIN, ['-u', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');

    this.child.stdout?.on('data', (chunk: string) => this.handleStdout(chunk));
    this.child.stderr?.on('data', (chunk: string) => this.handleStderr(chunk));

    this.child.on('error', (err) => {
      log.error({ err }, 'Python process error');
      this.markDead(err);
    });

    this.child.on('exit', (code, signal) => {
      log.warn({ code, signal }, 'Python process exited');
      this.markDead(new WorkerError(`Process exited (code=${code}, signal=${signal})`));
    });
  }

  /** Bir komut gönder, cevabı bekle. */
  request<T = unknown>(cmd: string, payload: object = {}, timeoutMs?: number): Promise<T> {
    if (!this.isAlive) {
      return Promise.reject(new WorkerError('Worker olu, istek gonderilemez'));
    }

    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        const err = new WorkerError(`Request timeout (${timeoutMs ?? this.defaultTimeoutMs}ms): ${cmd}`);
        this.pending.delete(id);
        this.inflight = Math.max(0, this.inflight - 1);
        reject(err);
        this.terminateAfterTimeout(err);
      }, timeoutMs ?? this.defaultTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        cmd,
      });
      this.inflight++;

      const line = JSON.stringify({ id, cmd, ...payload }) + '\n';
      const ok = this.child!.stdin?.write(line);
      if (!ok) {
        // Backpressure — sadece logla, drain bekleyelim
        this.child!.stdin?.once('drain', () => {});
      }
    });
  }

  async kill(): Promise<void> {
    if (!this.child) return;
    this.dead = true;
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    // 1s sonra hala canliysa SIGKILL
    setTimeout(() => {
      if (this.child && !this.child.killed) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 1000).unref();
  }

  /* ─── Internal ─────────────────────────────────────────── */

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: string; ok?: boolean; data?: unknown; error?: string; trace?: string };
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log.warn({ line: line.slice(0, 200), err }, 'Worker invalid JSON');
      return;
    }

    if (!msg.id) {
      log.warn({ msg }, 'Worker mesajinda id yok');
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) {
      log.warn({ id: msg.id }, 'Pending olmayan response');
      return;
    }

    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    this.inflight = Math.max(0, this.inflight - 1);

    if (msg.ok) {
      pending.resolve(msg.data);
    } else {
      const err = new WorkerError(msg.error ?? 'Unknown worker error', { trace: msg.trace });
      pending.reject(err);
    }
  }

  private handleStderr(chunk: string): void {
    // Worker stderr'e structured log yazıyor; satır satır parse et
    const lines = chunk.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === 'object' && obj.level && obj.msg) {
          const lvl = String(obj.level);
          const m = String(obj.msg);
          if (lvl === 'error') log.error(m);
          else if (lvl === 'warn') log.warn(m);
          else log.info(m);
          continue;
        }
      } catch {
        /* fall through */
      }
      log.info({ raw: t.slice(0, 200) }, 'py stderr');
    }
  }

  private markDead(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    // Bekleyen tüm istekleri reddet
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new WorkerError(`Worker oldu: ${err.message}`));
    }
    this.pending.clear();
    this.inflight = 0;
    this.emit('dead', err);
  }

  private terminateAfterTimeout(err: Error): void {
    if (this.dead) return;
    const child = this.child;
    log.warn({ err: err.message }, 'Python worker timeout, process yenilenecek');
    this.markDead(err);
    try {
      child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}
