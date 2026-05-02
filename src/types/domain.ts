/**
 * NexusTrade domain tipleri.
 *
 * Bu dosya iş mantığı modellerinin tek kaynak doğrusudur (single source of truth).
 * API contract'ı, storage, frontend tipleri buradan türetilir.
 */

/* ─── Binance / Market ─────────────────────────────────────── */

export type Interval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'STOP_LOSS_LIMIT' | 'TAKE_PROFIT_LIMIT';
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface SymbolFilters {
  /** Fiyat tickSize, lotSize stepSize gibi Binance kuralları. */
  tickSize: number;
  stepSize: number;
  minNotional: number;
  minQty: number;
}

/* ─── Bot ──────────────────────────────────────────────────── */

export type BotStatus = 'idle' | 'running' | 'paused' | 'error' | 'stopped';
export type BotMode = 'paper' | 'live';

export interface BotRiskConfig {
  /** Yüzde olarak (örn. 2 = %2) — bot başına. */
  maxLossPct: number;
  /** Yüzde olarak — bot başına. */
  takeProfitPct: number;
  /** USDT cinsinden — bot başına maksimum açık pozisyon. */
  maxPositionUsd: number;
  /** USDT cinsinden — günlük zarar limiti, aşılırsa bot durur. */
  dailyMaxLossUsd: number;
}

export interface BotConfig {
  id: string;
  name: string;
  symbol: string;
  interval: Interval;
  mode: BotMode;
  status: BotStatus;
  /** Hangi strateji dosyası kullanılacak. */
  strategyId: string;
  /** Stratejiye geçilecek parametre objesi (strateji-spesifik). */
  strategyParams: Record<string, unknown>;
  risk: BotRiskConfig;
  /** Sermaye — paper modda sanal, live modda referans. */
  capitalUsd: number;
  createdAt: number;
  updatedAt: number;
  /** Son hata mesajı (status === 'error' ise). */
  lastError?: string;
}

/* ─── Trade & Pozisyon ─────────────────────────────────────── */

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
  mode: BotMode;
  /** Binance'de ilgili order ID (live modda). */
  exchangeOrderId?: string;
  /** Idempotency için client-side ID. */
  clientOrderId: string;
  createdAt: number;
}

export interface Position {
  botId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  /** Anlık fiyatla hesaplanan PnL (servis tarafında türetilir). */
  unrealizedPnlUsd?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  openedAt: number;
}

/* ─── Strateji & İndikatör ─────────────────────────────────── */

export interface StrategyMetadata {
  id: string;
  name: string;
  description: string;
  /** Beklenen parametre şeması — UI form üretimi için. */
  paramsSchema: ParamsSchema;
  /** Hangi indikatörlere ihtiyacı var (UI ön-yükleme için). */
  indicators?: string[];
}

export interface ParamsSchema {
  fields: ParamsField[];
}

export interface ParamsField {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'select';
  default: unknown;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
}

/* ─── API contract — generic response zarfı ────────────────── */

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
