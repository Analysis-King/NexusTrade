/**
 * Public market data endpoint'leri.
 *
 * Bu route'lar API key gerektirmez — sadece public Binance verileri.
 * /api/market/price/:symbol
 * /api/market/ticker/:symbol?
 * /api/market/orderbook/:symbol
 * /api/market/trades/:symbol
 * /api/market/klines/:symbol
 */

import { Router } from 'express';
import { z } from 'zod';
import { BinanceClient } from '../services/binance/client.js';
import type { BinanceKlineRaw } from '../services/binance/types.js';
import { klineToCandle } from '../services/binance/marketData.js';
import {
  fallbackKlines,
  fallbackOrderBook,
  fallbackPrice,
  fallbackRecentTrades,
  fallbackSymbols,
  fallbackTicker24h,
} from '../services/marketFallback.js';
import { asyncHandler } from './middleware.js';

export const marketRouter = Router();

// Tüm public endpoint'ler için tek bir paylaşılan client yeterli
const publicClient = BinanceClient.public();

const symbolSchema = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[A-Z0-9]+$/, 'Sembol sadece büyük harf ve rakam içerebilir');

const intervalSchema = z.enum([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

/* ─── /price/:symbol ───────────────────────────────────── */
marketRouter.get(
  '/price/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = symbolSchema.parse(req.params.symbol);
    const data = await publicClient.price(symbol).catch(() => fallbackPrice(symbol));
    res.json({ ok: true, data });
  })
);

/* ─── /ticker/:symbol? ─────────────────────────────────── */
marketRouter.get(
  '/ticker/:symbol?',
  asyncHandler(async (req, res) => {
    const symbol = req.params.symbol ? symbolSchema.parse(req.params.symbol) : undefined;
    const data = await publicClient.ticker24h(symbol).catch(() => fallbackTicker24h(symbol));
    res.json({ ok: true, data });
  })
);

/* ─── /orderbook/:symbol ───────────────────────────────── */
marketRouter.get(
  '/orderbook/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = symbolSchema.parse(req.params.symbol);
    const limit = z.coerce.number().int().min(5).max(100).default(20).parse(req.query.limit);
    const data = await publicClient.orderBook(symbol, limit).catch(() => fallbackOrderBook(symbol, limit));
    res.json({ ok: true, data });
  })
);

/* ─── /trades/:symbol ──────────────────────────────────── */
marketRouter.get(
  '/trades/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = symbolSchema.parse(req.params.symbol);
    const limit = z.coerce.number().int().min(1).max(500).default(50).parse(req.query.limit);
    const data = await publicClient.recentTrades(symbol, limit).catch(() => fallbackRecentTrades(symbol, limit));
    res.json({ ok: true, data });
  })
);

/* ─── /klines/:symbol ──────────────────────────────────── */
marketRouter.get(
  '/klines/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = symbolSchema.parse(req.params.symbol);
    const interval = intervalSchema.parse(req.query.interval ?? '1h');
    const limit = z.coerce.number().int().min(1).max(1000).default(200).parse(req.query.limit);
    const format = z.enum(['raw', 'candle']).default('candle').parse(req.query.format);

    const raw = await publicClient.klines({ symbol, interval, limit }).catch(async () => {
      const fallback = await fallbackKlines({ symbol, interval, limit });
      return fallback.map((candle): BinanceKlineRaw => [
        candle.openTime,
        String(candle.open),
        String(candle.high),
        String(candle.low),
        String(candle.close),
        String(candle.volume),
        candle.closeTime,
        '0',
        0,
        '0',
        '0',
        '0',
      ]);
    });

    if (format === 'raw') {
      res.json({ ok: true, data: raw });
      return;
    }

    res.json({ ok: true, data: raw.map(klineToCandle) });
  })
);

/* ─── /symbols (popüler USDT pariteleri) ───────────────── */
marketRouter.get(
  '/symbols',
  asyncHandler(async (_req, res) => {
    // Binance'de exchangeInfo çok büyük döner; bu helper basit bir filtre yapar.
    const usdtPairs = await publicClient
      .ticker24h()
      .then((all) =>
        (all as Array<{ symbol: string; quoteVolume: string }>)
          .filter((t) => t.symbol.endsWith('USDT'))
          .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
          .slice(0, 100)
          .map((t) => t.symbol)
      )
      .catch(() => fallbackSymbols());

    res.json({ ok: true, data: usdtPairs });
  })
);

/* ─── /server-time ─────────────────────────────────────── */
marketRouter.get(
  '/server-time',
  asyncHandler(async (_req, res) => {
    const data = await publicClient.serverTime();
    res.json({ ok: true, data });
  })
);
