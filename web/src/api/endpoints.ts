/**
 * Endpoint fonksiyonları — tek noktada tutalım, route değişirse buradan değiştir.
 */

import { api } from './http';
import type {
  BotConfig,
  BotSnapshot,
  Candle,
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
  klines: (symbol: string, interval: Interval, limit = 500) =>
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

/* ─── Strategies ───────────────────────────────────────── */

export interface StrategyMeta {
  filename: string;
  name: string;
  desc: string;
  author: string;
}

export const strategiesApi = {
  list: () => api.get<StrategyMeta[]>('/strategies'),
};

/* ─── Dev (backtest, geçici) ───────────────────────────── */

export interface BacktestParams {
  instance: string;
  symbol: string;
  interval: Interval;
  days?: number;
  min_quality?: number;
  tp_mode?: string;
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
