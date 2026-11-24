/**
 * Express uygulamasını oluşturan fabrika.
 *
 * server.ts'den ayrı tutuyoruz ki testler app'i kendi başına başlatabilsin
 * (HTTP listen olmadan). Aynı zamanda dependency injection için kanca.
 */

import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { corsOrigins, env, isDev } from './config/env.js';
import { backtestRouter } from './routes/backtests.js';
import { botRouter } from './routes/bots.js';
import { devRouter } from './routes/dev.js';
import { healthRouter } from './routes/health.js';
import { indicatorRouter } from './routes/indicators.js';
import { marketRouter } from './routes/market.js';
import { errorHandler, notFoundHandler, requestLogger } from './routes/middleware.js';
import { paperPortfolioRouter } from './routes/paperPortfolios.js';
import { strategyRouter } from './routes/strategies.js';

export function createApp(): Express {
  const app = express();

  // Reverse proxy arkasında çalışırken gerçek client IP için
  app.set('trust proxy', 1);

  // Güvenlik header'ları
  app.use(
    helmet({
      contentSecurityPolicy: false, // frontend ayrıca yapılandırıyoruz, Hafta 7
      crossOriginEmbedderPolicy: false,
    })
  );

  // CORS — sadece izinli origin'ler
  app.use(
    cors({
      origin: (origin, cb) => {
        // Same-origin (örn. Postman, curl) origin yollamaz; izin ver.
        if (!origin) return cb(null, true);
        if (corsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin reddedildi: ${origin}`));
      },
      credentials: true,
    })
  );

  // Body parser — orta seviye limit
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  // Request logging
  app.use(requestLogger);

  // Genel rate limit — endpoint-spesifik limitler ileride eklenecek
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Çok fazla istek' } },
    })
  );

  // Statik frontend — şimdilik mevcut public/ kullanılıyor
  app.use(express.static('public'));

  // Routes
  app.use('/api', healthRouter);
  app.use('/api/market', marketRouter);
  app.use('/api/indicators', indicatorRouter);
  app.use('/api/bots', botRouter);
  app.use('/api/paper-portfolios', paperPortfolioRouter);
  app.use('/api/strategies', strategyRouter);
  app.use('/api/backtests', backtestRouter);

  // Geliştirme modunda dev route'ları aç
  if (isDev) {
    app.use('/api/dev', devRouter);
  }

  // 404 + error handler — en sonda olmak ZORUNDA
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
