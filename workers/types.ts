/**
 * Python worker pool tipleri.
 */

import type { Candle } from '../types/domain.js';

/* ─── Strateji request/response ────────────────────────────── */

export interface PortfolioState {
  usdt: number;
  has_position: boolean;
  pnl: number;
  side?: 'BUY' | 'SELL';
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
  sl_price?: number | null;
  tp_price?: number | null;
  observations?: unknown[];
  drawings: unknown[];
}

export interface LoadRequest {
  instance: string;
  strategy_file: string;
  params?: Record<string, unknown>;
}

export interface LoadCodeRequest {
  instance: string;
  strategy_file: string;
  source_code: string;
  params?: Record<string, unknown>;
}

export interface LoadResponse {
  config: Record<string, unknown>;
  file: string;
}

export interface BacktestRequest {
  instance: string;
  candles: CandleRaw[];
  initial_capital?: number;
  fee_bps?: number;
  slippage_bps?: number;
  fill_model?: 'close_next_open' | 'pessimistic_ohlc';
  params?: Record<string, unknown>;
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
