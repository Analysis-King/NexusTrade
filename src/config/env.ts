/**
 * Environment yapılandırması — zod ile validate edilir.
 * Eksik veya hatalı değer varsa uygulama startup'ta düşer.
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
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
  /** Okuma disi istekler (bot baslat/durdur/sil, emir...) icin ayri butce. */
  RATE_LIMIT_WRITE_MAX: z.coerce.number().int().positive().default(120),

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

// Bu iki degerin SHA-256'si: bir sure .env.example'da gercek gorunumlu ornek olarak GitHub'a gittiler.
// .env'e aynen kopyalandiysa gizli degiller; API anahtari sifrelemesi gelmeden once yenilenmeleri sart.
const PUBLIC_EXAMPLE_SECRET_HASHES = new Set([
  'bedf27085ae7a827ac3ef0ba3e9034d19e5e26e3fb76aacec39b77856ff492bc',
  '5d484a0ee3062ff02a73f1a2cac70d6afcf5a103c079cb0d7a44d9c9894350c3',
]);
const publicSecrets = (['SESSION_SECRET', 'ENCRYPTION_KEY'] as const).filter((key) =>
  PUBLIC_EXAMPLE_SECRET_HASHES.has(createHash('sha256').update(env[key]).digest('hex'))
);
if (publicSecrets.length > 0 && env.NODE_ENV !== 'test') {
  console.warn(
    `⚠ ${publicSecrets.join(', ')} eski .env.example'daki herkese acik degerle ayni. ` +
      "`openssl rand -hex 32` ile yenisini uretip .env'e yazin."
  );
}

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
