/**
 * Testler icin python/workers/pool_worker.py'yi baslatan ve satir bazli JSON protokoluyle
 * istek gonderen kucuk yardimci.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

interface WorkerMessage {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface PythonWorker {
  child: ChildProcessWithoutNullStreams;
  request: <T = unknown>(cmd: string, payload: Record<string, unknown>) => Promise<T>;
  close: () => void;
}

export function startPythonWorker(options: { timeoutMs?: number } = {}): PythonWorker {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const child = spawn('python', ['-u', 'python/workers/pool_worker.py'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => undefined);

  let buffer = '';
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      const msg = JSON.parse(line) as WorkerMessage;
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.data);
      else waiter.reject(new Error(msg.error ?? 'Worker error'));
    }
  });

  const request = <T = unknown>(cmd: string, payload: Record<string, unknown>): Promise<T> => {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker timeout: ${cmd}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  };

  return { child, request, close: () => child.kill() };
}
