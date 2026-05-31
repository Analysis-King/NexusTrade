/**
 * Storage factory — implementasyon seçimi tek noktada.
 *
 * Hafta 5'te buraya SQLite implementasyonu eklenecek ve flag ile değiştirilecek.
 * Geri kalan kod hep `getStorage()` üzerinden erişir.
 */

import { env } from '../config/env.js';
import { JsonBotStore } from './json/botStore.js';
import { JsonTradeStore } from './json/tradeStore.js';
import { JsonBacktestStore } from './json/backtestStore.js';
import type { BacktestStore, BotStore, TradeStore } from './types.js';

export interface Storage {
  bots: BotStore;
  trades: TradeStore;
  backtests: BacktestStore;
}

let instance: Storage | null = null;

export function getStorage(): Storage {
  if (!instance) {
    const dataDir = env.DATA_DIR;
    instance = {
      bots: new JsonBotStore(dataDir),
      trades: new JsonTradeStore(dataDir),
      backtests: new JsonBacktestStore(dataDir),
    };
  }
  return instance;
}
