/**
 * Market data yardımcıları.
 *
 * - Binance kline raw array'lerini tipli Candle'a çevirir
 * - fetchHistorical: backtest için sayfalı geçmiş veri çeker
 */

import type { Candle, Interval } from '../../types/domain.js';
import type { BinanceClient } from './client.js';
import type { BinanceKlineRaw } from './types.js';

/** Binance raw kline → Candle. */
export function klineToCandle(k: BinanceKlineRaw): Candle {
  return {
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
  };
}

/** Interval → milisaniye. */
const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '1M': 30 * 24 * 60 * 60_000, // yaklaşık
};

export function intervalToMs(interval: Interval): number {
  return INTERVAL_MS[interval];
}

/**
 * Geçmiş veri çek — sayfalama ile, rate limit'e dikkat ederek.
 *
 * @param days Kaç gün geriye gidilecek
 * @param batchSize Her istekte kaç kline (max 1000)
 */
export async function fetchHistorical(
  client: BinanceClient,
  symbol: string,
  interval: Interval,
  days: number,
  batchSize = 1000
): Promise<Candle[]> {
  const totalMs = days * 24 * 60 * 60 * 1000;
  let since = Date.now() - totalMs;
  const all: Candle[] = [];

  while (true) {
    const raw = await client.klines({ symbol, interval, startTime: since, limit: batchSize });
    if (raw.length === 0) break;

    for (const k of raw) all.push(klineToCandle(k));

    const lastClose = raw[raw.length - 1]![6];
    since = lastClose + 1;

    if (raw.length < batchSize) break;

    // Binance rate limit'e karşı küçük gecikme
    await new Promise((r) => setTimeout(r, 250));
  }

  return all;
}
