/**
 * Cok sembollu portfoy (F1-7): backtest ile paper ayni portfoy cekirdegini
 * (python/workers/portfolio_core.py) kullaniyor mu ve ayni islemleri uretiyor mu.
 *
 * 1. Tek sembol, tek pozisyon: portfoy, tek yurutme cekirdegiyle (backtest) ayni islemler.
 * 2. Paper parca parca calisir (her calismada strateji yeniden yuklenir, durum istekle gelir):
 *    sonuc tek seferlik calismayla ayni; ust periyot onayi dahil.
 * 3. Harmonik strateji: her calismada yeniden yukleme sonucu degistirmiyor.
 * 4. Paper script'i (scripts/lib/paper_portfolio.cjs): saat ilerledikce, arada kapali kalinan
 *    sureyle, backtest ile ayni islemler; sure dolunca yeni giris yok; durdurma hepsini kapatir.
 * Binance'e baglanilmaz: mumlar tests/fixtures/candles altindan.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startPythonWorker, type PythonWorker } from './helpers/pythonWorker.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const paper = require('../scripts/lib/paper_portfolio.cjs');

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Trade = Record<string, unknown> & { reason: string; entryTime: number; exitTime: number; key?: string };
interface PortfolioResult {
  state: Record<string, unknown> & { positions: Record<string, unknown>; counters: Record<string, number> };
  opened: Array<Record<string, unknown>>;
  closed: Trade[];
  counters: Record<string, number>;
}

const HOUR = 3_600_000;
const STEP: Record<string, number> = { '1h': HOUR, '4h': 4 * HOUR };
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
const SYMBOLS = ['AAVEUSDT', 'ADAUSDT', 'AVAXUSDT'];
const BREAKOUT = readFileSync(path.join(FIXTURES, 'strategies', 'window_breakout.py'), 'utf8');
const ZEC = loadCandles(path.join(FIXTURES, 'candles', 'ZECUSDT_1h_1200.json'));
const DATA: Record<string, Candle[]> = {};
for (const symbol of SYMBOLS) {
  for (const interval of ['1h', '4h']) {
    DATA[`${symbol}|${interval}`] = loadCandles(path.join(FIXTURES, 'candles', 'portfolio', `${symbol}_${interval}.json`));
  }
}
// Ilk 520 saatlik mum pencere icin; portfoy bundan sonra kapanan mumlarda islem yapar.
const START = DATA['ADAUSDT|1h']![520]!.t + 20 * 60_000;
const END = DATA['ADAUSDT|1h']!.at(-1)!.t + HOUR;
const BREAKOUT_PARAMS = { stop_loss_mode: 'target_ratio', stop_loss_target_ratio: 0.3 };

function loadCandles(file: string): Candle[] {
  return JSON.parse(readFileSync(file, 'utf8')) as Candle[];
}

function keysFor(intervals: string[]): string[] {
  return SYMBOLS.flatMap((symbol) => intervals.map((interval) => `${symbol}|${interval}`));
}

function pick(keys: string[], now = Infinity, limit = Infinity): Record<string, Candle[]> {
  return Object.fromEntries(keys.map((key) => {
    const step = STEP[key.split('|')[1]!]!;
    const closed = DATA[key]!.filter((candle) => candle.t + step <= now);
    return [key, Number.isFinite(limit) ? closed.slice(-limit) : closed];
  }));
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let worker: PythonWorker;

beforeAll(() => {
  worker = startPythonWorker({ timeoutMs: 240_000 });
});

afterAll(() => {
  worker.close();
});

const tradeFields = (trade: Trade) => ({
  entryTime: trade.entryTime,
  exitTime: trade.exitTime,
  entryPrice: trade.entryPrice,
  exitPrice: trade.exitPrice,
  side: trade.side,
  qty: trade.qty,
  netPnl: trade.netPnl,
  slPrice: trade.slPrice,
  tpPrice: trade.tpPrice,
  reason: trade.reason,
});

describe('portfolio core', () => {
  test.each([
    ['donchian_momentum.py', {}],
    ['simple_ema_cross.py', { use_risk: true }],
  ])('single symbol, one position: same trades as the execution core (%s)', { timeout: 60_000 }, async (strategy, extra) => {
    const params = { stop_loss_pct: 2, take_profit_pct: 4, stop_loss_mode: 'target_ratio', stop_loss_target_ratio: 0.2, ...extra };
    const execution = { initial_capital: 1000, fee_bps: 10, slippage_bps: 2, max_history_bars: 500 };
    await worker.request('load', { instance: 'single', strategy_file: strategy, params: { ...params, max_position_pct: 100 } });
    const single = await worker.request<{ trades: Trade[] }>('backtest', { instance: 'single', candles: ZEC, ...execution });
    await worker.request('drop', { instance: 'single' });
    const portfolio = await worker.request<PortfolioResult>('portfolio_backtest', {
      strategy_file: strategy,
      params,
      datasets: { 'ZECUSDT|1h': ZEC },
      max_positions: 1,
      leverage: 1,
      ...execution,
    });

    expect(single.trades.length).toBeGreaterThan(10);
    expect(portfolio.closed.map(tradeFields)).toEqual(single.trades.map(tradeFields));
  });

  // Her senaryoda kuralin gercekten calistigini gosteren sayaclar (> 0 olmali).
  const chunkCases: Array<[string, Record<string, unknown>, string[], string[]]> = [
    [
      '3 symbols, 2 slots, quality_target',
      { max_positions: 2, leverage: 2, score_mode: 'quality_target' },
      keysFor(['1h']),
      ['rejected_signals', 'duplicate_signals'],
    ],
    [
      '1h entries confirmed on 4h',
      { max_positions: 2, leverage: 1, entry_intervals: ['1h'], confirm_intervals: ['4h'], confirm_bars: 3 },
      keysFor(['1h', '4h']),
      ['rejected_htf', 'duplicate_signals'],
    ],
  ];

  test.each(chunkCases)('paper runs in chunks equal one run: %s', { timeout: 120_000 }, async (_name, options, keys, exercised) => {
    const base = {
      strategy_code: BREAKOUT,
      params: BREAKOUT_PARAMS,
      initial_capital: 1000,
      fee_bps: 10,
      slippage_bps: 2,
      max_history_bars: 500,
      start_time: START,
      require_full_window: true,
      ...options,
    };
    const once = await worker.request<PortfolioResult>('portfolio_run', { ...base, datasets: pick(keys), state: null });

    let state: unknown = null;
    const closed: Trade[] = [];
    const sizes = [1, 1, 3, 7, 13, 50, 97, 5];
    let now = START;
    for (let i = 0; now < END; i += 1) {
      now = Math.min(END, now + sizes[i % sizes.length]! * HOUR);
      const result = await worker.request<PortfolioResult>('portfolio_run', {
        ...base,
        datasets: pick(keys, now, 700),
        state,
      });
      state = json(result.state);
      closed.push(...result.closed);
    }

    expect(once.closed.length).toBeGreaterThan(10);
    for (const counter of exercised) expect(once.counters[counter], counter).toBeGreaterThan(0);
    if ((options.confirm_intervals as string[] | undefined)?.length) {
      expect(once.opened.every((position) => (position.meta as Record<string, unknown>).htf_confirmed === true)).toBe(true);
    }
    expect(closed).toEqual(once.closed);
    expect(state).toEqual(json(once.state));
  });

  test('harmonic strategy: reloading every run does not change the result', { timeout: 180_000 }, async () => {
    const keys = keysFor(['1h']);
    const base = {
      strategy_file: 'harmonic_portfolio_candidate.py',
      params: {},
      initial_capital: 1000,
      fee_bps: 10,
      slippage_bps: 2,
      max_positions: 2,
      leverage: 4,
      score_mode: 'quality_target',
      max_history_bars: 500,
      start_time: START,
      require_full_window: true,
    };
    const once = await worker.request<PortfolioResult>('portfolio_run', { ...base, datasets: pick(keys), state: null });

    let state: unknown = null;
    const closed: Trade[] = [];
    const sizes = [1, 5, 24, 60];
    let now = START;
    for (let i = 0; now < END; i += 1) {
      now = Math.min(END, now + sizes[i % sizes.length]! * HOUR);
      const result = await worker.request<PortfolioResult>('portfolio_run', { ...base, datasets: pick(keys, now, 600), state });
      state = json(result.state);
      closed.push(...result.closed);
    }

    expect(once.closed.length).toBeGreaterThan(10);
    expect(once.counters.duplicate_signals).toBeGreaterThan(0);
    expect(closed).toEqual(once.closed);
    expect(state).toEqual(json(once.state));
  });
});

describe('paper portfolio script', () => {
  /** Binance kline taklidi: istenen andan itibaren, `now` aninda var olan mumlar (son mum acik olabilir). */
  function fakeBinance(clock: { now: number }) {
    return async (symbol: string, interval: string, options: { startTime: number; limit: number }) =>
      DATA[`${symbol}|${interval}`]!
        .filter((candle) => candle.t >= options.startTime && candle.t <= clock.now)
        .slice(0, options.limit);
  }

  function newState(durationDays: number, intervals = { entry: ['1h'], confirm: ['4h'] }) {
    const config = paper.buildConfig({
      botName: 'Test portfoy',
      strategyCode: BREAKOUT,
      params: BREAKOUT_PARAMS,
      entryIntervals: intervals.entry,
      confirmIntervals: intervals.confirm,
      confirmBars: 3,
      durationDays,
      maxPositions: 2,
      portfolioLeverage: 1,
      initialCapital: 1000,
      feeBps: 10,
      slippageBps: 2,
      scoreMode: 'target_distance',
    });
    return paper.createState(config, SYMBOLS, START);
  }

  async function runUntil(state: Record<string, unknown>, clock: { now: number }, until: number, schedule: number[]) {
    for (let i = 0; clock.now < until; i += 1) {
      clock.now = Math.min(until, clock.now + schedule[i % schedule.length]!);
      await paper.runCycle(state, { now: clock.now, worker, fetchCandles: fakeBinance(clock), concurrency: 3 });
    }
  }

  test('cycles over time, with downtime, give the backtest trades', { timeout: 180_000 }, async () => {
    const state = newState(365);
    const clock = { now: START };
    // Yarim saatte bir, sonra 40 saat kapali, sonra saatte bir (mum kapanisindan 15 sn sonra).
    await runUntil(state, clock, START + 30 * HOUR, [30 * 60_000]);
    clock.now += 40 * HOUR;
    await runUntil(state, clock, END + 15_000, [HOUR]);

    const reference = await worker.request<PortfolioResult>('portfolio_run', {
      strategy_code: BREAKOUT,
      params: BREAKOUT_PARAMS,
      datasets: pick(keysFor(['1h', '4h'])),
      state: null,
      initial_capital: 1000,
      fee_bps: 10,
      slippage_bps: 2,
      max_positions: 2,
      leverage: 1,
      entry_intervals: ['1h'],
      confirm_intervals: ['4h'],
      confirm_bars: 3,
      max_history_bars: 500,
      start_time: START,
      require_full_window: true,
    });

    const trades = state.trades as Array<Record<string, unknown>>;
    expect(reference.closed.length).toBeGreaterThan(5);
    expect(trades.map((trade) => [trade.key, trade.entryTime, trade.exitTime, trade.exitPrice, trade.netPnl, trade.reason]))
      .toEqual(reference.closed.map((trade) => [trade.key, trade.entryTime, trade.exitTime, trade.exitPrice, trade.netPnl, trade.reason]));
    expect(state.core).toEqual(json(reference.state));

    const report = paper.buildReport(state, clock.now);
    expect(report.engine).toBe('portfolio_core');
    expect(report.metrics.closedTrades).toBe(reference.closed.length);
    expect(report.config.strategyCode).toBeUndefined();
    expect(report.openPositions).toHaveLength(Object.keys(reference.state.positions).length);
  });

  test('after the planned end no new entries are opened', { timeout: 180_000 }, async () => {
    const state = newState(8, { entry: ['1h'], confirm: [] });
    const clock = { now: START };
    const stopAt = state.stopAt as number;
    await runUntil(state, clock, stopAt + 15_000, [HOUR]);
    const core = () => state.core as { counters: Record<string, number> };
    const entriesAtEnd = core().counters.entries;
    expect(entriesAtEnd).toBeGreaterThan(3);

    await runUntil(state, clock, stopAt + 72 * HOUR, [HOUR]);
    expect(core().counters.entries).toBe(entriesAtEnd);
    const trades = state.trades as Array<{ entryTime: number; exitTime: number }>;
    expect(trades.some((trade) => trade.exitTime > stopAt)).toBe(true);
    expect(trades.every((trade) => trade.entryTime <= stopAt)).toBe(true);
  });

  test('stop closes the open positions at the last price', { timeout: 120_000 }, async () => {
    const state = newState(30, { entry: ['1h'], confirm: [] });
    const clock = { now: START };
    const open = () => Object.keys((state.core as { positions?: Record<string, unknown> } | null)?.positions ?? {}).sort();
    // Iki pozisyon birden acik olana kadar saatte bir calis.
    while (open().length < 2 && clock.now < END - HOUR) {
      await runUntil(state, clock, clock.now + HOUR, [HOUR]);
    }
    const openKeys = open();
    expect(openKeys).toHaveLength(2);

    // Son calismadan 20 dakika sonra: kapanan yeni mum yok, acik mumun son fiyati kullanilir.
    clock.now += 20 * 60_000;
    await paper.stopPortfolio(state, { now: clock.now, worker, fetchCandles: fakeBinance(clock) });

    expect(state.status).toBe('stopped');
    expect(Object.keys(state.positions as object)).toHaveLength(0);
    const manual = (state.trades as Array<{ reason: string; key: string; exitTime: number; exitPrice: number }>)
      .filter((trade) => trade.reason === 'manual_stop');
    expect(manual.map((trade) => trade.key).sort()).toEqual(openKeys);
    expect(manual.every((trade) => trade.exitTime === clock.now)).toBe(true);
    const report = paper.buildReport(state, clock.now);
    expect(report.status).toBe('stopped');
    expect(report.metrics.openPositions).toBe(0);
  });
});
