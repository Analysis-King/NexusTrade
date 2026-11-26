import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// env modulu import aninda dogrulanir; limitleri ondan once ayarla.
// (dotenv mevcut degiskenleri ezmez.)
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_MAX = '3';
process.env.RATE_LIMIT_WRITE_MAX = '2';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key-0123456789abcdef';

let server: Server;
let base: string;

beforeAll(async () => {
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('rate limit', () => {
  test('okuma butcesi dolsa bile islem istekleri reddedilmez; ikisi ayri sayilir', async () => {
    const reads: number[] = [];
    for (let i = 0; i < 4; i++) reads.push((await fetch(`${base}/api/health`)).status);
    expect(reads).toEqual([200, 200, 200, 429]);

    // Bilinmeyen rota: limitten gecerse 404, takilirsa 429 doner. Hicbir veriye dokunmaz.
    const writes: number[] = [];
    for (let i = 0; i < 3; i++) {
      writes.push((await fetch(`${base}/api/__rate_limit_probe`, { method: 'POST' })).status);
    }
    expect(writes).toEqual([404, 404, 429]);
  });
});
