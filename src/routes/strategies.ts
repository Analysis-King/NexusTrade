/**
 * Strateji dosyaları endpoint'leri.
 *
 * GET    /api/strategies            — tüm stratejilerin meta listesi
 * GET    /api/strategies/:filename  — strateji kodunu döner
 * POST   /api/strategies            — yeni veya güncelle (eski API ile uyumlu)
 * PUT    /api/strategies/:filename  — sadece güncelle
 * DELETE /api/strategies/:filename  — sil
 */

import { Router } from 'express';
import { z } from 'zod';
import { getStrategyService } from '../services/strategies.js';
import { asyncHandler } from './middleware.js';
import { getWorkerPool } from '../workers/pool.js';

export const strategyRouter = Router();

const filenameParam = z.object({
  filename: z.string().min(1).max(120),
});

const upsertBody = z.object({
  filename: z.string().min(1).max(120),
  code: z.string().min(1).max(200_000), // 200 KB üst sınır
});

const updateBody = z.object({
  code: z.string().min(1).max(200_000),
});

const validateBody = z.object({
  filename: z.string().min(1).max(120).default('inline_strategy.py'),
  code: z.string().min(1).max(200_000),
});

strategyRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const data = await getStrategyService().list();
    res.json({ ok: true, data });
  })
);

strategyRouter.get(
  '/:filename',
  asyncHandler(async (req, res) => {
    const { filename } = filenameParam.parse(req.params);
    const data = await getStrategyService().get(filename);
    res.json({ ok: true, data });
  })
);

strategyRouter.post(
  '/validate',
  asyncHandler(async (req, res) => {
    const { filename, code } = validateBody.parse(req.body);
    const data = await getWorkerPool().validateCode(filename, code);
    res.json({ ok: true, data });
  })
);

/**
 * POST /api/strategies
 * Eski API "varsa üstüne yaz, yoksa oluştur" davranışındaydı; aynısını koruyoruz
 * çünkü frontend bu varsayımla yazılmış.
 */
strategyRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { filename, code } = upsertBody.parse(req.body);
    const svc = getStrategyService();

    // Var mı kontrol et — varsa update, yoksa create
    let exists = false;
    try {
      await svc.get(filename);
      exists = true;
    } catch {
      exists = false;
    }
    const data = exists
      ? await svc.update(filename, code)
      : await svc.create(filename, code);

    res.status(exists ? 200 : 201).json({ ok: true, data });
  })
);

strategyRouter.put(
  '/:filename',
  asyncHandler(async (req, res) => {
    const { filename } = filenameParam.parse(req.params);
    const { code } = updateBody.parse(req.body);
    const data = await getStrategyService().update(filename, code);
    res.json({ ok: true, data });
  })
);

strategyRouter.delete(
  '/:filename',
  asyncHandler(async (req, res) => {
    const { filename } = filenameParam.parse(req.params);
    await getStrategyService().delete(filename);
    res.status(204).end();
  })
);
