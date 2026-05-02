/**
 * Frontend'de geçici indikatör hesaplamaları.
 *
 * Hafta 4-5'te bu işi backend'e taşıyacağız (Python indikatör servisi).
 * Şu an chart üzerinde EMA ve RSI'ı göstermek için lokal hesaplıyoruz.
 */

import type { Candle } from '@/types/api';

/** Exponential Moving Average — Wilder smoothing değil, klasik EMA. */
export function computeEMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  if (values.length === 0) return out;
  const k = 2 / (period + 1);

  // İlk EMA = ilk N değerin SMA'i
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      const slice = values.slice(0, period);
      ema = slice.reduce((a, b) => a + b, 0) / period;
      out.push(ema);
      continue;
    }
    ema = values[i]! * k + ema! * (1 - k);
    out.push(ema);
  }
  return out;
}

/** Wilder RSI — TradingView ile aynı formül. */
export function computeRSI(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;

  // İlk period kadar kazanç/kayıp ortalaması
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }

  return out;
}

/** Candle dizisinden close array'i. */
export function closesOf(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}
