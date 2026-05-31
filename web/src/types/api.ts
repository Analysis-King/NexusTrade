/**
 * Backend domain tipleri — mirror.
 *
 * src/types/domain.ts'in eşi. İdealde OpenAPI/codegen ile otomatik tutarız;
 * şimdilik elle senkron — değişirse iki yerde de güncellenir.
 */

export type Interval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'STOP_LOSS_LIMIT' | 'TAKE_PROFIT_LIMIT';
export type BotStatus = 'idle' | 'running' | 'paused' | 'error' | 'stopped';
export type BotMode = 'paper' | 'live';
export type Signal = 'buy' | 'sell' | 'hold';
export type StopLossMode = 'percent' | 'target_ratio' | 'strategy';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface BotRiskConfig {
  maxLossPct: number;
  takeProfitPct: number;
  maxPositionUsd: number;
  dailyMaxLossUsd: number;
  stopLossMode?: StopLossMode;
  stopLossTargetRatio?: number;
  leverage?: number;
}

export interface BotConfig {
  id: string;
  name: string;
  symbol: string;
  interval: Interval;
  mode: BotMode;
  status: BotStatus;
  strategyId: string;
  strategyParams: Record<string, unknown>;
  risk: BotRiskConfig;
  capitalUsd: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface Position {
  botId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  unrealizedPnlUsd?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  openedAt: number;
}

export interface DrawingPoint {
  time: number;
  price?: number;
  value?: number;
}

export type StrategyDrawing =
  | {
      type: 'plot';
      title?: string;
      points: DrawingPoint[];
      color?: string;
      linewidth?: number;
      style?: string;
      linestyle?: string;
      group?: string;
      force_overlay?: boolean;
    }
  | {
      type: 'line';
      first: DrawingPoint;
      second: DrawingPoint;
      color?: string;
      style?: string;
      width?: number;
      group?: string;
      force_overlay?: boolean;
    }
  | {
      type: 'label';
      point: DrawingPoint;
      text?: string;
      color?: string;
      textcolor?: string;
      style?: string;
      size?: string;
      group?: string;
      force_overlay?: boolean;
    };

export interface Trade {
  id: string;
  botId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number;
  feeUsd: number;
  pnlUsd?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  mode: BotMode;
  exchangeOrderId?: string;
  clientOrderId: string;
  createdAt: number;
}

export interface BotSnapshot {
  config: BotConfig;
  state: {
    position: Position | null;
    realizedPnlUsd: number;
    todayPnlUsd: number;
    candleCount: number;
    lastTickAt: number | null;
    lastSignal: Signal | null;
    drawings: StrategyDrawing[];
  };
}

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}

export interface OrderBook {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface RecentTrade {
  id: number;
  price: string;
  qty: string;
  time: number;
  isBuyerMaker: boolean;
}

/* ─── API zarfı ────────────────────────────────────────── */

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
