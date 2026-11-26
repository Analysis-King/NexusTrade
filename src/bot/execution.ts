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
  meta?: Record<string, unknown>;
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
  async openPosition(
    ctx: ExecutionContext,
    params: OpenPositionParams
  ): Promise<ExecutionResult> {
    const { bot, price } = ctx;
    if (price <= 0) throw new BotError('Geçersiz fiyat');
    if (params.notionalUsd <= 0) throw new BotError('Geçersiz notional');

    const { feeRate, slippageRate, feeBps, slippageBps } = paperExecutionCosts(bot);
    const fillPrice = applySlippage(price, params.side, slippageRate);
    const quantity = params.notionalUsd / fillPrice;
    const fee = params.notionalUsd * feeRate;
    if (
      params.takeProfitPrice !== undefined &&
      expectedTpNetPnl({
        side: params.side,
        entryPrice: fillPrice,
        targetPrice: params.takeProfitPrice,
        quantity,
        entryFee: fee,
        feeRate,
        slippageRate,
      }) <= 0
    ) {
      throw new BotError('TP hedefi komisyon/slippage maliyetini karsilamiyor');
    }

    const meta = mergeMeta(params.meta, {
      paperExecutionOpen: {
        referencePrice: price,
        fillPrice,
        feeBps,
        slippageBps,
        feeUsd: fee,
        estimatedSlippageUsd: Math.abs(fillPrice - price) * quantity,
      },
    });
    const trade: Trade = {
      id: randomUUID(),
      botId: bot.id,
      symbol: bot.symbol,
      side: params.side,
      type: 'MARKET',
      quantity,
      price: fillPrice,
      feeUsd: fee,
      stopLossPrice: params.stopLossPrice,
      takeProfitPrice: params.takeProfitPrice,
      meta,
      mode: 'paper',
      clientOrderId: `paper-${randomUUID()}`,
      createdAt: Date.now(),
    };

    const position: Position = {
      botId: bot.id,
      symbol: bot.symbol,
      side: params.side,
      quantity,
      entryPrice: fillPrice,
      stopLossPrice: params.stopLossPrice,
      takeProfitPrice: params.takeProfitPrice,
      meta,
      openedAt: Date.now(),
    };

    log.info(
      { botId: bot.id, side: params.side, referencePrice: price, fillPrice, quantity, fee },
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
    const { feeRate, slippageRate, feeBps, slippageBps } = paperExecutionCosts(bot);
    const fillPrice = applySlippage(price, closeSide, slippageRate);
    const notional = position.quantity * fillPrice;
    const fee = notional * feeRate;

    // PnL hesabı (long pozisyon için):
    // pnl = (exit - entry) * qty - feeOpen - feeClose
    // Açılış komisyonunu yaklaşık olarak entry * qty * feeRate kabul ediyoruz
    const direction = position.side === 'BUY' ? 1 : -1;
    const grossPnl = (fillPrice - position.entryPrice) * position.quantity * direction;
    const feeOpen =
      nestedFiniteNonNegative(position.meta, 'paperExecutionOpen', 'feeUsd') ??
      position.entryPrice * position.quantity * feeRate;
    const pnlUsd = grossPnl - feeOpen - fee;

    const meta = mergeMeta(position.meta, {
      paperExecutionClose: {
        referencePrice: price,
        fillPrice,
        feeBps,
        slippageBps,
        estimatedSlippageUsd: Math.abs(fillPrice - price) * position.quantity,
      },
    });
    const trade: Trade = {
      id: randomUUID(),
      botId: bot.id,
      symbol: bot.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: position.quantity,
      price: fillPrice,
      feeUsd: fee,
      pnlUsd,
      meta,
      mode: 'paper',
      clientOrderId: `paper-${randomUUID()}`,
      createdAt: Date.now(),
    };

    log.info(
      { botId: bot.id, entryPrice: position.entryPrice, referencePrice: price, exitPrice: fillPrice, pnl: pnlUsd },
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

function paperExecutionCosts(bot: BotConfig): {
  feeRate: number;
  slippageRate: number;
  feeBps: number;
  slippageBps: number;
} {
  const feeBps = finiteNonNegative(bot.strategyParams.fee_bps, 10);
  const slippageBps = finiteNonNegative(bot.strategyParams.slippage_bps, 2);
  return {
    feeRate: feeBps / 10_000,
    slippageRate: slippageBps / 10_000,
    feeBps,
    slippageBps,
  };
}

function applySlippage(referencePrice: number, side: OrderSide, rate: number): number {
  return referencePrice * (side === 'BUY' ? 1 + rate : 1 - rate);
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nestedFiniteNonNegative(
  source: Record<string, unknown> | undefined,
  parentKey: string,
  valueKey: string
): number | undefined {
  const parent = source?.[parentKey];
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return undefined;
  const parsed = Number((parent as Record<string, unknown>)[valueKey]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function mergeMeta(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...(base ?? {}), ...patch };
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
