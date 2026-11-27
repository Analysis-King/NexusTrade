import { describe, expect, test, vi } from 'vitest';
import { BotManager } from '../src/bot/manager.js';
import { BotRunner } from '../src/bot/runner.js';
import type { Storage } from '../src/storage/index.js';
import type { BotConfig, Position, Trade } from '../src/types/domain.js';

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

function botConfig(status: BotConfig['status']): BotConfig {
  return {
    id: 'paused-test',
    name: 'Paused Test',
    symbol: 'BTCUSDT',
    interval: '5m',
    mode: 'paper',
    status,
    strategyId: 'test.py',
    strategyParams: {},
    risk: { maxLossPct: 2, takeProfitPct: 4, maxPositionUsd: 1_000, dailyMaxLossUsd: 100 },
    capitalUsd: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

function memoryStorage(initial: BotConfig[] = []): Storage & { savedTrades: Trade[] } {
  const bots = new Map(initial.map((b) => [b.id, { ...b }]));
  const savedTrades: Trade[] = [];
  return {
    savedTrades,
    bots: {
      list: async () => [...bots.values()],
      get: async (id: string) => bots.get(id) ?? null,
      create: async (b: BotConfig) => (bots.set(b.id, b), b),
      update: async (id: string, patch: Partial<BotConfig>) => {
        const next = { ...bots.get(id)!, ...patch };
        bots.set(id, next);
        return next;
      },
      delete: async (id: string) => void bots.delete(id),
    },
    trades: {
      list: async () => [...savedTrades].reverse(),
      add: async (t: Trade) => (savedTrades.push(t), t),
      findByClientOrderId: async () => null,
    },
    backtests: {} as Storage['backtests'],
  };
}

const candle = (t: number, extra: Partial<Candle> = {}): Candle => ({
  t,
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  v: 1,
  ...extra,
});

interface RunnerInternals {
  ingestClosedCandle: (c: Candle) => Promise<void>;
  processCandle: (c: Candle) => Promise<void>;
  resume: () => Promise<void>;
  unsubscribeStream: (() => void) | null;
  state: { candles: Candle[]; position: Position | null };
}

describe('Duraklatilmis bot', () => {
  test('duraklatilmisken gelen mumlar resume sonrasi tekrar eklenmez/islenmez', async () => {
    const storage = memoryStorage([botConfig('paused')]);
    const runner = new BotRunner(botConfig('paused'), storage) as unknown as RunnerInternals;
    const processed: number[] = [];
    runner.processCandle = async (c) => void processed.push(c.t);
    runner.unsubscribeStream = () => undefined; // abone gibi davran

    await runner.ingestClosedCandle(candle(100));
    await runner.ingestClosedCandle(candle(200));
    await runner.resume();

    // Resume sonrasi yedek yoklama ayni mumlari tekrar getirir
    await runner.ingestClosedCandle(candle(100));
    await runner.ingestClosedCandle(candle(200));
    await runner.ingestClosedCandle(candle(300));

    expect(processed).toEqual([300]);
    expect(runner.state.candles.map((c) => c.t)).toEqual([100, 200, 300]);
  });

  // Duraklatilmis botta acik pozisyonun SL ile kapanmasi yurutme cekirdegi uzerinden
  // calistigi icin gercek worker havuzuyla test ediliyor: tests/runnerParity.test.ts.
});

describe('BotManager.update', () => {
  test('eski runner yenisiyle degistirilmeden once kapatilir', async () => {
    const cfg = botConfig('paused');
    const storage = memoryStorage([cfg]);
    const manager = new BotManager(storage);
    await manager.bootstrap();

    const runners = (manager as unknown as { runners: Map<string, BotRunner> }).runners;
    const oldRunner = runners.get(cfg.id)!;
    const dispose = vi.spyOn(oldRunner, 'dispose');

    await manager.update(cfg.id, { capitalUsd: 2_000 });

    expect(dispose).toHaveBeenCalledOnce();
    expect(runners.get(cfg.id)).not.toBe(oldRunner);
    expect((await storage.bots.get(cfg.id))?.status).toBe('paused');
  });
});
