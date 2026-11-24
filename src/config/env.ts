/**
 * Environment yapılandırması — zod ile validate edilir.
 * Eksik veya hatalı değer varsa uygulama startup'ta düşer.
 */

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET en az 32 karakter olmalı'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY en az 32 karakter olmalı'),

  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  BINANCE_REST_URL: z.string().url().default('https://api.binance.com'),
  BINANCE_WS_URL: z.string().default('wss://stream.binance.com:9443'),
  BINANCE_RECV_WINDOW: z.coerce.number().int().positive().default(5000),

  DATA_DIR: z.string().default('./data'),

  PYTHON_BIN: z.string().default('python3'),
  WORKER_POOL_SIZE: z.coerce.number().int().min(1).max(32).default(4),
  /** Backtest/cizim/dogrulama icin ayri havuz (bot tick'lerini bloklamasin) */
  JOB_WORKER_POOL_SIZE: z.coerce.number().int().min(1).max(16).default(2),
  WORKER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  BACKTEST_WORKER_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment yapılandırma hatası:');
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\n.env dosyasını .env.example baz alarak oluşturun.');
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
