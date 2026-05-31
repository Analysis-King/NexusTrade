/**
 * Trade execution katmanı.
 *
 * Bot bu interface'i konuşur, hangi modda olduğunu bilmek zorunda değil.
 * - PaperExecution: virtual balance, anlık fill (current price)
 * - LiveExecution:  Binance'e gerçek emir (gelecek adımda — şimdi stub)
 *
 * Bot motorunun temiz olması için ayrılmıştır.
 */

import { randomUUID } from 'node:crypto';
import type {
  BotConfig,
  OrderSide,
  Position,
  Trade,
} from '../types/domain.js';
import { BotError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('execution');

export interface ExecutionContext {
  bot: BotConfig;
  /** Anlık fiyat (kapanan mum kapanış fiyatı). */
  price: number;
}

export interface OpenPositionParams {
  side: OrderSide;
  /** USDT cinsinden pozisyon büyüklüğü. */
  notionalUsd: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export interface ExecutionResult {
  trade: Trade;
  position: Position | null; // close ise null
}

/** Tüm execution provider'ların uyduğu interface. */
export interface ExecutionProvider {
  openPosition(ctx: ExecutionContext, params: OpenPositionParams): Promise<ExecutionResult>;
  closePosition(ctx: ExecutionContext, position: Position): Promise<ExecutionResult>;
}

/* ─── Paper execution ──────────────────────────────────── */

export class PaperExecution implements ExecutionProvider {
  /** Spot trading komisyonu — Binance default %0.1 */
  private readonly feeRate = 0.001;
  private readonly slippageRate = 0;

  async openPosition(
    ctx: ExecutionContext,
    params: OpenPositionParams
  ): Promise<ExecutionResult> {
    const { bot, price } = ctx;
    if (price <= 0) throw new BotError('Geçersiz fiyat');
    if (params.notionalUsd <= 0) throw new BotError('Geçersiz notional');

    const quantity = params.notionalUsd / price;
    const fee = params.notionalUsd * this.feeRate;
    if (
      params.takeProfitPrice !== undefined &&
      expectedTpNetPnl({
        side: params.side,
        entryPrice: price,
        targetPrice: params.takeProfitPrice,
        quantity,
        entryFee: fee,
        feeRate: this.feeRate,
        slippageRate: this.slippageRate,
      }) <= 0
    ) {
      throw new BotError('TP hedefi komisyon/slippage maliyetini karsilamiyor');
    }

    const trade: Trade = {
      id: randomUUID(),
      botId: bot.id,
      symbol: bot.symbol,
      side: params.side,
      type: 'MARKET',
      quantity,
      price,
      feeUsd: fee,
      stopLossPrice: params.stopLossPrice,
      takeProfitPrice: params.takeProfitPrice,
      mode: 'paper',
      clientOrderId: `paper-${randomUUID()}`,
      createdAt: Date.now(),
    };

    const position: Position = {
      botId: bot.id,
      symbol: bot.symbol,
      side: params.side,
      quantity,
      entryPrice: price,
      stopLossPrice: params.stopLossPrice,
      takeProfitPrice: params.takeProfitPrice,
      openedAt: Date.now(),
    };

    log.info(
      { botId: bot.id, side: params.side, price, quantity, fee },
      'paper open'
    );

    return { trade, position };
  }

  async closePosition(
    ctx: ExecutionContext,
    position: Position
  ): Promise<ExecutionResult> {
    const { bot, price } = ctx;
    const closeSide: OrderSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const notional = position.quantity * price;
    const fee = notional * this.feeRate;

    // PnL hesabı (long pozisyon için):
    // pnl = (exit - entry) * qty - feeOpen - feeClose
    // Açılış komisyonunu yaklaşık olarak entry * qty * feeRate kabul ediyoruz
    const direction = position.side === 'BUY' ? 1 : -1;
    const grossPnl = (price - position.entryPrice) * position.quantity * direction;
    const feeOpen = position.entryPrice * position.quantity * this.feeRate;
    const pnlUsd = grossPnl - feeOpen - fee;

    const trade: Trade = {
      id: randomUUID(),
      botId: bot.id,
      symbol: bot.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: position.quantity,
      price,
      feeUsd: fee,
      pnlUsd,
      mode: 'paper',
      clientOrderId: `paper-${randomUUID()}`,
      createdAt: Date.now(),
    };

    log.info(
      { botId: bot.id, entryPrice: position.entryPrice, exitPrice: price, pnl: pnlUsd },
      'paper close'
    );

    return { trade, position: null };
  }
}

/* ─── Live execution — STUB (Hafta 3'te tamamlanacak) ──── */

export class LiveExecution implements ExecutionProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async openPosition(_ctx: ExecutionContext, _params: OpenPositionParams): Promise<ExecutionResult> {
    throw new BotError(
      'Live mod henuz aktif degil — Hafta 3 (API key encryption) sonrasi acilacak'
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async closePosition(_ctx: ExecutionContext, _position: Position): Promise<ExecutionResult> {
    throw new BotError('Live mod henuz aktif degil');
  }
}

/* ─── Factory ──────────────────────────────────────────── */

export function getExecutionProvider(mode: BotConfig['mode']): ExecutionProvider {
  if (mode === 'live') return new LiveExecution();
  return new PaperExecution();
}

function expectedTpNetPnl(input: {
  side: OrderSide;
  entryPrice: number;
  targetPrice: number;
  quantity: number;
  entryFee: number;
  feeRate: number;
  slippageRate: number;
}): number {
  const exitPrice =
    input.targetPrice *
    (input.side === 'BUY' ? 1 - input.slippageRate : 1 + input.slippageRate);
  const direction = input.side === 'BUY' ? 1 : -1;
  const grossPnl = (exitPrice - input.entryPrice) * input.quantity * direction;
  const exitFee = Math.abs(exitPrice * input.quantity) * input.feeRate;
  return grossPnl - input.entryFee - exitFee;
}
