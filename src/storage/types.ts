/**
 * Storage katmanı — implementation-agnostic interface'ler.
 *
 * Şu an JSON dosyası, Hafta 5'te SQLite. Çağrı yerleri değişmez.
 */

import type { BotConfig, Trade } from '../types/domain.js';
import type { BacktestRun, BacktestStatus } from '../types/backtest.js';

export interface BotStore {
  list(): Promise<BotConfig[]>;
  get(id: string): Promise<BotConfig | null>;
  create(bot: BotConfig): Promise<BotConfig>;
  update(id: string, patch: Partial<BotConfig>): Promise<BotConfig>;
  delete(id: string): Promise<void>;
}

export interface TradeStore {
  /** En yeniden eskiye sıralı, opsiyonel filtre. */
  list(opts?: { botId?: string; limit?: number; since?: number }): Promise<Trade[]>;
  add(trade: Trade): Promise<Trade>;
  /** Aynı clientOrderId ile gönderildiyse mevcudunu döner (idempotency). */
  findByClientOrderId(clientOrderId: string): Promise<Trade | null>;
}

export interface BacktestStore {
  list(opts?: { limit?: number; status?: BacktestStatus; symbol?: string; strategyFile?: string }): Promise<BacktestRun[]>;
  get(id: string): Promise<BacktestRun | null>;
  create(run: BacktestRun): Promise<BacktestRun>;
  update(id: string, patch: Partial<BacktestRun>): Promise<BacktestRun>;
  delete(id: string): Promise<void>;
}
