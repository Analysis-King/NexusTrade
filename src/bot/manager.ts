/**
 * BotManager — tüm bot'ları yönetir.
 *
 * - CRUD operasyonları (storage ile bağlantılı)
 * - BotRunner instance'larını tutar (memory'de)
 * - Sunucu açılışında "running" botları otomatik resume eder
 * - Kapanışta hepsini stop eder
 * - Her bot olayını dış dünyaya forward eder (frontend WS broadcast'i için)
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import type { Storage } from '../storage/index.js';
import type { BotConfig, BotMode, BotRiskConfig, Interval, Position, Trade } from '../types/domain.js';
import type { Signal } from '../workers/types.js';
import { BotRunner } from './runner.js';

const log = createLogger('bot-manager');

export interface CreateBotInput {
  name: string;
  symbol: string;
  interval: Interval;
  mode?: BotMode;
  strategyId: string;
  strategyParams?: Record<string, unknown>;
  capitalUsd?: number;
  risk?: Partial<BotRiskConfig>;
}

export type UpdateBotInput = Omit<Partial<BotConfig>, 'risk'> & {
  risk?: Partial<BotRiskConfig>;
};

const DEFAULT_RISK: BotRiskConfig = {
  maxLossPct: 2,
  takeProfitPct: 4,
  maxPositionUsd: 100,
  dailyMaxLossUsd: 50,
  stopLossMode: 'target_ratio',
  stopLossTargetRatio: 0.2,
  leverage: 1,
};

export class BotManager extends EventEmitter {
  private runners = new Map<string, BotRunner>();
  private started = false;

  constructor(private readonly storage: Storage) {
    super();
    this.setMaxListeners(0);
  }

  /**
   * Sunucu açılışında çağrılır — kayıtlı bot'ları memory'e yükler.
   *
   * - Paper modda 'running' olanları otomatik tekrar başlat (risk yok)
   * - Live modda 'running' olanları paused yap (manuel resume bekle)
   */
  async bootstrap(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const all = await this.storage.bots.list();
    log.info({ count: all.length }, 'Botlar yukleniyor');

    for (const cfg of all) {
      const runner = this.makeRunner(cfg);
      this.runners.set(cfg.id, runner);

      if (cfg.status === 'running') {
        if (cfg.mode === 'paper') {
          // Paper mod — restart sonrası otomatik devam et
          try {
            await runner.start();
            log.info({ botId: cfg.id }, "Paper bot otomatik baslatildi");
          } catch (err) {
            log.error({ botId: cfg.id, err }, 'Paper bot baslatilamadi');
          }
        } else {
          // Live mod — kullanıcı manuel resume etmeli (otomatik emir vermesin)
          await this.storage.bots.update(cfg.id, { status: 'paused' });
          log.info({ botId: cfg.id }, "Live bot 'paused' olarak yuklendi (manuel resume gerekli)");
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    log.info({ count: this.runners.size }, 'Botlar durduruluyor');
    await Promise.allSettled([...this.runners.values()].map((r) => r.stop()));
    this.runners.clear();
  }

  /* ─── CRUD ─────────────────────────────────────────────── */

  async list(): Promise<BotConfig[]> {
    return this.storage.bots.list();
  }

  async getSnapshot(id: string): Promise<ReturnType<BotRunner['getSnapshot']>> {
    const runner = this.runners.get(id);
    if (runner) return this.withPersistedPnl(id, runner.getSnapshot());
    const cfg = await this.storage.bots.get(id);
    if (!cfg) throw new NotFoundError(`Bot ${id}`);
    // Runner yoksa da sahte snapshot dön
    return this.withPersistedPnl(id, {
      config: cfg,
      state: {
        position: null,
        realizedPnlUsd: 0,
        todayPnlUsd: 0,
        candleCount: 0,
        lastTickAt: null,
        lastSignal: null,
        drawings: [],
      },
    });
  }

  async create(input: CreateBotInput): Promise<BotConfig> {
    // Aynı isim ve sembolde var mı kontrolü
    const existing = await this.storage.bots.list();
    if (existing.some((b) => b.name === input.name)) {
      throw new ConflictError(`Bu isimde bir bot zaten var: ${input.name}`);
    }

    const now = Date.now();
    const cfg: BotConfig = {
      id: randomUUID(),
      name: input.name,
      symbol: input.symbol.toUpperCase(),
      interval: input.interval,
      mode: input.mode ?? 'paper',
      status: 'idle',
      strategyId: input.strategyId,
      strategyParams: input.strategyParams ?? {},
      risk: { ...DEFAULT_RISK, ...input.risk },
      capitalUsd: input.capitalUsd ?? 1000,
      createdAt: now,
      updatedAt: now,
    };

    await this.storage.bots.create(cfg);
    this.runners.set(cfg.id, this.makeRunner(cfg));
    this.emit('created', cfg);
    log.info({ botId: cfg.id, name: cfg.name }, 'Bot olusturuldu');
    return cfg;
  }

  async update(id: string, patch: UpdateBotInput): Promise<BotConfig> {
    const cfg = await this.storage.bots.get(id);
    if (!cfg) throw new NotFoundError(`Bot ${id}`);
    const runner = this.runners.get(id);
    if (runner && cfg.status === 'running') {
      throw new ConflictError("Calisan bot duzenlenemez, once durdurun");
    }
    const { risk, ...rest } = patch;
    const storagePatch: Partial<BotConfig> = { ...rest };
    if (risk) {
      storagePatch.risk = { ...cfg.risk, ...risk };
    }
    const updated = await this.storage.bots.update(id, storagePatch);

    // Runner'in config'ini de yenile. Eski runner (orn. duraklatilmis) hala
    // stream'e abone ve yoklama zamanlayicisi acik olabilir — once kapat,
    // yoksa arkada "zombi" runner kalir.
    if (runner) {
      await runner.dispose();
      this.runners.set(id, this.makeRunner(updated));
    }
    this.emit('updated', updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const runner = this.runners.get(id);
    if (runner) {
      await runner.stop().catch(() => undefined);
      this.runners.delete(id);
    }
    await this.storage.bots.delete(id);
    this.emit('deleted', { id });
    log.info({ botId: id }, 'Bot silindi');
  }

  /* ─── Lifecycle aksiyonları ────────────────────────────── */

  async start(id: string): Promise<void> {
    const runner = await this.ensureRunner(id);
    await runner.start();
  }

  async stop(id: string): Promise<void> {
    const runner = this.runners.get(id);
    if (!runner) throw new NotFoundError(`Bot ${id}`);
    await runner.stop();
  }

  async pause(id: string): Promise<void> {
    const runner = this.runners.get(id);
    if (!runner) throw new NotFoundError(`Bot ${id}`);
    await runner.pause();
  }

  async resume(id: string): Promise<void> {
    const runner = this.runners.get(id);
    if (!runner) throw new NotFoundError(`Bot ${id}`);
    await runner.resume();
  }

  /* ─── Internal ─────────────────────────────────────────── */

  private async ensureRunner(id: string): Promise<BotRunner> {
    const existing = this.runners.get(id);
    if (existing) return existing;
    const cfg = await this.storage.bots.get(id);
    if (!cfg) throw new NotFoundError(`Bot ${id}`);
    const runner = this.makeRunner(cfg);
    this.runners.set(id, runner);
    return runner;
  }

  private makeRunner(cfg: BotConfig): BotRunner {
    const runner = new BotRunner(cfg, this.storage);
    // Tüm runner olaylarını manager üzerinden forward et
    for (const evt of [
      'started',
      'stopped',
      'paused',
      'resumed',
      'updated',
      'position-opened',
      'position-closed',
      'risk-limit',
    ]) {
      runner.on(evt, (payload: unknown) => {
        this.emit(evt, { botId: cfg.id, ...((payload as object) ?? {}) });
        this.emit('any', { type: evt, botId: cfg.id, payload });
      });
    }
    return runner;
  }

  private async withPersistedPnl(
    id: string,
    snapshot: ReturnType<BotRunner['getSnapshot']>
  ): Promise<ReturnType<BotRunner['getSnapshot']>> {
    const summary = await this.tradeSummary(id, snapshot.config);
    return {
      ...snapshot,
      state: {
        ...snapshot.state,
        position: snapshot.state.position ?? summary.position,
        realizedPnlUsd: summary.total,
        todayPnlUsd: summary.today,
        lastSignal: snapshot.state.lastSignal ?? summary.lastSignal,
      },
    };
  }

  private async tradeSummary(
    botId: string,
    cfg: BotConfig
  ): Promise<{ total: number; today: number; position: Position | null; lastSignal: Signal | null }> {
    const trades = await this.storage.trades.list({ botId });
    const todayStart = startOfUtcDay(Date.now());
    let total = 0;
    let today = 0;
    let position: Position | null = null;
    const lastSignal = lastOpeningSignalFromTrades(trades);

    for (const trade of trades) {
      const pnl = typeof trade.pnlUsd === 'number' ? trade.pnlUsd : 0;
      total += pnl;
      if (trade.createdAt >= todayStart) today += pnl;
    }

    for (const trade of [...trades].sort((a, b) => a.createdAt - b.createdAt)) {
      if (isClosingTrade(trade)) {
        position = null;
        continue;
      }
      position = positionFromOpenTrade(cfg, trade);
    }

    return { total: roundMoney(total), today: roundMoney(today), position, lastSignal };
  }
}

/* ─── Singleton ────────────────────────────────────────── */

let manager: BotManager | null = null;

export function getBotManager(storage?: Storage): BotManager {
  if (!manager) {
    if (!storage) throw new Error('BotManager ilk init icin storage gerekli');
    manager = new BotManager(storage);
  }
  return manager;
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function isClosingTrade(trade: Trade): boolean {
  return typeof trade.pnlUsd === 'number';
}

function lastOpeningSignalFromTrades(trades: Trade[]): Signal | null {
  const trade = trades.find((item) => !isClosingTrade(item));
  return trade ? signalFromTrade(trade) : null;
}

function signalFromTrade(trade: Trade): Signal {
  return trade.side === 'BUY' ? 'buy' : 'sell';
}

function positionFromOpenTrade(cfg: BotConfig, trade: Trade): Position {
  return {
    botId: cfg.id,
    symbol: trade.symbol,
    side: trade.side,
    quantity: trade.quantity,
    entryPrice: trade.price,
    stopLossPrice:
      trade.stopLossPrice ??
      resolveStopLossPrice(
        trade.side,
        trade.price,
        cfg.risk,
        cfg.risk.maxLossPct,
        undefined,
        trade.takeProfitPrice ?? fallbackTakeProfit(trade.side, trade.price, cfg.risk.takeProfitPct)
      ),
    takeProfitPrice: trade.takeProfitPrice ?? fallbackTakeProfit(trade.side, trade.price, cfg.risk.takeProfitPct),
    meta: trade.meta,
    openedAt: trade.createdAt,
  };
}

function resolveStopLossPrice(
  side: Trade['side'],
  entry: number,
  risk: BotConfig['risk'],
  slPct: number | null,
  strategySlPrice: number | null | undefined,
  takeProfitPrice: number | undefined
): number | undefined {
  const mode = risk.stopLossMode ?? 'target_ratio';
  if (mode === 'target_ratio' && takeProfitPrice !== undefined) {
    const ratio = normalizePositive(risk.stopLossTargetRatio, 0.2);
    const distance = Math.abs(takeProfitPrice - entry);
    if (distance > 0) return side === 'BUY' ? entry - distance * ratio : entry + distance * ratio;
  }
  if (mode === 'strategy' && strategySlPrice !== null && strategySlPrice !== undefined) {
    return strategySlPrice;
  }
  return fallbackStopLoss(side, entry, slPct ?? risk.maxLossPct);
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function fallbackStopLoss(side: Trade['side'], entry: number, pct: number): number | undefined {
  if (!Number.isFinite(entry) || !Number.isFinite(pct) || pct <= 0) return undefined;
  return side === 'BUY' ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
}

function fallbackTakeProfit(side: Trade['side'], entry: number, pct: number): number | undefined {
  if (!Number.isFinite(entry) || !Number.isFinite(pct) || pct <= 0) return undefined;
  return side === 'BUY' ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
}
