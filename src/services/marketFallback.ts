import { BinanceError } from '../utils/errors.js';
import type { Candle } from '../types/domain.js';
import type {
  BinanceOrderBook,
  BinancePrice,
  BinanceTicker24h,
  BinanceTrade,
  KlinesParams,
} from './binance/types.js';

const OKX_BASE_URL = 'https://www.okx.com';

interface OkxEnvelope<T> {
  code: string;
  msg: string;
  data: T;
}

interface OkxTicker {
  instId: string;
  last: string;
  open24h: string;
  high24h: string;
  low24h: string;
  vol24h: string;
  volCcy24h: string;
}

interface OkxBooks {
  asks: string[][];
  bids: string[][];
  ts: string;
}

interface OkxTrade {
  tradeId: string;
  px: string;
  sz: string;
  side: 'buy' | 'sell';
  ts: string;
}

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

const OKX_BAR: Record<string, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '2h': '2H',
  '4h': '4H',
  '6h': '6H',
  '12h': '12H',
  '1d': '1D',
  '1w': '1W',
  '1M': '1M',
};

export async function fallbackKlines(params: KlinesParams): Promise<Candle[]> {
  const interval = String(params.interval);
  const bar = OKX_BAR[interval];
  if (!bar) throw new BinanceError(`OKX fallback bu intervali desteklemiyor: ${interval}`);

  const instId = toOkxInstId(params.symbol);
  const data = await okxGet<string[][]>('/api/v5/market/candles', {
    instId,
    bar,
    limit: params.limit ?? 200,
  });

  const duration = INTERVAL_MS[interval] ?? 0;
  return data
    .slice()
    .reverse()
    .map((row) => {
      const openTime = Number(row[0]);
      return {
        openTime,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        closeTime: duration ? openTime + duration - 1 : openTime,
      };
    });
}

export async function fallbackPrice(symbol: string): Promise<BinancePrice> {
  const ticker = await firstTicker(symbol);
  return { symbol, price: ticker.last };
}

export async function fallbackTicker24h(symbol?: string): Promise<BinanceTicker24h | BinanceTicker24h[]> {
  if (symbol) return toBinanceTicker(await firstTicker(symbol), symbol);

  const tickers = await okxGet<OkxTicker[]>('/api/v5/market/tickers', { instType: 'SPOT' });
  return tickers
    .filter((ticker) => ticker.instId.endsWith('-USDT'))
    .map((ticker) => toBinanceTicker(ticker, fromOkxInstId(ticker.instId)))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
}

export async function fallbackOrderBook(symbol: string, limit: number): Promise<BinanceOrderBook> {
  const instId = toOkxInstId(symbol);
  const data = await okxGet<OkxBooks[]>('/api/v5/market/books', {
    instId,
    sz: limit,
  });
  const book = data[0];
  if (!book) throw new BinanceError(`OKX orderbook bos dondu: ${symbol}`);
  return {
    lastUpdateId: Number(book.ts),
    asks: book.asks.map((row) => [row[0] ?? '0', row[1] ?? '0']),
    bids: book.bids.map((row) => [row[0] ?? '0', row[1] ?? '0']),
  };
}

export async function fallbackRecentTrades(symbol: string, limit: number): Promise<BinanceTrade[]> {
  const instId = toOkxInstId(symbol);
  const data = await okxGet<OkxTrade[]>('/api/v5/market/trades', {
    instId,
    limit,
  });
  return data.map((trade) => ({
    id: Number(trade.tradeId),
    price: trade.px,
    qty: trade.sz,
    quoteQty: String(Number(trade.px) * Number(trade.sz)),
    time: Number(trade.ts),
    isBuyerMaker: trade.side === 'sell',
    isBestMatch: true,
  }));
}

export async function fallbackSymbols(): Promise<string[]> {
  const tickers = await okxGet<OkxTicker[]>('/api/v5/market/tickers', { instType: 'SPOT' });
  return tickers
    .filter((ticker) => ticker.instId.endsWith('-USDT'))
    .sort((a, b) => Number(b.volCcy24h) - Number(a.volCcy24h))
    .slice(0, 100)
    .map((ticker) => fromOkxInstId(ticker.instId));
}

async function firstTicker(symbol: string): Promise<OkxTicker> {
  const data = await okxGet<OkxTicker[]>('/api/v5/market/ticker', {
    instId: toOkxInstId(symbol),
  });
  const ticker = data[0];
  if (!ticker) throw new BinanceError(`OKX ticker bos dondu: ${symbol}`);
  return ticker;
}

async function okxGet<T>(endpoint: string, params: Record<string, unknown>): Promise<T> {
  const url = new URL(`${OKX_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, { method: 'GET' });
  const body = (await res.json()) as OkxEnvelope<T>;
  if (!res.ok || body.code !== '0') {
    throw new BinanceError(`OKX fallback hatasi: ${body.msg || res.statusText}`, {
      status: res.status,
      code: body.code,
      endpoint,
    });
  }
  return body.data;
}

function toOkxInstId(symbol: string): string {
  if (!symbol.endsWith('USDT')) throw new BinanceError(`OKX fallback sadece USDT paritelerini destekliyor: ${symbol}`);
  return `${symbol.slice(0, -4)}-USDT`;
}

function fromOkxInstId(instId: string): string {
  return instId.replace('-', '');
}

function toBinanceTicker(ticker: OkxTicker, symbol: string): BinanceTicker24h {
  const last = Number(ticker.last);
  const open = Number(ticker.open24h);
  const priceChange = last - open;
  const priceChangePercent = open ? (priceChange / open) * 100 : 0;
  return {
    symbol,
    priceChange: String(priceChange),
    priceChangePercent: String(priceChangePercent),
    weightedAvgPrice: ticker.last,
    prevClosePrice: ticker.open24h,
    lastPrice: ticker.last,
    lastQty: '0',
    bidPrice: '0',
    bidQty: '0',
    askPrice: '0',
    askQty: '0',
    openPrice: ticker.open24h,
    highPrice: ticker.high24h,
    lowPrice: ticker.low24h,
    volume: ticker.vol24h,
    quoteVolume: ticker.volCcy24h,
    openTime: 0,
    closeTime: Date.now(),
    firstId: 0,
    lastId: 0,
    count: 0,
  };
}
