/**
 * Health & metadata endpoint'leri.
 *
 * /health — uptime, bellek, ortam — monitoring için.
 * /version — semver + git SHA (CI tarafından enjekte edilir).
 */

import { Router } from 'express';
import { env } from '../config/env.js';

export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    data: {
      status: 'ok',
      env: env.NODE_ENV,
      uptimeMs: Date.now() - startedAt,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      now: Date.now(),
    },
  });
});

healthRouter.get('/version', (_req, res) => {
  res.json({
    ok: true,
    data: {
      version: process.env.npm_package_version ?? 'unknown',
      gitSha: process.env.GIT_SHA ?? 'dev',
      node: process.version,
    },
  });
});
