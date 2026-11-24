import { describe, expect, test } from 'vitest';
import { PaperExecution } from '../src/bot/execution.js';
import type { BotConfig } from '../src/types/domain.js';

function paperBot(strategyParams: Record<string, unknown> = {}): BotConfig {
  return {
    id: 'paper-test',
    name: 'Paper Test',
    symbol: 'BTCUSDT',
    interval: '1h',
    mode: 'paper',
    status: 'running',
    strategyId: 'test.py',
    strategyParams,
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

describe('PaperExecution', () => {
  test('bot ayarlarindaki komisyon ve slippage ile acip kapatir', async () => {
    const execution = new PaperExecution();
    const bot = paperBot({ fee_bps: 20, slippage_bps: 50 });

    const opened = await execution.openPosition(
      { bot, price: 100 },
      {
        side: 'BUY',
        notionalUsd: 1_000,
        takeProfitPrice: 110,
        meta: { strategySignal: 'long' },
      }
    );

    expect(opened.trade.price).toBeCloseTo(100.5);
    expect(opened.trade.quantity).toBeCloseTo(1_000 / 100.5);
    expect(opened.trade.feeUsd).toBeCloseTo(2);
    expect(opened.trade.meta).toMatchObject({
      strategySignal: 'long',
      paperExecutionOpen: {
        referencePrice: 100,
        feeBps: 20,
        slippageBps: 50,
        feeUsd: 2,
      },
    });
    expect(
      (opened.trade.meta?.paperExecutionOpen as Record<string, unknown>).fillPrice
    ).toBeCloseTo(100.5);

    const closed = await execution.closePosition(
      { bot, price: 110 },
      opened.position!
    );
    const quantity = 1_000 / 100.5;
    const exitFill = 109.45;
    const closeFee = quantity * exitFill * 0.002;
    const expectedPnl = (exitFill - 100.5) * quantity - 2 - closeFee;

    expect(closed.trade.price).toBeCloseTo(exitFill);
    expect(closed.trade.feeUsd).toBeCloseTo(closeFee);
    expect(closed.trade.pnlUsd).toBeCloseTo(expectedPnl);
    expect(closed.trade.meta).toMatchObject({
      strategySignal: 'long',
      paperExecutionClose: {
        referencePrice: 110,
        feeBps: 20,
        slippageBps: 50,
      },
    });
    expect(
      (closed.trade.meta?.paperExecutionClose as Record<string, unknown>).fillPrice
    ).toBeCloseTo(exitFill);
  });

  test('varsayilan olarak 10 bps komisyon ve 2 bps slippage kullanir', async () => {
    const execution = new PaperExecution();
    const opened = await execution.openPosition(
      { bot: paperBot(), price: 100 },
      { side: 'SELL', notionalUsd: 1_000, takeProfitPrice: 95 }
    );

    expect(opened.trade.price).toBeCloseTo(99.98);
    expect(opened.trade.feeUsd).toBeCloseTo(1);
    expect(opened.trade.meta).toMatchObject({
      paperExecutionOpen: {
        feeBps: 10,
        slippageBps: 2,
      },
    });
  });

  test('maliyetleri karsilamayan TP hedefini reddeder', async () => {
    const execution = new PaperExecution();
    const bot = paperBot({ fee_bps: 20, slippage_bps: 20 });

    await expect(
      execution.openPosition(
        { bot, price: 100 },
        { side: 'BUY', notionalUsd: 1_000, takeProfitPrice: 100.1 }
      )
    ).rejects.toThrow('TP hedefi komisyon/slippage maliyetini karsilamiyor');
  });
});
