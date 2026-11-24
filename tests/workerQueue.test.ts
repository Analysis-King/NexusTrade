import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { WorkerProcess } from '../src/workers/process.js';

describe('WorkerProcess istek kuyrugu', () => {
  test('siradaki isteklerin timeout sayaci beklerken dolmaz', async () => {
    const worker = new WorkerProcess({
      scriptPath: path.resolve('tests/fixtures/slow_worker.py'),
      defaultTimeoutMs: 1_500,
    });
    worker.start();
    try {
      // Her biri ~600ms; ayni anda gonderilir. Eski davranista 3. istegin
      // sayaci gonderildigi anda basladigi icin ~1800ms'de timeout'a duserdi.
      const results = await Promise.all([
        worker.request('sleep', { ms: 600 }),
        worker.request('sleep', { ms: 600 }),
        worker.request('sleep', { ms: 600 }),
      ]);
      expect(results).toHaveLength(3);
      expect(worker.isAlive).toBe(true);
      expect(worker.inflight).toBe(0);
    } finally {
      await worker.kill();
    }
  }, 15_000);

  test('kill bekleyen ve kuyruktaki istekleri reddeder', async () => {
    const worker = new WorkerProcess({
      scriptPath: path.resolve('tests/fixtures/slow_worker.py'),
      defaultTimeoutMs: 5_000,
    });
    worker.start();
    const first = worker.request('sleep', { ms: 2_000 });
    const queued = worker.request('ping');
    await worker.kill();
    await expect(first).rejects.toThrow();
    await expect(queued).rejects.toThrow();
  }, 15_000);
});
