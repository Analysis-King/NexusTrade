/**
 * Paper bot (BotRunner) uctan uca: gercek Python worker havuzuyla mum mum calisan botun
 * kaydettigi islemler, ayni mumlarda ayni ayarlarla calisan backtest'in islemleriyle ayni mi.
 * Bot yurutme cekirdegini `paper_step` ile kullanir (F1-1); bu test runner'in cekirdek
 * sonuclarini dogru kaydettigini, durumu yeniden baslatmada surdurdugunu ve kapaliyken kacan
 * mumlari isledigini dogrular. Binance'e baglanilmaz: gecmis yukleme ve akis taklit edilir.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BotRunner } from '../src/bot/runner.js';
import { getWorkerPool } from '../src/workers/pool.js';
import type { Storage } from '../src/storage/index.js';
import type { BotConfig, Candle as DomainCandle, Position, Trade } from '../src/types/domain.js';

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

interface CoreTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  netPnl: number;
  reason: string;
}

interface RunnerInternals {
  start: () => Promise<void>;
  dispose: () => Promise<void>;
  ingestClosedCandle: (c: Candle) => Promise<void>;
  hydrateStateFromTrades: () => Promise<void>;
  preloadHistory: () => Promise<DomainCandle[]>;
  subscribeStream: () => void;
  startFallbackPolling: () => void;
  state: { position: Position | null };
}

const CANDLES: Candle[] = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'candles', 'ZECUSDT_1h_1200.json'), 'utf8')
) as Candle[];

const RISK = { maxLossPct: 2, takeProfitPct: 4, maxPositionUsd: 1_000, dailyMaxLossUsd: 1e9, leverage: 1 };

function botConfig(id: string, strategyId: string, strategyParams: Record<string, unknown> = {}): BotConfig {
  return {
    id,
    name: id,
    symbol: 'ZECUSDT',
    interval: '1h',
    mode: 'paper',
    status: 'running',
    strategyId,
    strategyParams,
    risk: RISK,
    capitalUsd: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Runner'in yukledigi parametrelerin aynisi (BotRunner.strategyRuntimeParams). */
function runtimeParams(cfg: BotConfig): Record<string, unknown> {
  return {
    ...cfg.strategyParams,
    stop_loss_pct: cfg.risk.maxLossPct,
    take_profit_pct: cfg.risk.takeProfitPct,
    stop_loss_mode: cfg.risk.stopLossMode ?? 'target_ratio',
    stop_loss_target_ratio: cfg.risk.stopLossTargetRatio ?? 0.2,
    max_position_usd: cfg.risk.maxPositionUsd,
    leverage: cfg.risk.leverage ?? 1,
  };
}

function memoryStorage(initial: BotConfig[]): Storage & { savedTrades: Trade[] } {
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

function toDomain(candle: Candle): DomainCandle {
  return {
    openTime: candle.t,
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
    volume: candle.v,
    closeTime: candle.t + 3_599_999,
  };
}

/** Binance'e baglanmadan calisan runner: gecmis = verilen mumlar, akis yok. */
function offlineRunner(cfg: BotConfig, storage: Storage, history: Candle[]): RunnerInternals {
  const runner = new BotRunner(cfg, storage) as unknown as RunnerInternals;
  runner.preloadHistory = async () => history.map(toDomain);
  runner.subscribeStream = () => undefined;
  runner.startFallbackPolling = () => undefined;
  return runner;
}

/** Kaydedilen kapanis islemleri, cekirdek islemi bicimine cevrilmis halde. */
function closedTrades(trades: Trade[]): CoreTrade[] {
  return trades
    .filter((trade) => typeof trade.pnlUsd === 'number')
    .map((trade) => {
      const core = trade.meta?.paperCore as Record<string, number | string>;
      return {
        entryTime: Number(core.entryTime),
        exitTime: Number(core.exitTime),
        entryPrice: Number(core.entryPrice),
        exitPrice: trade.price,
        netPnl: trade.pnlUsd!,
        reason: String(core.reason),
      };
    });
}

async function referenceBacktest(cfg: BotConfig, candles: Candle[]): Promise<CoreTrade[]> {
  const instance = `${cfg.id}-reference`;
  await getWorkerPool().load(instance, cfg.strategyId, runtimeParams(cfg));
  const result = (await getWorkerPool().backtest(instance, {
    candles,
    initial_capital: cfg.capitalUsd,
    fee_bps: 10,
    slippage_bps: 2,
    max_history_bars: 500,
  })) as { trades: Array<CoreTrade & Record<string, unknown>> };
  await getWorkerPool().drop(instance);
  return result.trades
    .filter((trade) => trade.reason !== 'end_of_test')
    .map(({ entryTime, exitTime, entryPrice, exitPrice, netPnl, reason }) => ({
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      netPnl,
      reason,
    }));
}

beforeAll(async () => {
  await getWorkerPool().start();
}, 60_000);

afterAll(async () => {
  await getWorkerPool().shutdown();
});

describe('paper bot uses the execution core', () => {
  test('bot trades match the backtest on the same candles', { timeout: 180_000 }, async () => {
    const cfg = botConfig('runner-parity-donchian', 'donchian_momentum.py');
    const storage = memoryStorage([cfg]);
    const runner = offlineRunner(cfg, storage, []);
    await runner.start();
    for (const candle of CANDLES) {
      await runner.ingestClosedCandle(candle);
    }
    await runner.dispose();

    const expected = await referenceBacktest(cfg, CANDLES);
    expect(expected.length).toBeGreaterThan(5);
    expect(closedTrades(storage.savedTrades)).toEqual(expected);
  });

  test('state survives a restart and missed candles are processed', { timeout: 180_000 }, async () => {
    const cfg = botConfig('runner-parity-restart', 'simple_ema_cross.py', { use_risk: true });
    const storage = memoryStorage([cfg]);

    // Ilk calisma: 0-699
    const first = offlineRunner(cfg, storage, []);
    await first.start();
    for (const candle of CANDLES.slice(0, 700)) {
      await first.ingestClosedCandle(candle);
    }
    await first.dispose();
    const saved = await storage.bots.get(cfg.id);
    expect(saved?.paperCore?.lastCandleT).toBe(CANDLES[699]!.t);

    // Kapali kalinan sure: 700-899. Yeniden baslarken gecmis 899'a kadar gelir, kacan mumlar
    // islenir; sonra canli akis 900'den devam eder.
    const second = offlineRunner(saved!, storage, CANDLES.slice(0, 900));
    await second.start();
    expect((await storage.bots.get(cfg.id))?.paperCore?.lastCandleT).toBe(CANDLES[899]!.t);
    for (const candle of CANDLES.slice(900)) {
      await second.ingestClosedCandle(candle);
    }
    await second.dispose();

    const expected = await referenceBacktest(cfg, CANDLES);
    expect(expected.length).toBeGreaterThan(5);
    expect(expected.some((trade) => trade.entryTime >= CANDLES[700]!.t && trade.entryTime < CANDLES[900]!.t)).toBe(true);
    expect(closedTrades(storage.savedTrades)).toEqual(expected);
  });

  test('a paused bot still closes its open position at the stop', { timeout: 60_000 }, async () => {
    const cfg: BotConfig = {
      ...botConfig('runner-paused-stop', 'simple_ema_cross.py'),
      status: 'paused',
      paperCore: {
        state: {
          v: 1,
          equity: 999,
          realized_pnl: 0,
          position: {
            side: 'long',
            entry_time: 1,
            entry_price: 100,
            qty: 10,
            notional: 1_000,
            entry_fee: 1,
            sl: 95,
            tp: 110,
            meta: {},
          },
          pending_signal: null,
          pending_exit: null,
          trade_count: 0,
        },
        lastCandleT: 0,
      },
    };
    const storage = memoryStorage([cfg]);
    await getWorkerPool().load(cfg.id, cfg.strategyId, runtimeParams(cfg));
    const runner = new BotRunner(cfg, storage) as unknown as RunnerInternals;
    await runner.hydrateStateFromTrades();
    expect(runner.state.position?.stopLossPrice).toBe(95);

    await runner.ingestClosedCandle({ t: 3_600_000, o: 100, h: 101, l: 94, c: 96, v: 1 });

    expect(runner.state.position).toBeNull();
    const closed = closedTrades(storage.savedTrades);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.reason).toBe('sl');
    expect(closed[0]!.exitPrice).toBeCloseTo(95 * (1 - 0.0002), 8);
    expect(closed[0]!.netPnl).toBeLessThan(0);
    await getWorkerPool().drop(cfg.id);
  });
});
