/**
 * Altin test (F1-6): ayni mumlarda backtest ve paper ayni islemleri uretiyor mu.
 *
 * Backtest tum mumlari tek istekte `backtest` komutuyla isler. Paper ayni mumlari tek tek
 * `paper_step` komutuyla, her adimda bir onceki adimin durumunu geri vererek isler (canli
 * paper botun yaptigi gibi). Ikisi de python/workers/execution_core.py'deki ayni cekirdegi
 * kullanir; bu test ikisinin islem islem ayni sonucu verdigini dogrular.
 *
 * Paper bot stratejiye son 500 mumu verir (src/bot/runner.ts MAX_CANDLE_BUFFER); backtest'e
 * de ayni pencere `max_history_bars` ile verilir.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startPythonWorker, type PythonWorker } from './helpers/pythonWorker.js';

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Trade {
  id: string;
  reason: string;
  entryTime: number;
  entryPrice: number;
  [key: string]: unknown;
}

interface BacktestResult {
  trades: Trade[];
  equity: Array<{ t: number; value: number }>;
}

interface PaperStepResult {
  state: Record<string, unknown>;
  opened: Array<{ entry_time: number; entry_price: number }>;
  closed: Trade[];
  position: { entry_time: number; entry_price: number } | null;
  mark: number;
}

const PAPER_WINDOW = 500;

const EXECUTION = {
  initial_capital: 1000,
  fee_bps: 10,
  slippage_bps: 2,
};

function fixture(name: string): Candle[] {
  const file = path.join(process.cwd(), 'tests', 'fixtures', 'candles', name);
  return JSON.parse(readFileSync(file, 'utf8')) as Candle[];
}

const ZEC = fixture('ZECUSDT_1h_1200.json');
const TRX = fixture('TRXUSDT_1h_1200.json');

const CASES: Array<{
  name: string;
  strategy: string;
  candles: Candle[];
  params?: Record<string, unknown>;
  fillModel?: string;
}> = [
  { name: 'DEMA cross, defaults', strategy: 'dema_cross_trend.py', candles: TRX },
  { name: 'Donchian momentum, defaults', strategy: 'donchian_momentum.py', candles: ZEC },
  {
    name: 'Donchian momentum, equity-% sizing and 3x leverage, opposite signal ignored',
    strategy: 'donchian_momentum.py',
    candles: ZEC,
    params: { max_position_pct: 50, leverage: 3, exit_on_opposite_signal: false },
  },
  {
    name: 'RSI mean reversion, exits at the next open (close_next_open)',
    strategy: 'rsi_mean_reversion.py',
    candles: TRX,
    fillModel: 'close_next_open',
  },
  {
    name: 'EMA cross, stop on close, take profit first',
    strategy: 'simple_ema_cross.py',
    candles: ZEC,
    params: { use_risk: true, stop_trigger_mode: 'close', same_candle_tp_sl: 'take_profit_first' },
  },
  {
    name: 'Harmonic portfolio candidate, stop at 0.2 of the target distance',
    strategy: 'harmonic_portfolio_candidate.py',
    candles: ZEC,
    params: { stop_loss_mode: 'target_ratio', stop_loss_target_ratio: 0.2, min_reward_risk: 0.5 },
  },
];

let worker: PythonWorker;

beforeAll(() => {
  worker = startPythonWorker({ timeoutMs: 60_000 });
});

afterAll(() => {
  worker?.close();
});

async function load(strategy: string, params: Record<string, unknown>): Promise<string> {
  const instance = `parity_${randomUUID()}`;
  await worker.request('load', { instance, strategy_file: strategy, params });
  return instance;
}

describe('execution parity: backtest vs step-by-step paper', () => {
  for (const testCase of CASES) {
    test(testCase.name, { timeout: 180_000 }, async () => {
      const params = testCase.params ?? {};
      const fill_model = testCase.fillModel ?? 'pessimistic_ohlc';
      const candles = testCase.candles;

      const backtestInstance = await load(testCase.strategy, params);
      const backtest = await worker.request<BacktestResult>('backtest', {
        instance: backtestInstance,
        candles,
        params,
        fill_model,
        max_history_bars: PAPER_WINDOW,
        ...EXECUTION,
      });
      await worker.request('drop', { instance: backtestInstance });

      // Paper: ayri bir instance (strateji modulunun kendi durumu da sifirdan baslar).
      const paperInstance = await load(testCase.strategy, params);
      let state: Record<string, unknown> | null = null;
      let position: PaperStepResult['position'] = null;
      const paperTrades: Trade[] = [];
      const opened: PaperStepResult['opened'] = [];
      const marks: number[] = [];
      for (let i = 0; i < candles.length; i += 1) {
        const step: PaperStepResult = await worker.request<PaperStepResult>('paper_step', {
          instance: paperInstance,
          candle: candles[i],
          candles: candles.slice(Math.max(0, i + 1 - PAPER_WINDOW), i + 1),
          state,
          params,
          fill_model,
          ...EXECUTION,
        });
        state = step.state;
        position = step.position;
        paperTrades.push(...step.closed);
        opened.push(...step.opened);
        marks.push(Math.round(step.mark * 100) / 100);
      }
      await worker.request('drop', { instance: paperInstance });

      // Backtest testin sonunda acik pozisyonu kapatir; paper'da o pozisyon hala acik.
      const closedInBacktest = backtest.trades.filter((trade) => trade.reason !== 'end_of_test');
      const endOfTest = backtest.trades.find((trade) => trade.reason === 'end_of_test');

      expect(backtest.trades.length).toBeGreaterThan(3);
      expect(paperTrades).toEqual(closedInBacktest);
      expect(opened.length).toBe(backtest.trades.length);
      if (endOfTest) {
        expect(position).not.toBeNull();
        expect(position?.entry_time).toBe(endOfTest.entryTime);
        expect(Math.round((position?.entry_price ?? 0) * 1e8) / 1e8).toBe(endOfTest.entryPrice);
      } else {
        expect(position).toBeNull();
      }
      // Son nokta haric (backtest onu test sonu kapanisiyla degistirir) sermaye egrisi de ayni.
      const curve = backtest.equity.map((point) => point.value);
      expect(marks.slice(0, -1)).toEqual(curve.slice(0, marks.length - 1));
    });
  }
});
