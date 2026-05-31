import { Router } from 'express';
import { z } from 'zod';
import { getIndicatorService } from '../services/indicators.js';
import { asyncHandler } from './middleware.js';
import type { Candle } from '../types/domain.js';

export const indicatorRouter = Router();

const candleSchema = z.object({
  openTime: z.coerce.number().int().positive(),
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
  volume: z.coerce.number(),
  closeTime: z.coerce.number().int().positive().optional(),
});

const drawBody = z.object({
  candles: z.array(candleSchema).min(2).max(2000),
  params: z.record(z.unknown()).default({}),
});

indicatorRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const data = await getIndicatorService().list();
    res.json({ ok: true, data });
  })
);

indicatorRouter.post(
  '/:filename/draw',
  asyncHandler(async (req, res) => {
    const filename = z.string().min(1).max(120).parse(req.params.filename);
    const body = drawBody.parse(req.body);
    const candles: Candle[] = body.candles.map((candle) => ({
      ...candle,
      closeTime: candle.closeTime ?? candle.openTime,
    }));
    const data = await getIndicatorService().draw(filename, candles, body.params);
    res.json({ ok: true, data });
  })
);
