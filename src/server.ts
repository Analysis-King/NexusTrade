/**
 * NexusTrade — uygulama giriş noktası.
 *
 * Burada yaptıklarımız:
 *   1. Express app'i oluştur
 *   2. HTTP server başlat
 *   3. WebSocket sunucusunu HTTP'ye attach et
 *   4. Graceful shutdown kanca'larını kur
 *   5. Yakalanmamış hatalar için process-level guard
 */

import http from 'node:http';
import { createApp } from './app.js';
import { getBotManager } from './bot/manager.js';
import { env, isDev } from './config/env.js';
import { NexusWebSocketServer } from './services/wsServer.js';
import { getStorage } from './storage/index.js';
import { createLogger } from './utils/logger.js';
import { getWorkerPool, shutdownWorkerPool } from './workers/pool.js';

const log = createLogger('server');

async function main(): Promise<void> {
  const app = createApp();
  const server = http.createServer(app);

  // WebSocket sunucusu — HTTP server'a attach et (path: /ws)
  const wsServer = new NexusWebSocketServer(server);

  // Python worker pool — bot motoru bunu kullanacak
  const pool = getWorkerPool();
  await pool.start();

  // Bot manager — kayıtlı botları yükle (running'leri paused yapar)
  const storage = getStorage();
  const botManager = getBotManager(storage);
  await botManager.bootstrap();

  // Bot olaylarını WS üzerinden frontend'e yay
  botManager.on('any', (evt: { type: string; botId: string; payload: unknown }) => {
    wsServer.broadcast({ type: 'bot-event', event: evt.type, botId: evt.botId, payload: evt.payload });
  });

  server.listen(env.PORT, env.HOST, () => {
    log.info(
      { host: env.HOST, port: env.PORT, env: env.NODE_ENV },
      `NexusTrade started in ${isDev ? 'DEV' : 'PROD'} mode at http://${env.HOST}:${env.PORT}`
    );
    log.info(`WebSocket: ws://${env.HOST}:${env.PORT}/ws`);
  });

  // ── Graceful shutdown ─────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ signal }, 'Kapatma sinyali alindi, baglantilar kapatiliyor...');

    // Önce WS — yeni mesaj kabul etmesin
    try {
      await wsServer.close();
      log.info('WebSocket sunucusu kapandi');
    } catch (err) {
      log.error({ err }, 'WS kapatma hatasi');
    }

    // Bot manager — tüm botları durdur
    try {
      await botManager.shutdown();
      log.info('Bot manager kapandi');
    } catch (err) {
      log.error({ err }, 'Bot manager kapatma hatasi');
    }

    // Worker pool'u kapat
    try {
      await shutdownWorkerPool();
      log.info('Worker pool kapandi');
    } catch (err) {
      log.error({ err }, 'Worker pool kapatma hatasi');
    }

    server.close((err) => {
      if (err) {
        log.error({ err }, 'HTTP server kapatma hatasi');
        process.exit(1);
      }
      log.info('Temiz kapatma tamamlandi.');
      process.exit(0);
    });

    setTimeout(() => {
      log.error('Graceful shutdown 10s icinde bitmedi, zorla cikiliyor.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // ── Process-level error guards ────────────────────────────
  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled promise rejection');
  });

  /**
   * uncaughtException politikası:
   *
   * Bilinen "iyiniyet" kaynaklı runtime hatalar (örn. ws kütüphanesi'nin
   * connecting durumdayken terminate edilmesi) FATAL değildir. Bunları
   * whitelist'e alıp loglayıp devam ediyoruz.
   *
   * Bilinmeyen hatalar gerçek state corruption işareti olabilir → exit.
   */
  const isRecoverable = (err: Error): boolean => {
    const msg = err?.message ?? '';
    return (
      msg.includes('WebSocket was closed before') ||
      msg.includes('Opening handshake has timed out') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ECONNREFUSED')
    );
  };

  process.on('uncaughtException', (err) => {
    if (isRecoverable(err)) {
      log.warn({ err: err.message }, 'Recoverable runtime error — devam ediliyor');
      return;
    }
    log.fatal({ err }, 'Uncaught exception - kapatiliyor');
    setTimeout(() => process.exit(1), 500).unref();
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Baslatma hatasi');
  process.exit(1);
});
