import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanupStaleTempFiles, writeJson } from '../src/storage/json/atomicFile.js';
import { JsonBacktestStore } from '../src/storage/json/backtestStore.js';
import { JsonBotStore } from '../src/storage/json/botStore.js';
import { JsonTradeStore } from '../src/storage/json/tradeStore.js';
import type { BacktestRun } from '../src/types/backtest.js';
import type { BotConfig, Trade } from '../src/types/domain.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-store-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function trade(i: number): Trade {
  return {
    id: `t${i}`,
    botId: `bot${i % 5}`,
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    quantity: 1,
    price: 100 + i,
    feeUsd: 0.1,
    mode: 'paper',
    clientOrderId: `paper-${i}`,
    createdAt: 1_000 + i,
  };
}

function bot(id: string): BotConfig {
  return {
    id,
    name: id,
    symbol: 'BTCUSDT',
    interval: '5m',
    mode: 'paper',
    status: 'idle',
    strategyId: 'test.py',
    strategyParams: {},
    risk: { maxLossPct: 2, takeProfitPct: 4, maxPositionUsd: 100, dailyMaxLossUsd: 50 },
    capitalUsd: 1000,
    createdAt: 1,
    updatedAt: 1,
  };
}

function run(id: string, createdAt: string, symbol = 'BTCUSDT'): BacktestRun {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    status: 'completed',
    strategyFile: 'test.py',
    strategyHash: 'h',
    symbol,
    interval: '1h',
    startTime: 0,
    endTime: 1,
    candleCount: 10,
    initialCapital: 1000,
    params: {},
    assumptions: {} as BacktestRun['assumptions'],
  };
}

describe('JSON depo eszamanlilik', () => {
  test('ayni anda eklenen trade kayitlarinin hicbiri kaybolmaz', async () => {
    const store = new JsonTradeStore(dir);
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.add(trade(i))));
    const all = await store.list();
    expect(all).toHaveLength(40);
  });

  test('ayni clientOrderId ikinci kez eklenmez', async () => {
    const store = new JsonTradeStore(dir);
    await Promise.all([store.add(trade(1)), store.add(trade(1))]);
    expect(await store.list()).toHaveLength(1);
  });

  test('farkli botlarin eszamanli status guncellemeleri birbirini ezmez', async () => {
    const store = new JsonBotStore(dir);
    for (let i = 0; i < 10; i++) await store.create(bot(`b${i}`));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.update(`b${i}`, { status: 'running' }))
    );
    const bots = await store.list();
    expect(bots.filter((b) => b.status === 'running')).toHaveLength(10);
  });
});

describe('atomik yazma', () => {
  test('basarisiz yazimda tmp dosyasi geride kalmaz', async () => {
    const target = path.join(dir, 'busy.json');
    await fs.mkdir(target); // hedef bir klasor -> rename basarisiz olur
    await expect(writeJson(target, { a: 1 })).rejects.toThrow();
    const left = (await fs.readdir(dir)).filter((name) => name.includes('.tmp.'));
    expect(left).toEqual([]);
  }, 15_000);

  test('sadece eski yetim tmp dosyalarini siler', async () => {
    const stale = path.join(dir, 'backtests.json.tmp.14544.1778889668166');
    const fresh = path.join(dir, 'trades.json.tmp.1.2.abcd1234');
    const normal = path.join(dir, 'bots.json');
    await fs.writeFile(stale, 'x'.repeat(10));
    await fs.writeFile(fresh, 'y');
    await fs.writeFile(normal, '{}');
    const old = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(stale, old, old);

    const result = await cleanupStaleTempFiles(dir);
    expect(result).toEqual({ files: 1, bytes: 10 });
    expect((await fs.readdir(dir)).sort()).toEqual(['bots.json', 'trades.json.tmp.1.2.abcd1234']);
  });
});

describe('JsonBacktestStore', () => {
  test('eski tek dosyayi calistirma basina dosyalara tasir ve arsivler', async () => {
    await fs.writeFile(
      path.join(dir, 'backtests.json'),
      JSON.stringify({ version: 1, runs: [run('bt_a', '2026-01-01T00:00:00Z'), run('bt_b', '2026-02-01T00:00:00Z')] })
    );
    const store = new JsonBacktestStore(dir);
    const list = await store.list();
    expect(list.map((r) => r.id)).toEqual(['bt_b', 'bt_a']);

    const names = await fs.readdir(dir);
    expect(names).not.toContain('backtests.json');
    expect(names.some((n) => n.startsWith('backtests.json.migrated-'))).toBe(true);
    expect((await fs.readdir(path.join(dir, 'backtests'))).sort()).toEqual(['bt_a.json', 'bt_b.json']);
  });

  test('create/update/filtre/delete ve guvensiz id reddi', async () => {
    const store = new JsonBacktestStore(dir);
    await store.create(run('bt_1', '2026-01-01T00:00:00Z', 'ETHUSDT'));
    await store.create(run('bt_2', '2026-01-02T00:00:00Z'));
    await store.update('bt_1', { status: 'failed', error: 'x' });

    expect((await store.list({ status: 'failed' })).map((r) => r.id)).toEqual(['bt_1']);
    expect((await store.list({ symbol: 'BTCUSDT' })).map((r) => r.id)).toEqual(['bt_2']);
    expect((await store.get('bt_1'))?.error).toBe('x');

    // Yeni bir store ornegi diskten ayni durumu okur
    const reopened = new JsonBacktestStore(dir);
    expect((await reopened.get('bt_1'))?.status).toBe('failed');

    expect(await store.get('../bots')).toBeNull();
    await store.delete('bt_2');
    expect(await store.get('bt_2')).toBeNull();
  });
});
