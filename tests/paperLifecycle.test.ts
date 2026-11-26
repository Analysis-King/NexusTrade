import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lifecycle = require('../scripts/lib/paper_lifecycle.cjs');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 26, 12);

type Candle = { t: number; o: number; h: number; l: number; c: number; closeTime: number };

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'running',
    stopAt: NOW + DAY,
    stopAtIso: new Date(NOW + DAY).toISOString(),
    positions: {} as Record<string, Record<string, unknown>>,
    lastMarks: {} as Record<string, number>,
    trades: [] as Array<Record<string, unknown>>,
    ...overrides,
  };
}

describe('paper portfoy yasam dongusu', () => {
  test('planlanan bitisten sonra yeni islem acilmaz; acik pozisyon varken closing olur', () => {
    const state = makeState({ stopAt: NOW - 1, positions: { BTCUSDT: { symbol: 'BTCUSDT' } } });
    expect(lifecycle.acceptingEntries(state, NOW)).toBe(false);
    expect(lifecycle.lifecycleStatus(state, NOW)).toBe('closing');
    state.positions = {};
    expect(lifecycle.lifecycleStatus(state, NOW)).toBe('completed');
    expect(lifecycle.acceptingEntries(makeState(), NOW)).toBe(true);
  });

  test('uzatma bitisi simdiden ileri alir ve yeniden islem actirir', () => {
    const state = makeState({ stopAt: NOW - 10 * DAY });
    lifecycle.extendStopAt(state, 30, NOW);
    expect(state.stopAt).toBe(NOW + 30 * DAY);
    expect(lifecycle.acceptingEntries(state, NOW)).toBe(true);
    expect(() => lifecycle.extendStopAt(state, 0, NOW)).toThrow();
    expect(() => lifecycle.extendStopAt(makeState({ status: 'stopped' }), 30, NOW)).toThrow();
  });

  test('bitmis testin suresi son islemde donar', () => {
    const lastExit = NOW - 2 * DAY;
    const state = makeState({ stopAt: NOW - 5 * DAY, trades: [{ exitTime: lastExit }] });
    expect(lifecycle.reportEndTime(state, NOW)).toBe(lastExit);
    expect(lifecycle.reportEndTime(makeState(), NOW)).toBe(NOW);
  });

  test('durdurma: SL kapanmis mumda vurulduysa SL kurali, kalan son fiyattan kapanir', async () => {
    const state = makeState({
      positions: {
        'AAAUSDT|1h': { symbol: 'AAAUSDT', interval: '1h', sl: 90 },
        'BBBUSDT|4h': { symbol: 'BBBUSDT', interval: '4h', sl: 50 },
      },
    });
    const closedCandle = (low: number): Candle => ({ t: NOW - 2 * 3_600_000, o: 100, h: 101, l: low, c: 100, closeTime: NOW - 3_600_000 });
    const openCandle: Candle = { t: NOW - 600_000, o: 100, h: 100, l: 100, c: 97, closeTime: NOW + 3_000_000 };
    const fetched: string[] = [];
    const closes: Array<{ key: string; price: number; reason: string }> = [];
    const keyOf = (position: Record<string, unknown>) => `${position.symbol}|${position.interval}`;

    await lifecycle.stopAndCloseAll(state, {
      now: NOW,
      candleLimit: 10,
      positionInterval: (position: { interval: string }) => position.interval,
      fetchCandles: async (symbol: string, interval: string) => {
        fetched.push(`${symbol}|${interval}`);
        return symbol === 'AAAUSDT' ? [closedCandle(85), openCandle] : [closedCandle(80), openCandle];
      },
      processPositionCandles: (s: typeof state, key: string, candles: Candle[]) => {
        const position = s.positions[key];
        if (position && candles.some((candle) => candle.l <= Number(position.sl))) {
          closes.push({ key, price: Number(position.sl), reason: 'sl' });
          delete s.positions[key];
        }
      },
      closePosition: (s: typeof state, position: Record<string, unknown>, price: number, _t: number, reason: string) => {
        closes.push({ key: keyOf(position), price, reason });
        delete s.positions[keyOf(position)];
      },
    });

    expect(fetched).toEqual(['AAAUSDT|1h', 'BBBUSDT|4h']);
    expect(closes).toEqual([
      { key: 'AAAUSDT|1h', price: 90, reason: 'sl' },
      { key: 'BBBUSDT|4h', price: 97, reason: 'manual_stop' },
    ]);
    expect(state.status).toBe('stopped');
    expect(lifecycle.lifecycleStatus(state, NOW)).toBe('stopped');
    expect(lifecycle.remainingMs(state, NOW)).toBe(0);
  });

  test('durdurmada fiyat alinamazsa durum degismez', async () => {
    const state = makeState({ positions: { AAAUSDT: { symbol: 'AAAUSDT' } } });
    await expect(lifecycle.stopAndCloseAll(state, {
      now: NOW,
      candleLimit: 10,
      positionInterval: () => '1h',
      fetchCandles: async () => { throw new Error('HTTP 418'); },
      processPositionCandles: () => undefined,
      closePosition: () => undefined,
    })).rejects.toThrow('HTTP 418');
    expect(state.status).toBe('running');
    expect(Object.keys(state.positions)).toEqual(['AAAUSDT']);
  });
});
