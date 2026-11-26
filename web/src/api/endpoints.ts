/**
 * Endpoint fonksiyonları — tek noktada tutalım, route değişirse buradan değiştir.
 */

import { api } from './http';
import type {
  BotConfig,
  BotSnapshot,
  Candle,
  StrategyDrawing,
  Interval,
  OrderBook,
  RecentTrade,
  Ticker24h,
  Trade,
} from '@/types/api';

/* ─── Health ───────────────────────────────────────────── */
export const healthApi = {
  get: () => api.get<{ status: string; uptimeMs: number; env: string }>('/health'),
};

/* ─── Market ───────────────────────────────────────────── */
export const marketApi = {
  symbols: () => api.get<string[]>('/market/symbols'),
  price: (symbol: string) =>
    api.get<{ symbol: string; price: string }>(`/market/price/${symbol}`),
  ticker: (symbol: string) => api.get<Ticker24h>(`/market/ticker/${symbol}`),
  orderBook: (symbol: string, limit = 20) =>
    api.get<OrderBook>(`/market/orderbook/${symbol}?limit=${limit}`),
  recentTrades: (symbol: string, limit = 50) =>
    api.get<RecentTrade[]>(`/market/trades/${symbol}?limit=${limit}`),
  klines: (symbol: string, interval: Interval, limit = 5000) =>
    api.get<Candle[]>(`/market/klines/${symbol}?interval=${interval}&limit=${limit}`),
};

/* ─── Bots ─────────────────────────────────────────────── */

export interface CreateBotInput {
  name: string;
  symbol: string;
  interval: Interval;
  mode?: 'paper' | 'live';
  strategyId: string;
  strategyParams?: Record<string, unknown>;
  capitalUsd?: number;
  risk?: Partial<{
    maxLossPct: number;
    takeProfitPct: number;
    maxPositionUsd: number;
    dailyMaxLossUsd: number;
    stopLossMode: 'percent' | 'target_ratio' | 'strategy';
    stopLossTargetRatio: number;
    leverage: number;
  }>;
}

export const botsApi = {
  list:    () => api.get<BotConfig[]>('/bots'),
  get:     (id: string) => api.get<BotSnapshot>(`/bots/${id}`),
  create:  (input: CreateBotInput) => api.post<BotConfig>('/bots', input),
  update:  (id: string, patch: Partial<CreateBotInput>) =>
    api.patch<BotConfig>(`/bots/${id}`, patch),
  delete:  (id: string) => api.delete<void>(`/bots/${id}`),
  start:   (id: string) => api.post<BotSnapshot>(`/bots/${id}/start`),
  stop:    (id: string) => api.post<BotSnapshot>(`/bots/${id}/stop`),
  pause:   (id: string) => api.post<BotSnapshot>(`/bots/${id}/pause`),
  resume:  (id: string) => api.post<BotSnapshot>(`/bots/${id}/resume`),
  trades:  (id: string, limit = 50) =>
    api.get<Trade[]>(`/bots/${id}/trades?limit=${limit}`),
};

export const paperPortfoliosApi = {
  list: () => api.get<import('@/types/api').PaperPortfolioReport[]>('/paper-portfolios'),
  stop: (sourceFile: string) =>
    api.post<{ queued: boolean }>(`/paper-portfolios/${encodeURIComponent(sourceFile)}/stop`),
  extend: (sourceFile: string, days: number) =>
    api.post<{ queued: boolean }>(`/paper-portfolios/${encodeURIComponent(sourceFile)}/extend`, { days }),
};

/* ─── Strategies ───────────────────────────────────────── */

export interface StrategyMeta {
  filename: string;
  name: string;
  desc: string;
  author: string;
}

export interface StrategyFull extends StrategyMeta {
  code: string;
}

export interface StrategyValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  capabilities: {
    initialize: boolean;
    on_candle: boolean;
    draw: boolean;
  };
}

export const strategiesApi = {
  list: () => api.get<StrategyMeta[]>('/strategies'),
  get: (filename: string) => api.get<StrategyFull>(`/strategies/${encodeURIComponent(filename)}`),
  save: (filename: string, code: string) => api.post<StrategyMeta>('/strategies', { filename, code }),
  validate: (filename: string, code: string) =>
    api.post<StrategyValidation>('/strategies/validate', { filename, code }),
  draw: (filename: string, input: { candles: Candle[]; params?: Record<string, unknown> }) =>
    api.post<{ drawings: StrategyDrawing[] }>(
      `/strategies/${encodeURIComponent(filename)}/draw`,
      input
    ),
};

export interface IndicatorMeta {
  filename: string;
  id: string;
  name: string;
  desc: string;
  author: string;
  category: string;
  drawable: boolean;
}

export interface IndicatorDrawResult {
  drawings: unknown[];
}

export const indicatorsApi = {
  list: () => api.get<IndicatorMeta[]>('/indicators'),
  draw: (filename: string, input: { candles: Candle[]; params?: Record<string, unknown> }) =>
    api.post<IndicatorDrawResult>(`/indicators/${encodeURIComponent(filename)}/draw`, input),
};

/* ─── Dev (backtest, geçici) ───────────────────────────── */

export interface CreateBacktestInput {
  strategyFile: string;
  code?: string;
  symbol: string;
  interval: Interval;
  startTime?: number;
  endTime?: number;
  days?: number;
  initialCapital: number;
  feeBps: number;
  slippageBps: number;
  fillModel: 'close_next_open' | 'pessimistic_ohlc';
  params?: Record<string, unknown>;
  async?: boolean;
}

export interface BacktestSummary {
  initialCapital: number;
  finalCapital: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number | null;
  sharpe: number | null;
  totalTrades: number;
  avgTradePct: number | null;
  bestTradePct: number | null;
  worstTradePct: number | null;
}

export interface PatternStat {
  pattern: string;
  trades: number;
  winRatePct: number;
  profitFactor: number | null;
  totalReturnPct: number;
  maxDrawdownPct: number | null;
}

export interface ObservationStat {
  name: string;
  side: 'long' | 'short';
  count: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgReturnPct: number;
  bestReturnPct: number | null;
  worstReturnPct: number | null;
  tpFirst: number;
  slFirst: number;
  horizon: number;
}

export interface ObservationEvent {
  id: string;
  name: string;
  side: 'long' | 'short';
  signalTime: number;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  returnPct: number;
  success: boolean;
  reason: 'tp' | 'sl' | 'horizon' | 'end_of_data';
  horizonBars: number;
  meta?: Record<string, unknown>;
}

export interface BacktestTrade {
  id: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  slPrice?: number | null;
  tpPrice?: number | null;
  exitTime: number;
  exitPrice: number;
  qty: number;
  notional?: number;
  grossPnl: number;
  netPnl: number;
  pnlPct: number;
  accountReturnPct?: number;
  feePaid: number;
  reason: 'tp' | 'sl' | 'signal' | 'timeout' | 'end_of_test';
  meta?: Record<string, unknown>;
}

export interface PeriodReport {
  period: number;
  startTime: number;
  endTime: number;
  startEquity: number;
  endEquity: number;
  pnl: number;
  returnPct: number;
  realizedPnl: number;
  realizedReturnPct: number;
  openPnl: number;
  openReturnPct: number;
  feePaid: number;
  trades: number;
  tpTrades: number;
  slTrades: number;
  signalTrades: number;
  endTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

export type BacktestProgressStage =
  | 'queued'
  | 'fetching_data'
  | 'loading_worker'
  | 'running_strategy'
  | 'finalizing'
  | 'completed'
  | 'failed';

export interface BacktestProgress {
  stage: BacktestProgressStage;
  pct: number;
  message: string;
  startedAt: number;
  updatedAt: number;
  candlesFetched?: number;
  estimatedCandles?: number;
  candleCount?: number;
}

export interface BacktestRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  strategyFile: string;
  strategyHash: string;
  symbol: string;
  interval: Interval;
  startTime: number;
  endTime: number;
  candleCount: number;
  initialCapital: number;
  params: Record<string, unknown>;
  assumptions: {
    feeBps: number;
    slippageBps: number;
    fillModel: 'close_next_open' | 'pessimistic_ohlc';
    sameCandleTpSl: 'stop_first' | 'take_profit_first';
  };
  progress?: BacktestProgress;
  summary?: BacktestSummary;
  patterns?: PatternStat[];
  observationStats?: ObservationStat[];
  observations?: ObservationEvent[];
  periodReports?: PeriodReport[];
  trades?: BacktestTrade[];
  equity?: Array<{ t: number; value: number }>;
  raw?: Record<string, unknown>;
  error?: string;
}

export const backtestsApi = {
  list: (limit = 20) => api.get<BacktestRun[]>(`/backtests?limit=${limit}`),
  get: (id: string) => api.get<BacktestRun>(`/backtests/${id}`),
  create: (input: CreateBacktestInput) => api.post<BacktestRun>('/backtests', input),
  delete: (id: string) => api.delete<void>(`/backtests/${id}`),
};

export interface BacktestParams {
  instance: string;
  symbol: string;
  interval: Interval;
  days?: number;
  params?: Record<string, unknown>;
}

export interface BacktestResult {
  trades?: number;
  winRate?: number;
  totalPnl?: number;
  maxDrawdown?: number;
  // Backend strategy bağımlı, esnek tutuyoruz
  [key: string]: unknown;
}

export const devApi = {
  poolStats: () => api.get<unknown>('/dev/pool/stats'),
  poolLoad: (instance: string, strategy_file: string) =>
    api.post<unknown>('/dev/pool/load', { instance, strategy_file }),
  poolDrop: (instance: string) =>
    api.post<unknown>('/dev/pool/drop', { instance }),
  backtest: (params: BacktestParams) =>
    api.post<BacktestResult>('/dev/pool/backtest', params),
};
