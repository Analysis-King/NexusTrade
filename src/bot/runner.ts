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
      await getWorkerPool().load(this.id, this.config.strategyId, this.strategyRuntimeParams());

      // 2. Tarihsel veri pre-fill (strateji ilk tick'ten itibaren ısınmış olsun)
      const history = await this.preloadHistory();
      this.state.candles = history.map(candleToRaw);
      await this.refreshDrawingsFromHistory();

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
    this.state.drawings = Array.isArray(tickResp.drawings) ? tickResp.drawings : [];

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
          tickResp.tp_price
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
          tickResp.tp_price
        );
      }
    } else if (tickResp.signal === 'close') {
      if (this.state.position) {
        await this.closePosition(candle.c, 'signal');
      }
    }
    this.emit('updated', this.getSnapshot());
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
    tpPriceOverride?: number | null
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
      this.state.lastSignal = trades[0] ? signalFromTrade(trades[0]) : null;
    } catch (err) {
      log.warn({ botId: this.id, err }, 'Bot durumu gecmisten yuklenemedi');
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
      openedAt: trade.createdAt,
    };
  }

  private strategyRuntimeParams(): Record<string, unknown> {
    return {
      ...this.config.strategyParams,
      stop_loss_pct: this.config.risk.maxLossPct,
      take_profit_pct: this.config.risk.takeProfitPct,
      stop_loss_mode: this.config.risk.stopLossMode ?? 'target_ratio',
      stop_loss_target_ratio: this.config.risk.stopLossTargetRatio ?? 1,
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
function isClosingTrade(trade: Trade): boolean {
  return typeof trade.pnlUsd === 'number';
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
    const ratio = normalizePositive(risk.stopLossTargetRatio, 1);
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

function fallbackStopLoss(side: Trade['side'], entry: number, pct: number): number | undefined {
  if (!Number.isFinite(entry) || !Number.isFinite(pct) || pct <= 0) return undefined;
  return side === 'BUY' ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
}

function fallbackTakeProfit(side: Trade['side'], entry: number, pct: number): number | undefined {
  if (!Number.isFinite(entry) || !Number.isFinite(pct) || pct <= 0) return undefined;
  return side === 'BUY' ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
}

void BotError;
