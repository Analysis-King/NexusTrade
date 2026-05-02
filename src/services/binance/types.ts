/**
 * Binance REST API response tipleri.
 *
 * Binance dokümantasyonu: https://binance-docs.github.io/apidocs/spot/en/
 * Sadece kullandıklarımızı tipliyoruz.
 */

import type { Interval, OrderSide, OrderType } from '../../types/domain.js';

/* ─── Public endpoint'ler ──────────────────────────────────── */

export interface BinanceServerTime {
  serverTime: number;
}

export interface BinancePrice {
  symbol: string;
  price: string;
}

export interface BinanceTicker24h {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  prevClosePrice: string;
  lastPrice: string;
  lastQty: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  firstId: number;
  lastId: number;
  count: number;
}

export interface BinanceOrderBook {
  lastUpdateId: number;
  bids: [string, string][]; // [price, qty]
  asks: [string, string][];
}

export interface BinanceTrade {
  id: number;
  price: string;
  qty: string;
  quoteQty: string;
  time: number;
  isBuyerMaker: boolean;
  isBestMatch: boolean;
}

/**
 * Binance kline raw format (array):
 * [openTime, open, high, low, close, volume,
 *  closeTime, quoteVolume, trades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore]
 */
export type BinanceKlineRaw = [
  number, // openTime
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // closeTime
  string, // quoteVolume
  number, // trades
  string, // takerBuyBase
  string, // takerBuyQuote
  string, // ignore
];

/* ─── Signed endpoint'ler ──────────────────────────────────── */

export interface BinanceAccountInfo {
  makerCommission: number;
  takerCommission: number;
  buyerCommission: number;
  sellerCommission: number;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  updateTime: number;
  accountType: string;
  balances: Array<{
    asset: string;
    free: string;
    locked: string;
  }>;
  permissions: string[];
}

export interface BinanceOrder {
  symbol: string;
  orderId: number;
  orderListId: number;
  clientOrderId: string;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  timeInForce: string;
  type: string;
  side: OrderSide;
  stopPrice?: string;
  time?: number;
  updateTime?: number;
  isWorking?: boolean;
  origQuoteOrderQty?: string;
}

export interface BinanceNewOrderResponse extends BinanceOrder {
  transactTime: number;
  fills?: Array<{
    price: string;
    qty: string;
    commission: string;
    commissionAsset: string;
    tradeId: number;
  }>;
}

/* ─── Error response ───────────────────────────────────────── */

export interface BinanceErrorResponse {
  code: number;
  msg: string;
}

/* ─── Order request params ─────────────────────────────────── */

export interface NewOrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: number;
  quoteOrderQty?: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  newClientOrderId?: string;
}

export interface KlinesParams {
  symbol: string;
  interval: Interval;
  limit?: number;
  startTime?: number;
  endTime?: number;
}
