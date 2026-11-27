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

export interface FootprintLevelRaw {
  price: number;
  buy_volume: number;
  sell_volume: number;
  delta: number;
  total_volume: number;
  buy_trades: number;
  sell_trades: number;
}

export interface FootprintRaw {
  t: number;
  complete: boolean;
  trades: number;
  buy_trades: number;
  sell_trades: number;
  buy_volume: number;
  sell_volume: number;
  delta: number;
  total_volume: number;
  buy_notional: number;
  sell_notional: number;
  delta_notional: number;
  total_notional: number;
  poc_price: number | null;
  levels: FootprintLevelRaw[];
}

export type Signal = 'buy' | 'sell' | 'close' | 'hold';

export interface TickRequest {
  instance: string;
  candle: CandleRaw;
  candles: CandleRaw[];
  footprint?: FootprintRaw | null;
  footprints?: FootprintRaw[];
  portfolio: PortfolioState;
}

export interface TickResponse {
  signal: Signal;
  sl_pct: number | null;
  tp_pct: number | null;
  sl_price?: number | null;
  tp_price?: number | null;
  meta?: Record<string, unknown>;
  observations?: unknown[];
  drawings: unknown[];
}

/**
 * Yurutme cekirdeginin (python/workers/execution_core.py) JSON durumu. Icerigi Python tarafinda
 * tanimli; TS tarafi saklar ve bir sonraki adimda aynen geri gonderir.
 */
export type PaperCoreState = Record<string, unknown>;

/** Cekirdekteki acik pozisyon (execution_core._open_position). */
export interface PaperCorePosition {
  side: 'long' | 'short';
  entry_time: number;
  entry_price: number;
  qty: number;
  notional: number;
  entry_fee: number;
  sl: number | null;
  tp: number | null;
  meta: Record<string, unknown>;
}

/** Cekirdekte kapanan islem (execution_core._close_position). */
export interface PaperCoreTrade {
  id: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  slPrice: number | null;
  tpPrice: number | null;
  exitTime: number;
  exitPrice: number;
  qty: number;
  notional: number;
  grossPnl: number;
  netPnl: number;
  pnlPct: number;
  accountReturnPct: number;
  feePaid: number;
  reason: string;
  meta: Record<string, unknown>;
}

export interface PaperStepRequest {
  instance: string;
  candle: CandleRaw;
  candles: CandleRaw[];
  state: PaperCoreState | null;
  initial_capital: number;
  fee_bps: number;
  slippage_bps: number;
  fill_model?: string;
  /** false: duraklatilmis bot, strateji calismaz, sadece SL/TP. */
  run_strategy?: boolean;
  footprint?: FootprintRaw | null;
  footprints?: FootprintRaw[];
  include_drawings?: boolean;
}

export interface PaperStepResponse {
  state: PaperCoreState;
  opened: PaperCorePosition[];
  closed: PaperCoreTrade[];
  position: PaperCorePosition | null;
  equity: number;
  mark: number;
  signal: Signal;
  meta: Record<string, unknown>;
  drawings: unknown[];
}

export interface DrawRequest {
  instance: string;
  candles: CandleRaw[];
}

export interface DrawResponse {
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
  capabilities?: {
    footprint?: boolean;
  };
}

export interface ValidateStrategyResponse {
  ok: boolean;
  errors: string[];
  warnings: string[];
  capabilities: {
    initialize: boolean;
    on_candle: boolean;
    draw: boolean;
  };
}

export interface BacktestRequest {
  instance: string;
  candles: CandleRaw[];
  footprints?: FootprintRaw[];
  initial_capital?: number;
  fee_bps?: number;
  slippage_bps?: number;
  fill_model?: 'close_next_open' | 'pessimistic_ohlc';
  params?: Record<string, unknown>;
  /** Stratejiye en fazla bu kadar son mum ver (paper bot 500); 0/yok = tüm geçmiş. */
  max_history_bars?: number;
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
