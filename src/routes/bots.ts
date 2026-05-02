/**
 * Bot REST API.
 *
 * GET    /api/bots                — tüm bot'ları listele
 * GET    /api/bots/:id            — detay (state ile birlikte)
 * POST   /api/bots                — yeni bot oluştur
 * PATCH  /api/bots/:id            — config güncelle (sadece durmuşken)
 * DELETE /api/bots/:id            — sil
 * POST   /api/bots/:id/start      — başlat
 * POST   /api/bots/:id/stop       — durdur
 * POST   /api/bots/:id/pause      — duraklat
 * POST   /api/bots/:id/resume     — devam et
 * GET    /api/bots/:id/trades     — bot'un trade history'si
 */

import { Router } from 'express';
import { z } from 'zod';
import { getBotManager } from '../bot/manager.js';
import { getStorage } from '../storage/index.js';
import { asyncHandler } from './middleware.js';

export const botRouter = Router();

const intervalSchema = z.enum([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

const riskSchema = z
  .object({
    maxLossPct: z.number().min(0.1).max(50).optional(),
    takeProfitPct: z.number().min(0.1).max(100).optional(),
    maxPositionUsd: z.number().min(10).max(1_000_000).optional(),
    dailyMaxLossUsd: z.number().min(1).max(1_000_000).optional(),
  })
  .optional();

const createSchema = z.object({
  name: z.string().min(2).max(60),
  symbol: z.string().regex(/^[A-Za-z0-9]+$/).max(20),
  interval: intervalSchema,
  mode: z.enum(['paper', 'live']).default('paper'),
  strategyId: z.string().min(1).max(100),
  strategyParams: z.record(z.string(), z.unknown()).optional(),
  capitalUsd: z.number().min(10).max(10_000_000).optional(),
  risk: riskSchema,
});

const updateSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  symbol: z.string().regex(/^[A-Za-z0-9]+$/).max(20).optional(),
  interval: intervalSchema.optional(),
  mode: z.enum(['paper', 'live']).optional(),
  strategyId: z.string().min(1).max(100).optional(),
  strategyParams: z.record(z.string(), z.unknown()).optional(),
  capitalUsd: z.number().min(10).max(10_000_000).optional(),
  risk: riskSchema,
});

const idParam = z.object({ id: z.string().uuid() });

/* ─── Routes ───────────────────────────────────────────── */

botRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const data = await getBotManager().list();
    res.json({ ok: true, data });
  })
);

botRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const data = await getBotManager().getSnapshot(id);
    res.json({ ok: true, data });
  })
);

botRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const data = await getBotManager().create(input);
    res.status(201).json({ ok: true, data });
  })
);

botRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const patch = updateSchema.parse(req.body);
    const data = await getBotManager().update(id, patch);
    res.json({ ok: true, data });
  })
);

botRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await getBotManager().delete(id);
    res.status(204).end();
  })
);

botRouter.post(
  '/:id/start',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await getBotManager().start(id);
    const data = await getBotManager().getSnapshot(id);
    res.json({ ok: true, data });
  })
);

botRouter.post(
  '/:id/stop',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await getBotManager().stop(id);
    const data = await getBotManager().getSnapshot(id);
    res.json({ ok: true, data });
  })
);

botRouter.post(
  '/:id/pause',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await getBotManager().pause(id);
    const data = await getBotManager().getSnapshot(id);
    res.json({ ok: true, data });
  })
);

botRouter.post(
  '/:id/resume',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await getBotManager().resume(id);
    const data = await getBotManager().getSnapshot(id);
    res.json({ ok: true, data });
  })
);

botRouter.get(
  '/:id/trades',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const limit = z.coerce.number().int().min(1).max(500).default(50).parse(req.query.limit);
    const data = await getStorage().trades.list({ botId: id, limit });
    res.json({ ok: true, data });
  })
);
