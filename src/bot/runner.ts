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
import type { KlineStreamData, TradeStreamData } from '../services/binance/stream.js';
import { getWorkerPool } from '../workers/pool.js';
import {
  candleToRaw,
  type CandleRaw,
  type FootprintLevelRaw,
  type FootprintRaw,
  type Signal,
} from '../workers/types.js';
import type { Storage } from '../storage/index.js';
import type {
  BotConfig,
  BotRiskConfig,
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
  drawings: unknown[];
}

const MAX_CANDLE_BUFFER = 500;
const MAX_FOOTPRINT_BUFFER = 60;
const MAX_FOOTPRINT_LEVELS = 240;
const PUBLIC_CLIENT = BinanceClient.public();

interface FootprintLevelAccumulator {
  price: number;
  buyVolume: number;
  sellVolume: number;
  buyTrades: number;
  sellTrades: number;
}

interface FootprintAccumulator {
  t: number;
  trades: number;
  buyTrades: number;
  sellTrades: number;
  buyVolume: number;
  sellVolume: number;
  buyNotional: number;
  sellNotional: number;
  levels: Map<string, FootprintLevelAccumulator>;
}

export class BotRunner extends EventEmitter {
  private config: BotConfig;
  private state: BotRuntimeState;
  private storage: Storage;
  private execution: ExecutionProvider;
  private unsubscribeStream: (() => void) | null = null;
  private fallbackPollTimer: NodeJS.Timeout | null = null;
  private lastProcessedCandleTime: number | null = null;
  private pendingClosedCandles = new Map<number, {
    candle: CandleRaw;
    footprint: FootprintRaw;
  }>();
  private footprints: FootprintRaw[] = [];
  private footprintBuckets = new Map<number, FootprintAccumulator>();
  private footprintSubscribedAt = 0;
  private activeKlineWindow: { openTime: number; closeTime: number } | null = null;
  private needsFootprint = false;
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
      drawings: [],
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
      drawings: unknown[];
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
        drawings: this.state.drawings,
      },
    };
  }

  /* ─── Lifecycle ────────────────────────────────────────── */

  async start(): Promise<void> {
    // Eğer zaten stream'e abone olmuşsak, çift start önle.
    // (Status 'running' tek başına yeterli değil — restart sonrası DB'deki status
    // 'running' olabilir ama subscription henüz yok.)
    if (this.unsubscribeStream) return;

    log.info(
      { botId: this.id, symbol: this.config.symbol, mode: this.config.mode },
      'Bot baslatiliyor'
    );

    try {
      // 1. Strateji yükle
      await this.hydrateStateFromTrades();
      const loaded = await getWorkerPool().load(
        this.id,
        this.config.strategyId,
        this.strategyRuntimeParams()
      );
      this.needsFootprint = loaded.capabilities?.footprint === true;

      // 2. Tarihsel veri pre-fill (strateji ilk tick'ten itibaren ısınmış olsun)
      const history = await this.preloadHistory();
      this.state.candles = history.map(candleToRaw);
      await this.reconcileHydratedPosition(history);
      this.lastProcessedCandleTime = this.state.candles.at(-1)?.t ?? null;
      this.pendingClosedCandles.clear();
      this.footprints = [];
      this.footprintBuckets.clear();
      this.activeKlineWindow = null;
      this.footprintSubscribedAt = 0;
      await this.refreshDrawingsFromHistory();

      // 3. Stream'e abone ol
      this.subscribeStream();
      this.startFallbackPolling();

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
    this.stopFallbackPolling();
    this.pendingClosedCandles.clear();
    this.footprints = [];
    this.footprintBuckets.clear();
    this.activeKlineWindow = null;
    this.footprintSubscribedAt = 0;
    await getWorkerPool().drop(this.id).catch(() => undefined);
    await this.updateConfig({ status: 'stopped' });
    this.emit('stopped', this.getSnapshot());
  }

  /**
   * Runner'i sessizce devre disi birak: stream aboneligi, yoklama zamanlayicisi
   * ve worker instance'i serbest birakilir; kayitli durum (status) DEGISMEZ.
   * Config guncellenirken eski runner yenisiyle degistirilmeden once cagrilir.
   */
  async dispose(): Promise<void> {
    if (this.unsubscribeStream) {
      this.unsubscribeStream();
      this.unsubscribeStream = null;
    }
    this.stopFallbackPolling();
    this.pendingClosedCandles.clear();
    this.footprints = [];
    this.footprintBuckets.clear();
    this.activeKlineWindow = null;
    this.footprintSubscribedAt = 0;
    await getWorkerPool().drop(this.id).catch(() => undefined);
    this.removeAllListeners();
  }

  async pause(): Promise<void> {
    if (this.config.status !== 'running') return;
    await this.updateConfig({ status: 'paused' });
    this.emit('paused', this.getSnapshot());
  }

  /**
   * Resume — paused → running.
   *
   * Önemli: Eğer bot **hiç başlatılmamışsa** (subscription yok), resume yerine
   * tam start() çalıştırırız. Bu, restart sonrası live botların manuel resume
   * edilmesi durumunda da doğru davranır.
   */
  async resume(): Promise<void> {
    if (this.config.status !== 'paused') return;
    if (!this.unsubscribeStream) {
      // Stream subscription hiç yok — tam start lazım
      log.info({ botId: this.id }, 'Resume: subscription yok, tam start ediliyor');
      // Status'u önce idle'a çek, start() running'e geçirsin
      await this.updateConfig({ status: 'idle' });
      await this.start();
      return;
    }
    await this.updateConfig({ status: 'running' });
    this.emit('resumed', this.getSnapshot());
  }

  /* ─── Stream subscription ──────────────────────────────── */

  private subscribeStream(): void {
    const symbol = this.config.symbol.toLowerCase();
    const klineStream = `${symbol}@kline_${this.config.interval}`;
    const binStream = getBinanceStream();

    const klineHandler = (data: unknown): void => {
      void this.onStreamMessage(data as KlineStreamData);
    };
    binStream.on(klineStream, klineHandler);

    const tradeStream = `${symbol}@trade`;
    const tradeHandler = (data: unknown): void => {
      this.onTradeMessage(data as TradeStreamData);
    };
    if (this.needsFootprint) {
      this.footprintSubscribedAt = Date.now();
      binStream.on(tradeStream, tradeHandler);
    }
    const unsubStreams = binStream.subscribeMany(
      this.needsFootprint ? [klineStream, tradeStream] : [klineStream]
    );

    this.unsubscribeStream = () => {
      binStream.off(klineStream, klineHandler);
      if (this.needsFootprint) {
        binStream.off(tradeStream, tradeHandler);
      }
      unsubStreams();
    };
  }

  private async onStreamMessage(data: KlineStreamData): Promise<void> {
    if (!data || data.e !== 'kline') return;
    const k = data.k;
    this.activeKlineWindow = { openTime: k.t, closeTime: k.T };

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
    await this.ingestClosedCandle(candle, this.finalizeFootprint(candle.t));
  }

  /* ─── Tick processing ──────────────────────────────────── */

  private onTradeMessage(data: TradeStreamData): void {
    if (!this.needsFootprint || !data || data.e !== 'trade') return;

    const price = Number(data.p);
    const quantity = Number(data.q);
    const tradeTime = Number(data.T || data.E);
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isFinite(tradeTime)
    ) {
      return;
    }

    const window = this.activeKlineWindow;
    const candleTime =
      window && tradeTime >= window.openTime && tradeTime <= window.closeTime
        ? window.openTime
        : alignTradeTimeToInterval(tradeTime, this.config.interval);
    const bucket = this.getFootprintBucket(candleTime);
    const levelKey = price.toString();
    const level = bucket.levels.get(levelKey) ?? {
      price,
      buyVolume: 0,
      sellVolume: 0,
      buyTrades: 0,
      sellTrades: 0,
    };
    const notional = price * quantity;

    bucket.trades += 1;
    if (data.m) {
      bucket.sellTrades += 1;
      bucket.sellVolume += quantity;
      bucket.sellNotional += notional;
      level.sellTrades += 1;
      level.sellVolume += quantity;
    } else {
      bucket.buyTrades += 1;
      bucket.buyVolume += quantity;
      bucket.buyNotional += notional;
      level.buyTrades += 1;
      level.buyVolume += quantity;
    }
    bucket.levels.set(levelKey, level);
  }

  private async ingestClosedCandle(
    candle: CandleRaw,
    footprint: FootprintRaw = emptyFootprint(candle.t)
  ): Promise<void> {
    if (this.lastProcessedCandleTime !== null && candle.t <= this.lastProcessedCandleTime) return;

    this.pendingClosedCandles.set(candle.t, { candle, footprint });
    if (this.ticking) return;

    this.ticking = true;
    try {
      while (this.pendingClosedCandles.size > 0) {
        const nextTime = Math.min(...this.pendingClosedCandles.keys());
        const pending = this.pendingClosedCandles.get(nextTime);
        this.pendingClosedCandles.delete(nextTime);
        if (!pending) continue;
        if (this.lastProcessedCandleTime !== null && nextTime <= this.lastProcessedCandleTime) {
          continue;
        }

        this.upsertClosedCandle(pending.candle, pending.footprint);
        if (this.config.status !== 'running') {
          // Strateji calismaz ama mum "islendi" sayilir: aksi halde resume
          // sonrasi yedek yoklama ayni mumlari tekrar ekler (tampon bozulur)
          // ve eski mumlar yeni sinyal gibi islenir.
          if (this.config.status === 'paused' && this.state.position) {
            await this.protectPausedPosition(pending.candle);
          }
          this.lastProcessedCandleTime = pending.candle.t;
          continue;
        }

        await this.processCandle(pending.candle, pending.footprint);
        this.lastProcessedCandleTime = pending.candle.t;
      }
    } finally {
      this.ticking = false;
    }
  }

  private upsertClosedCandle(candle: CandleRaw, footprint: FootprintRaw): void {
    const last = this.state.candles[this.state.candles.length - 1];
    if (last && last.t === candle.t) {
      this.state.candles[this.state.candles.length - 1] = candle;
    } else if (last && candle.t < last.t) {
      // Sirasiz/eski mum: varsa yerinde guncelle, yoksa yoksay. Sona eklemek
      // tamponu bozar (tekrarli ve sirasiz mumlar stratejiye gider).
      const idx = this.state.candles.findIndex((item) => item.t === candle.t);
      if (idx >= 0) this.state.candles[idx] = candle;
      return;
    } else {
      this.state.candles.push(candle);
      if (this.state.candles.length > MAX_CANDLE_BUFFER) {
        this.state.candles.shift();
      }
    }

    const existingFootprint = this.footprints.findIndex((item) => item.t === footprint.t);
    if (existingFootprint >= 0) {
      this.footprints[existingFootprint] = footprint;
    } else {
      this.footprints.push(footprint);
      if (this.footprints.length > MAX_FOOTPRINT_BUFFER) {
        this.footprints.shift();
      }
    }
  }

  private startFallbackPolling(): void {
    this.stopFallbackPolling();
    this.fallbackPollTimer = setInterval(() => {
      void this.pollLatestClosedCandles();
    }, 15_000);
    this.fallbackPollTimer.unref?.();
  }

  private stopFallbackPolling(): void {
    if (!this.fallbackPollTimer) return;
    clearInterval(this.fallbackPollTimer);
    this.fallbackPollTimer = null;
  }

  private async pollLatestClosedCandles(): Promise<void> {
    // Duraklatilmis botta da yokla: acik pozisyonun SL/TP korumasi stream
    // koparsa da calissin.
    if (this.config.status !== 'running' && this.config.status !== 'paused') return;
    try {
      const raw = await PUBLIC_CLIENT.klines({
        symbol: this.config.symbol,
        interval: this.config.interval,
        limit: 3,
      });
      const now = Date.now();
      const closed = raw
        .map(rawKlineToCandleRaw)
        .filter((candle) => candle.closeTime < now)
        .sort((a, b) => a.t - b.t);
      for (const candle of closed) {
        await this.ingestClosedCandle(candle, this.finalizeFootprint(candle.t));
      }
    } catch (err) {
      log.warn({ botId: this.id, err }, 'Kline fallback yoklamasi basarisiz');
    }
  }

  private async processCandle(
    candle: CandleRaw,
    footprint: FootprintRaw = emptyFootprint(candle.t)
  ): Promise<void> {
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
        footprint,
        footprints: this.footprints,
        portfolio: {
          usdt: this.config.capitalUsd,
          has_position: this.state.position !== null,
          pnl: this.state.realizedPnlUsd,
          side: this.state.position?.side,
        },
      })
      .catch((err) => {
        log.error({ botId: this.id, err }, 'Strategy tick hatasi');
        return null;
      });

    if (!tickResp) return;
    if (tickResp.signal !== 'hold') {
      this.state.lastSignal = tickResp.signal;
    }
    const runtimeDrawings = Array.isArray(tickResp.drawings) ? tickResp.drawings : [];
    if (runtimeDrawings.length > 0) {
      this.state.drawings = runtimeDrawings;
    }
    if (this.state.position) {
      this.updatePositionLevels(tickResp.sl_price, tickResp.tp_price, tickResp.meta);
    }

    // 4. Sinyali değerlendir
    if (tickResp.signal === 'buy') {
      if (this.state.position?.side === 'SELL') {
        await this.closePosition(candle.c, 'signal');
      } else if (!this.state.position) {
        await this.openPosition(
          candle.c,
          'BUY',
          tickResp.sl_pct ?? this.config.risk.maxLossPct,
          tickResp.tp_pct ?? this.config.risk.takeProfitPct,
          tickResp.sl_price,
          tickResp.tp_price,
          tickResp.meta
        );
      }
    } else if (tickResp.signal === 'sell') {
      if (this.state.position?.side === 'BUY') {
        await this.closePosition(candle.c, 'signal');
      } else if (!this.state.position) {
        await this.openPosition(
          candle.c,
          'SELL',
          tickResp.sl_pct ?? this.config.risk.maxLossPct,
          tickResp.tp_pct ?? this.config.risk.takeProfitPct,
          tickResp.sl_price,
          tickResp.tp_price,
          tickResp.meta
        );
      }
    } else if (tickResp.signal === 'close') {
      if (this.state.position) {
        await this.closePosition(candle.c, 'signal');
      }
    }
    await this.refreshDrawingsFromHistory();
    this.emit('updated', this.getSnapshot());
  }

  /**
   * Duraklatilmis bot: strateji sinyali alinmaz ama acik pozisyon korumasiz
   * kalmaz. Gunluk zarar limiti botu 'paused' yaptigi icin bu ozellikle onemli.
   */
  private async protectPausedPosition(candle: CandleRaw): Promise<void> {
    this.resetDailyIfNeeded();
    const closed = await this.checkSlTp(candle);
    if (closed) {
      log.info({ botId: this.id, candleTime: candle.t }, 'Duraklatilmis botta pozisyon SL/TP ile kapandi');
      this.emit('updated', this.getSnapshot());
    }
  }

  private getFootprintBucket(t: number): FootprintAccumulator {
    const existing = this.footprintBuckets.get(t);
    if (existing) return existing;
    const created: FootprintAccumulator = {
      t,
      trades: 0,
      buyTrades: 0,
      sellTrades: 0,
      buyVolume: 0,
      sellVolume: 0,
      buyNotional: 0,
      sellNotional: 0,
      levels: new Map(),
    };
    this.footprintBuckets.set(t, created);
    return created;
  }

  private finalizeFootprint(t: number): FootprintRaw {
    const bucket = this.footprintBuckets.get(t);
    this.footprintBuckets.delete(t);
    for (const key of this.footprintBuckets.keys()) {
      if (key < t) this.footprintBuckets.delete(key);
    }
    const complete = this.footprintSubscribedAt > 0 && this.footprintSubscribedAt <= t;
    if (!bucket) return emptyFootprint(t, complete);

    const levels = compressFootprintLevels([...bucket.levels.values()]
      .map((level) => ({
        price: level.price,
        buy_volume: level.buyVolume,
        sell_volume: level.sellVolume,
        delta: level.buyVolume - level.sellVolume,
        total_volume: level.buyVolume + level.sellVolume,
        buy_trades: level.buyTrades,
        sell_trades: level.sellTrades,
      }))
      .sort((a, b) => a.price - b.price), MAX_FOOTPRINT_LEVELS);
    const poc = levels.reduce<(typeof levels)[number] | null>(
      (best, level) => (!best || level.total_volume > best.total_volume ? level : best),
      null
    );

    return {
      t,
      complete,
      trades: bucket.trades,
      buy_trades: bucket.buyTrades,
      sell_trades: bucket.sellTrades,
      buy_volume: bucket.buyVolume,
      sell_volume: bucket.sellVolume,
      delta: bucket.buyVolume - bucket.sellVolume,
      total_volume: bucket.buyVolume + bucket.sellVolume,
      buy_notional: bucket.buyNotional,
      sell_notional: bucket.sellNotional,
      delta_notional: bucket.buyNotional - bucket.sellNotional,
      total_notional: bucket.buyNotional + bucket.sellNotional,
      poc_price: poc?.price ?? null,
      levels,
    };
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
    tpPct: number | null,
    slPriceOverride?: number | null,
    tpPriceOverride?: number | null,
    meta?: Record<string, unknown>
  ): Promise<void> {
    const leverage = normalizePositive(this.config.risk.leverage, 1);
    const notionalUsd = Math.min(
      this.config.risk.maxPositionUsd,
      this.config.capitalUsd * leverage
    );
    if (notionalUsd <= 0) {
      log.warn({ botId: this.id }, 'Notional 0, pozisyon acilmiyor');
      return;
    }

    const tpPrice =
      tpPriceOverride !== null && tpPriceOverride !== undefined
        ? tpPriceOverride
        : tpPct !== null && tpPct !== undefined
        ? side === 'BUY'
          ? price * (1 + tpPct / 100)
          : price * (1 - tpPct / 100)
        : undefined;
    const slPrice = resolveStopLossPrice(
      side,
      price,
      this.config.risk,
      slPct,
      slPriceOverride,
      tpPrice
    );

    const ctx: ExecutionContext = { bot: this.config, price };
    try {
      const result = await this.execution.openPosition(ctx, {
        side,
        notionalUsd,
        stopLossPrice: slPrice,
        takeProfitPrice: tpPrice,
        meta,
      });
      this.state.position = result.position;
      await this.updateConfig({ lastError: undefined });
      await this.persistTrade(result.trade);
      this.emit('position-opened', { trade: result.trade, position: result.position });
    } catch (err) {
      log.error({ botId: this.id, err }, 'Pozisyon acma hatasi');
      await this.updateConfig({ lastError: (err as Error).message || 'Pozisyon acma hatasi' });
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

  private updatePositionLevels(
    slPrice?: number | null,
    tpPrice?: number | null,
    meta?: Record<string, unknown>
  ): void {
    const pos = this.state.position;
    if (!pos) return;

    const nextTp = finitePositivePrice(tpPrice);
    const nextSl = finitePositivePrice(slPrice);
    if (nextTp !== undefined && isValidTakeProfit(pos.side, pos.entryPrice, nextTp)) {
      pos.takeProfitPrice = nextTp;
    }
    if (nextSl !== undefined) {
      pos.stopLossPrice = nextSl;
    }
    if (meta && Object.keys(meta).length > 0) {
      pos.meta = meta;
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
      limit: MAX_CANDLE_BUFFER,
    });
    const now = Date.now();
    return raw.filter((k) => Number(k[6]) < now).map((k) => ({
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

  private async hydrateStateFromTrades(): Promise<void> {
    try {
      const trades = await this.storage.trades.list({ botId: this.id });
      const todayStart = startOfUtcDay(Date.now());
      let total = 0;
      let today = 0;
      let position: Position | null = null;

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
        position = this.positionFromOpenTrade(trade);
      }

      this.state.realizedPnlUsd = Math.round(total * 100) / 100;
      this.state.todayPnlUsd = Math.round(today * 100) / 100;
      this.state.todayResetAt = todayStart;
      this.state.position = position;
      this.state.lastSignal = lastOpeningSignalFromTrades(trades);
    } catch (err) {
      log.warn({ botId: this.id, err }, 'Bot durumu gecmisten yuklenemedi');
    }
  }

  private async reconcileHydratedPosition(history: Candle[]): Promise<void> {
    const restored = this.state.position;
    if (!restored) return;

    for (const candle of history) {
      if (!this.state.position) break;
      if (candle.closeTime < restored.openedAt) continue;

      const closed = await this.checkSlTp(candleToRaw(candle));
      if (closed) {
        log.warn(
          {
            botId: this.id,
            openedAt: restored.openedAt,
            candleTime: candle.openTime,
            sl: restored.stopLossPrice,
            tp: restored.takeProfitPrice,
          },
          'Geri yuklenen pozisyon gecmis SL/TP seviyesiyle uzlastirildi'
        );
        break;
      }
    }
  }

  private positionFromOpenTrade(trade: Trade): Position {
    return {
      botId: this.id,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.price,
      stopLossPrice:
        trade.stopLossPrice ??
        resolveStopLossPrice(
          trade.side,
          trade.price,
          this.config.risk,
          this.config.risk.maxLossPct,
          undefined,
          trade.takeProfitPrice ?? fallbackTakeProfit(trade.side, trade.price, this.config.risk.takeProfitPct)
        ),
      takeProfitPrice:
        trade.takeProfitPrice ?? fallbackTakeProfit(trade.side, trade.price, this.config.risk.takeProfitPct),
      meta: trade.meta,
      openedAt: trade.createdAt,
    };
  }

  private strategyRuntimeParams(): Record<string, unknown> {
    return {
      ...this.config.strategyParams,
      stop_loss_pct: this.config.risk.maxLossPct,
      take_profit_pct: this.config.risk.takeProfitPct,
      stop_loss_mode: this.config.risk.stopLossMode ?? 'target_ratio',
      stop_loss_target_ratio: this.config.risk.stopLossTargetRatio ?? 0.2,
      max_position_usd: this.config.risk.maxPositionUsd,
      leverage: this.config.risk.leverage ?? 1,
    };
  }

  private async refreshDrawingsFromHistory(): Promise<void> {
    const last = this.state.candles[this.state.candles.length - 1];
    if (!last) return;

    const drawResp = await getWorkerPool()
      .draw(this.id, {
        candles: this.state.candles,
      })
      .catch((err) => {
        log.warn({ botId: this.id, err }, 'Ilk cizim taramasi yapilamadi');
        return null;
      });

    if (!drawResp) return;
    this.state.drawings = Array.isArray(drawResp.drawings) ? drawResp.drawings : [];
  }

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
function rawKlineToCandleRaw(k: unknown[]): CandleRaw & { closeTime: number } {
  return {
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
    closeTime: Number(k[6]),
  };
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

function resolveStopLossPrice(
  side: Trade['side'],
  entry: number,
  risk: BotRiskConfig,
  slPct: number | null,
  strategySlPrice: number | null | undefined,
  takeProfitPrice: number | undefined
): number | undefined {
  const mode = risk.stopLossMode ?? 'target_ratio';
  if (mode === 'target_ratio' && takeProfitPrice !== undefined) {
    const ratio = normalizePositive(risk.stopLossTargetRatio, 0.2);
    const distance = Math.abs(takeProfitPrice - entry);
    if (distance > 0) {
      return side === 'BUY' ? entry - distance * ratio : entry + distance * ratio;
    }
  }

  if (mode === 'strategy' && strategySlPrice !== null && strategySlPrice !== undefined) {
    return strategySlPrice;
  }

  const pct = slPct ?? risk.maxLossPct;
  return fallbackStopLoss(side, entry, pct);
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function compressFootprintLevels(
  levels: FootprintLevelRaw[],
  maxLevels: number
): FootprintLevelRaw[] {
  if (levels.length <= maxLevels) return levels;
  const first = levels[0]!;
  const last = levels[levels.length - 1]!;
  const width = Math.max((last.price - first.price) / maxLevels, Number.EPSILON);
  const buckets = new Map<number, FootprintLevelRaw & { weighted_price: number }>();

  for (const level of levels) {
    const index = Math.min(maxLevels - 1, Math.floor((level.price - first.price) / width));
    const bucket = buckets.get(index) ?? {
      price: level.price,
      buy_volume: 0,
      sell_volume: 0,
      delta: 0,
      total_volume: 0,
      buy_trades: 0,
      sell_trades: 0,
      weighted_price: 0,
    };
    bucket.buy_volume += level.buy_volume;
    bucket.sell_volume += level.sell_volume;
    bucket.delta += level.delta;
    bucket.total_volume += level.total_volume;
    bucket.buy_trades += level.buy_trades;
    bucket.sell_trades += level.sell_trades;
    bucket.weighted_price += level.price * level.total_volume;
    buckets.set(index, bucket);
  }

  return [...buckets.values()]
    .map(({ weighted_price, ...bucket }) => ({
      ...bucket,
      price: bucket.total_volume > 0 ? weighted_price / bucket.total_volume : bucket.price,
    }))
    .sort((a, b) => a.price - b.price);
}

function emptyFootprint(t: number, complete = false): FootprintRaw {
  return {
    t,
    complete,
    trades: 0,
    buy_trades: 0,
    sell_trades: 0,
    buy_volume: 0,
    sell_volume: 0,
    delta: 0,
    total_volume: 0,
    buy_notional: 0,
    sell_notional: 0,
    delta_notional: 0,
    total_notional: 0,
    poc_price: null,
    levels: [],
  };
}

function alignTradeTimeToInterval(ts: number, interval: string): number {
  if (interval === '1M') {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (interval === '1w') {
    const d = new Date(ts);
    const day = d.getUTCDay();
    const daysFromMonday = day === 0 ? 6 : day - 1;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday);
  }

  const match = /^(\d+)(s|m|h|d)$/.exec(interval);
  if (!match) return ts;
  const amount = Number(match[1]);
  const unitMs = match[2] === 's'
    ? 1_000
    : match[2] === 'm'
    ? 60_000
    : match[2] === 'h'
    ? 3_600_000
    : 86_400_000;
  const intervalMs = amount * unitMs;
  return Math.floor(ts / intervalMs) * intervalMs;
}

function finitePositivePrice(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isValidTakeProfit(side: Trade['side'], entry: number, takeProfit: number): boolean {
  if (!Number.isFinite(entry) || entry <= 0) return false;
  return side === 'BUY' ? takeProfit > entry : takeProfit < entry;
}

function fallbackStopLoss(side: Trade['side'], entry: number, pct: number): number | undefined {
  if (!Number.isFinite(entry) || !Number.isFinite(pct) || pct <= 0) return undefined;
  return side === 'BUY' ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
}

function fallbackTakeProfit(side: Trade['side'], entry: number, pct: number): number | undefined {
  if (!Number.isFinite(entry) || !Number.isFinite(pct) || pct <= 0) return undefined;
  return side === 'BUY' ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
}

void BotError;
