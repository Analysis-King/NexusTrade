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
import type { BotConfig, BotMode, BotRiskConfig, Interval } from '../types/domain.js';
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

const DEFAULT_RISK: BotRiskConfig = {
  maxLossPct: 2,
  takeProfitPct: 4,
  maxPositionUsd: 100,
  dailyMaxLossUsd: 50,
};

export class BotManager extends EventEmitter {
  private runners = new Map<string, BotRunner>();
  private started = false;

  constructor(private readonly storage: Storage) {
    super();
    this.setMaxListeners(0);
  }

  /** Sunucu açılışında çağrılır — kayıtlı 'running' bot'ları yeniden başlat. */
  async bootstrap(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const all = await this.storage.bots.list();
    log.info({ count: all.length }, 'Botlar yukleniyor');

    for (const cfg of all) {
      const runner = this.makeRunner(cfg);
      this.runners.set(cfg.id, runner);

      // Önceden 'running' olanları paused olarak başlat — kullanıcı manuel
      // resume etmeli. Restart sonrası otomatik canlı emir vermesini istemiyoruz.
      if (cfg.status === 'running') {
        await this.storage.bots.update(cfg.id, { status: 'paused' });
        log.info({ botId: cfg.id }, "Bot 'paused' olarak yuklendi (manuel resume gerekli)");
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
    if (runner) return runner.getSnapshot();
    const cfg = await this.storage.bots.get(id);
    if (!cfg) throw new NotFoundError(`Bot ${id}`);
    // Runner yoksa da sahte snapshot dön
    return {
      config: cfg,
      state: {
        position: null,
        realizedPnlUsd: 0,
        todayPnlUsd: 0,
        candleCount: 0,
        lastTickAt: null,
        lastSignal: null,
      },
    };
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

  async update(id: string, patch: Partial<BotConfig>): Promise<BotConfig> {
    const cfg = await this.storage.bots.get(id);
    if (!cfg) throw new NotFoundError(`Bot ${id}`);
    const runner = this.runners.get(id);
    if (runner && cfg.status === 'running') {
      throw new ConflictError("Calisan bot duzenlenemez, once durdurun");
    }
    const updated = await this.storage.bots.update(id, patch);

    // Runner'ın config'ini de yenile
    if (runner) {
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
