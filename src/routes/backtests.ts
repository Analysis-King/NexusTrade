import { Router } from 'express';
import { z } from 'zod';
import { getBacktestService } from '../services/backtest.js';
import { asyncHandler } from './middleware.js';

export const backtestRouter = Router();

const intervalSchema = z.enum([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

const symbolSchema = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[A-Z0-9]+$/);

const createBacktestBody = z
  .object({
    strategyFile: z.string().min(1).max(120),
    code: z.string().min(1).max(200_000).optional(),
    symbol: symbolSchema.default('BTCUSDT'),
    interval: intervalSchema.default('1h'),
    startTime: z.coerce.number().int().positive().optional(),
    endTime: z.coerce.number().int().positive().optional(),
    days: z.coerce.number().int().min(1).max(1825).optional(),
    initialCapital: z.coerce.number().positive().max(100_000_000).default(1000),
    feeBps: z.coerce.number().min(0).max(100).default(10),
    slippageBps: z.coerce.number().min(0).max(500).default(2),
    fillModel: z.enum(['close_next_open', 'pessimistic_ohlc']).default('pessimistic_ohlc'),
    params: z.record(z.unknown()).default({}),
    async: z.boolean().default(false),
  })
  .refine((body) => !(body.startTime && body.endTime && body.startTime >= body.endTime), {
    message: 'startTime endTime degerinden kucuk olmali',
    path: ['startTime'],
  });

backtestRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(50),
        status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
        symbol: symbolSchema.optional(),
        strategyFile: z.string().min(1).max(120).optional(),
      })
      .parse(req.query);
    const data = await getBacktestService().list(query);
    res.json({ ok: true, data });
  })
);

backtestRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = z.string().min(1).max(80).parse(req.params.id);
    const data = await getBacktestService().get(id);
    res.json({ ok: true, data });
  })
);

backtestRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createBacktestBody.parse(req.body);
    const { async: runAsync, ...input } = body;
    const data = runAsync
      ? await getBacktestService().createAsync(input)
      : await getBacktestService().create(input);
    res.status(runAsync ? 202 : 201).json({ ok: true, data });
  })
);

backtestRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = z.string().min(1).max(80).parse(req.params.id);
    await getBacktestService().delete(id);
    res.status(204).end();
  })
);
