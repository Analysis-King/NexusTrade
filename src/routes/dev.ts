/**
 * Geliştirme/test route'ları.
 *
 * Bu route'lar SADECE NODE_ENV=development modunda mount edilir.
 * Üretimde 404 dönerler. Bot motoru hazır olmadan worker pool'u test etmek için.
 */

import { Router } from 'express';
import { z } from 'zod';
import { BinanceClient } from '../services/binance/client.js';
import { klineToCandle } from '../services/binance/marketData.js';
import { getWorkerPool } from '../workers/pool.js';
import { candleToRaw } from '../workers/types.js';
import { asyncHandler } from './middleware.js';

export const devRouter = Router();

const publicClient = BinanceClient.public();

/** Worker pool durumunu göster. */
devRouter.get(
  '/pool/stats',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: getWorkerPool().getStats() });
  })
);

/** Bir bot instance yükle (geçici test). */
devRouter.post(
  '/pool/load',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        instance: z.string().min(1),
        strategy_file: z.string().min(1).max(100),
      })
      .parse(req.body);
    const data = await getWorkerPool().load(body.instance, body.strategy_file);
    res.json({ ok: true, data });
  })
);

/** Yüklü bot instance'ı drop et. */
devRouter.post(
  '/pool/drop',
  asyncHandler(async (req, res) => {
    const body = z.object({ instance: z.string().min(1) }).parse(req.body);
    await getWorkerPool().drop(body.instance);
    res.json({ ok: true, data: { dropped: true } });
  })
);

/**
 * Belirtilen sembol/interval için son N kline'ı çek, yüklü stratejiye tick gönder.
 * Test amaçlı — gerçek bot mantığı Adım 4'te gelecek.
 */
devRouter.post(
  '/pool/tick',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        instance: z.string().min(1),
        symbol: z.string().regex(/^[A-Z0-9]+$/).default('BTCUSDT'),
        interval: z
          .enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'])
          .default('1h'),
        limit: z.coerce.number().int().min(50).max(500).default(200),
      })
      .parse(req.body);

    const raw = await publicClient.klines({
      symbol: body.symbol,
      interval: body.interval,
      limit: body.limit,
    });
    const candles = raw.map(klineToCandle).map(candleToRaw);
    const lastCandle = candles[candles.length - 1]!;

    const result = await getWorkerPool().tick(body.instance, {
      candle: lastCandle,
      candles,
      portfolio: { usdt: 1000, has_position: false, pnl: 0 },
    });

    res.json({
      ok: true,
      data: {
        result,
        meta: { candleCount: candles.length, lastClose: lastCandle.c },
      },
    });
  })
);

/** Backtest dene — pool üzerinden. */
devRouter.post(
  '/pool/backtest',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        instance: z.string().min(1),
        symbol: z.string().regex(/^[A-Z0-9]+$/).default('BTCUSDT'),
        interval: z
          .enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])
          .default('1h'),
        days: z.coerce.number().int().min(1).max(90).default(7),
        min_quality: z.coerce.number().int().min(0).max(100).default(40),
        tp_mode: z.string().default('TP2'),
      })
      .parse(req.body);

    // Kısa backtest için tek istekte yeterli; uzun için fetchHistorical kullanılır.
    const raw = await publicClient.klines({
      symbol: body.symbol,
      interval: body.interval,
      limit: 1000,
    });
    const candles = raw.map(klineToCandle).map(candleToRaw);

    const data = await getWorkerPool().backtest(body.instance, {
      candles,
      min_quality: body.min_quality,
      tp_mode: body.tp_mode,
    });

    res.json({ ok: true, data });
  })
);
