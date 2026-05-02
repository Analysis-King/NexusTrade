/**
 * BotRunner — tek bir bot'un çalışan instance'ı.
 *
 * State machine:
 *   idle → running ↔ paused
 *          running → stopped
 *          running → error (otomatik, hatadan dolayı)
 *          error/stopped → idle (yeniden başlatılabilir)
 *
 * Akış:
 *   start():
 *     1. WorkerPool'a strateji yükle
 *     2. Binance kline stream'ine abone ol
 *     3. Closed candle geldikçe handleCandle()
 *
 *   handleCandle(candle):
 *     1. Candle buffer'a ekle (son N tutuyoruz)
 *     2. Pozisyon varsa SL/TP kontrolü
 *     3. Risk guard kontrolü (günlük loss limit)
 *     4. WorkerPool.tick() — strateji sinyali al
 *     5. Sinyal buy/sell ise execution + state update + persist
 *     6. WS broadcast
 *
 *   stop(): stream aboneliğini bırak, instance'ı drop, state = stopped
 */

import { EventEmitter } from 'node:events';
import { BotError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { BinanceClient } from '../services/binance/client.js';
import { getBinanceStream } from '../services/binance/stream.js';
import type { KlineStreamData } from '../services/binance/stream.js';
import { getWorkerPool } from '../workers/pool.js';
import { candleToRaw, type CandleRaw, type Signal } from '../workers/types.js';
import type { Storage } from '../storage/index.js';
import type {
  BotConfig,
  Candle,
  Position,
  Trade,
} from '../types/domain.js';
import {
  getExecutionProvider,
  type ExecutionContext,
  type ExecutionProvider,
} from './execution.js';

const log = createLogger('bot-runner');

/** Bot içi durum — domain.BotConfig'in transient hali. */
export interface BotRuntimeState {
  candles: CandleRaw[];
  position: Position | null;
  realizedPnlUsd: number;
  todayPnlUsd: number;
  todayResetAt: number; // gün başlangıcı (00:00 UTC)
  lastTickAt: number | null;
  lastSignal: Signal | null;
}

const MAX_CANDLE_BUFFER = 500;
const PUBLIC_CLIENT = BinanceClient.public();

export class BotRunner extends EventEmitter {
  private config: BotConfig;
  private state: BotRuntimeState;
  private storage: Storage;
  private execution: ExecutionProvider;
  private unsubscribeStream: (() => void) | null = null;
  /** Debounce: aynı tick birden fazla işlenmesin */
  private ticking = false;

  constructor(config: BotConfig, storage: Storage) {
    super();
    this.config = { ...config };
    this.storage = storage;
    this.execution = getExecutionProvider(config.mode);
    this.state = {
      candles: [],
      position: null,
      realizedPnlUsd: 0,
      todayPnlUsd: 0,
      todayResetAt: startOfUtcDay(Date.now()),
      lastTickAt: null,
      lastSignal: null,
    };
  }

  get id(): string {
    return this.config.id;
  }

  /** Snapshot — UI/API için. */
  getSnapshot(): {
    config: BotConfig;
    state: {
      position: Position | null;
      realizedPnlUsd: number;
      todayPnlUsd: number;
      candleCount: number;
      lastTickAt: number | null;
      lastSignal: Signal | null;
    };
  } {
    return {
      config: this.config,
      state: {
        position: this.state.position,
        realizedPnlUsd: this.state.realizedPnlUsd,
        todayPnlUsd: this.state.todayPnlUsd,
        candleCount: this.state.candles.length,
        lastTickAt: this.state.lastTickAt,
        lastSignal: this.state.lastSignal,
      },
    };
  }

  /* ─── Lifecycle ────────────────────────────────────────── */

  async start(): Promise<void> {
    if (this.config.status === 'running') return;

    log.info(
      { botId: this.id, symbol: this.config.symbol, mode: this.config.mode },
      'Bot baslatiliyor'
    );

    try {
      // 1. Strateji yükle
      await getWorkerPool().load(this.id, this.config.strategyId);

      // 2. Tarihsel veri pre-fill (strateji ilk tick'ten itibaren ısınmış olsun)
      const history = await this.preloadHistory();
      this.state.candles = history.map(candleToRaw);

      // 3. Stream'e abone ol
      this.subscribeStream();

      await this.updateConfig({ status: 'running', lastError: undefined });
      this.emit('started', this.getSnapshot());
      log.info({ botId: this.id, candles: this.state.candles.length }, 'Bot calisiyor');
    } catch (err) {
      log.error({ botId: this.id, err }, 'Bot baslatma hatasi');
      await this.updateConfig({
        status: 'error',
        lastError: (err as Error).message,
      });
      throw err;
    }
  }

  async stop(): Promise<void> {
    log.info({ botId: this.id }, 'Bot durduruluyor');
    if (this.unsubscribeStream) {
      this.unsubscribeStream();
      this.unsubscribeStream = null;
    }
    await getWorkerPool().drop(this.id).catch(() => undefined);
    await this.updateConfig({ status: 'stopped' });
    this.emit('stopped', this.getSnapshot());
  }

  async pause(): Promise<void> {
    if (this.config.status !== 'running') return;
    await this.updateConfig({ status: 'paused' });
    this.emit('paused', this.getSnapshot());
  }

  async resume(): Promise<void> {
    if (this.config.status !== 'paused') return;
    await this.updateConfig({ status: 'running' });
    this.emit('resumed', this.getSnapshot());
  }

  /* ─── Stream subscription ──────────────────────────────── */

  private subscribeStream(): void {
    const stream = `${this.config.symbol.toLowerCase()}@kline_${this.config.interval}`;
    const binStream = getBinanceStream();

    const handler = (data: unknown): void => {
      void this.onStreamMessage(data as KlineStreamData);
    };
    binStream.on(stream, handler);
    const unsubBin = binStream.subscribe(stream);

    this.unsubscribeStream = () => {
      binStream.off(stream, handler);
      unsubBin();
    };
  }

  private async onStreamMessage(data: KlineStreamData): Promise<void> {
    if (!data || data.e !== 'kline') return;
    const k = data.k;

    // Sadece KAPANMIŞ mumlar — yarım mum sinyal yanlışı yapar
    if (!k.x) return;

    const candle: CandleRaw = {
      t: k.t,
      o: Number(k.o),
      h: Number(k.h),
      l: Number(k.l),
      c: Number(k.c),
      v: Number(k.v),
    };

    // Buffer'a ekle (aynı openTime gelirse değiştir)
    const last = this.state.candles[this.state.candles.length - 1];
    if (last && last.t === candle.t) {
      this.state.candles[this.state.candles.length - 1] = candle;
    } else {
      this.state.candles.push(candle);
      if (this.state.candles.length > MAX_CANDLE_BUFFER) {
        this.state.candles.shift();
      }
    }

    if (this.config.status !== 'running') return;
    if (this.ticking) return; // henüz önceki tick bitmedi
    this.ticking = true;
    try {
      await this.processCandle(candle);
    } finally {
      this.ticking = false;
    }
  }

  /* ─── Tick processing ──────────────────────────────────── */

  private async processCandle(candle: CandleRaw): Promise<void> {
    this.resetDailyIfNeeded();
    this.state.lastTickAt = Date.now();

    // 1. Açık pozisyon SL/TP kontrolü (fiyat seviyeleriyle)
    if (this.state.position) {
      const closed = await this.checkSlTp(candle);
      if (closed) return; // pozisyon kapandı, bu mumda sinyal almıyoruz
    }

    // 2. Risk guard — günlük loss limit
    if (this.state.todayPnlUsd <= -this.config.risk.dailyMaxLossUsd) {
      log.warn(
        { botId: this.id, today: this.state.todayPnlUsd },
        'Gunluk zarar limiti asildi, bot duruyor'
      );
      await this.updateConfig({ status: 'paused' });
      this.emit('risk-limit', { kind: 'daily-loss', today: this.state.todayPnlUsd });
      return;
    }

    // 3. Stratejiyi çağır
    const tickResp = await getWorkerPool()
      .tick(this.id, {
        candle,
        candles: this.state.candles,
        portfolio: {
          usdt: this.config.capitalUsd,
          has_position: this.state.position !== null,
          pnl: this.state.realizedPnlUsd,
        },
      })
      .catch((err) => {
        log.error({ botId: this.id, err }, 'Strategy tick hatasi');
        return null;
      });

    if (!tickResp) return;
    this.state.lastSignal = tickResp.signal;

    // 4. Sinyali değerlendir
    if (tickResp.signal === 'buy' && !this.state.position) {
      await this.openPosition(candle.c, 'BUY', tickResp.sl_pct, tickResp.tp_pct);
    } else if (tickResp.signal === 'sell' && this.state.position) {
      await this.closePosition(candle.c, 'signal');
    }
  }

  private async checkSlTp(candle: CandleRaw): Promise<boolean> {
    const pos = this.state.position;
    if (!pos) return false;

    // Long: low <= SL → stop, high >= TP → take profit
    // Short: high >= SL → stop, low <= TP → take profit
    const isLong = pos.side === 'BUY';
    const hitSL =
      pos.stopLossPrice !== undefined &&
      (isLong ? candle.l <= pos.stopLossPrice : candle.h >= pos.stopLossPrice);
    const hitTP =
      pos.takeProfitPrice !== undefined &&
      (isLong ? candle.h >= pos.takeProfitPrice : candle.l <= pos.takeProfitPrice);

    if (hitSL) {
      // SL'de gap olabilir; pratikte SL fiyatından kapatıyoruz
      await this.closePosition(pos.stopLossPrice!, 'sl');
      return true;
    }
    if (hitTP) {
      await this.closePosition(pos.takeProfitPrice!, 'tp');
      return true;
    }
    return false;
  }

  private async openPosition(
    price: number,
    side: 'BUY' | 'SELL',
    slPct: number | null,
    tpPct: number | null
  ): Promise<void> {
    const notionalUsd = Math.min(
      this.config.risk.maxPositionUsd,
      this.config.capitalUsd
    );
    if (notionalUsd <= 0) {
      log.warn({ botId: this.id }, 'Notional 0, pozisyon acilmiyor');
      return;
    }

    const slPrice =
      slPct !== null && slPct !== undefined
        ? side === 'BUY'
          ? price * (1 - slPct / 100)
          : price * (1 + slPct / 100)
        : undefined;

    const tpPrice =
      tpPct !== null && tpPct !== undefined
        ? side === 'BUY'
          ? price * (1 + tpPct / 100)
          : price * (1 - tpPct / 100)
        : undefined;

    const ctx: ExecutionContext = { bot: this.config, price };
    try {
      const result = await this.execution.openPosition(ctx, {
        side,
        notionalUsd,
        stopLossPrice: slPrice,
        takeProfitPrice: tpPrice,
      });
      this.state.position = result.position;
      await this.persistTrade(result.trade);
      this.emit('position-opened', { trade: result.trade, position: result.position });
    } catch (err) {
      log.error({ botId: this.id, err }, 'Pozisyon acma hatasi');
    }
  }

  private async closePosition(price: number, reason: 'signal' | 'sl' | 'tp'): Promise<void> {
    const pos = this.state.position;
    if (!pos) return;

    const ctx: ExecutionContext = { bot: this.config, price };
    try {
      const result = await this.execution.closePosition(ctx, pos);
      const pnl = result.trade.pnlUsd ?? 0;
      this.state.position = null;
      this.state.realizedPnlUsd += pnl;
      this.state.todayPnlUsd += pnl;
      await this.persistTrade(result.trade);
      this.emit('position-closed', { trade: result.trade, reason, pnl });
    } catch (err) {
      log.error({ botId: this.id, err }, 'Pozisyon kapatma hatasi');
    }
  }

  /* ─── Persistence helpers ──────────────────────────────── */

  private async persistTrade(trade: Trade): Promise<void> {
    try {
      await this.storage.trades.add(trade);
    } catch (err) {
      log.error({ botId: this.id, err }, 'Trade kaydedilemedi');
    }
  }

  private async updateConfig(patch: Partial<BotConfig>): Promise<void> {
    this.config = { ...this.config, ...patch, updatedAt: Date.now() };
    try {
      await this.storage.bots.update(this.id, patch);
    } catch (err) {
      log.error({ botId: this.id, err }, 'Bot config update hatasi');
    }
    this.emit('updated', this.getSnapshot());
  }

  /* ─── Tarihsel pre-load ────────────────────────────────── */

  private async preloadHistory(): Promise<Candle[]> {
    // 200 mum yeterli — çoğu indikatör için fazlasıyla
    const raw = await PUBLIC_CLIENT.klines({
      symbol: this.config.symbol,
      interval: this.config.interval,
      limit: 200,
    });
    return raw.map((k) => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6],
    }));
  }

  /* ─── Daily reset ──────────────────────────────────────── */

  private resetDailyIfNeeded(): void {
    const today = startOfUtcDay(Date.now());
    if (today > this.state.todayResetAt) {
      this.state.todayPnlUsd = 0;
      this.state.todayResetAt = today;
    }
  }
}

/* ─── Helpers ──────────────────────────────────────────── */

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// kullanılmıyor uyarısını engelle
void BotError;
