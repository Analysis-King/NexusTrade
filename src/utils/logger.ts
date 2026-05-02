/**
 * Yapılandırılmış logger (pino).
 *
 * Geliştirme: pino-pretty ile renkli, okunaklı output.
 * Üretim: JSON (log aggregation sistemleriyle uyumlu).
 *
 * Kullanım:
 *   import { logger } from '@/utils/logger.js';
 *   logger.info('Bot başlatıldı', { botId, symbol });
 *   logger.error({ err }, 'Beklenmedik hata');
 *
 *   // Modül-spesifik child logger:
 *   const log = logger.child({ module: 'bot-runner' });
 */

import pino from 'pino';
import { env, isDev } from '../config/env.js';

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '[{module}] {msg}',
        singleLine: false,
      },
    }
  : undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  transport,
  // Üretimde hassas alanları otomatik gizle
  redact: {
    paths: [
      'apiKey',
      'apiSecret',
      'password',
      'token',
      '*.apiKey',
      '*.apiSecret',
      'req.headers.authorization',
      'req.headers["x-session-id"]',
    ],
    censor: '***REDACTED***',
  },
});

/** Modül-spesifik child logger oluşturucu. */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}
