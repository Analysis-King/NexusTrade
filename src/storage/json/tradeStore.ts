/**
 * JSON dosya tabanlı TradeStore.
 *
 * Trade history append-only mantığında çalışır. Son N trade tutulur (default: 5000).
 * Idempotency için clientOrderId üzerinden lookup desteklenir.
 */

import path from 'node:path';
import type { Trade } from '../../types/domain.js';
import type { TradeStore } from '../types.js';
import { readJson, writeJson } from './atomicFile.js';

interface TradesFile {
  version: 1;
  trades: Trade[];
}

const MAX_TRADES = 5000;

export class JsonTradeStore implements TradeStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'trades.json');
  }

  private async readAll(): Promise<TradesFile> {
    return readJson<TradesFile>(this.filePath, { version: 1, trades: [] });
  }

  async list(opts: { botId?: string; limit?: number; since?: number } = {}): Promise<Trade[]> {
    const data = await this.readAll();
    let trades = data.trades;
    if (opts.botId) trades = trades.filter((t) => t.botId === opts.botId);
    if (opts.since !== undefined) {
      const since = opts.since;
      trades = trades.filter((t) => t.createdAt >= since);
    }
    // En yeniden eskiye
    trades = [...trades].sort((a, b) => b.createdAt - a.createdAt);
    if (opts.limit) trades = trades.slice(0, opts.limit);
    return trades;
  }

  async add(trade: Trade): Promise<Trade> {
    const data = await this.readAll();

    // Idempotency: aynı clientOrderId varsa mevcudunu döndür, yenisini ekleme
    const existing = data.trades.find((t) => t.clientOrderId === trade.clientOrderId);
    if (existing) return existing;

    data.trades.push(trade);
    // Trim — en eski olanları at
    if (data.trades.length > MAX_TRADES) {
      data.trades = data.trades.slice(-MAX_TRADES);
    }
    await writeJson(this.filePath, data);
    return trade;
  }

  async findByClientOrderId(clientOrderId: string): Promise<Trade | null> {
    const data = await this.readAll();
    return data.trades.find((t) => t.clientOrderId === clientOrderId) ?? null;
  }
}
