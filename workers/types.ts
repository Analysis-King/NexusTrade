/**
 * Python worker pool tipleri.
 */

import type { Candle } from '../types/domain.js';

/* ─── Strateji request/response ────────────────────────────── */

export interface PortfolioState {
  usdt: number;
  has_position: boolean;
  pnl: number;
}

export interface CandleRaw {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Signal = 'buy' | 'sell' | 'hold';

export interface TickRequest {
  instance: string;
  candle: CandleRaw;
  candles: CandleRaw[];
  portfolio: PortfolioState;
}

export interface TickResponse {
  signal: Signal;
  sl_pct: number | null;
  tp_pct: number | null;
  drawings: unknown[];
}

export interface LoadRequest {
  instance: string;
  strategy_file: string;
}

export interface LoadResponse {
  config: Record<string, unknown>;
  file: string;
}

export interface BacktestRequest {
  instance: string;
  candles: CandleRaw[];
  min_quality?: number;
  tp_mode?: string;
}

export type BacktestResponse = Record<string, unknown>;

/** Domain Candle → worker raw format. */
export function candleToRaw(c: Candle): CandleRaw {
  return {
    t: c.openTime,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
  };
}
