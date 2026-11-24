import { describe, expect, test } from 'vitest';
import { BotRunner } from '../src/bot/runner.js';
import type { Storage } from '../src/storage/index.js';
import type { BotConfig } from '../src/types/domain.js';

function botConfig(): BotConfig {
  return {
    id: 'runner-queue-test',
    name: 'Runner Queue Test',
    symbol: 'BTCUSDT',
    interval: '5m',
    mode: 'paper',
    status: 'running',
    strategyId: 'test.py',
    strategyParams: {},
    risk: {
      maxLossPct: 2,
      takeProfitPct: 4,
      maxPositionUsd: 1_000,
      dailyMaxLossUsd: 100,
    },
    capitalUsd: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

function storage(): Storage {
  return {
    bots: {} as Storage['bots'],
    trades: {} as Storage['trades'],
    backtests: {} as Storage['backtests'],
  };
}

describe('BotRunner closed candle queue', () => {
  test('strateji ticki surerken gelen kapanmis mumlari sirayla isler', async () => {
    const runner = new BotRunner(botConfig(), storage()) as unknown as {
      ingestClosedCandle: (candle: Record<string, number>) => Promise<void>;
      processCandle: (candle: Record<string, number>) => Promise<void>;
    };
    const processed: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    runner.processCandle = async (candle) => {
      processed.push(candle.t);
      if (processed.length === 1) await firstGate;
    };

    const first = runner.ingestClosedCandle({ t: 100, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    await Promise.resolve();
    const second = runner.ingestClosedCandle({ t: 200, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    const third = runner.ingestClosedCandle({ t: 300, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    releaseFirst?.();

    await Promise.all([first, second, third]);
    expect(processed).toEqual([100, 200, 300]);
  });
});
