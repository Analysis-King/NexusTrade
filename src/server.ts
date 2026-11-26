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
import path from 'node:path';
import { createApp } from './app.js';
import { getBotManager } from './bot/manager.js';
import { env, isDev } from './config/env.js';
import { startPaperPortfolioSupervisor } from './services/paperPortfolioSupervisor.js';
import { NexusWebSocketServer } from './services/wsServer.js';
import { getStorage } from './storage/index.js';
import { cleanupStaleTempFiles } from './storage/json/atomicFile.js';
import { createLogger } from './utils/logger.js';
import { getJobWorkerPool, getWorkerPool, shutdownWorkerPool } from './workers/pool.js';

const log = createLogger('server');

function isBrokenPipe(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return code === 'EPIPE' || code === 'EOF' || message.includes('write EPIPE') || message.includes('write EOF');
}

// Windows'ta konsol kapaninca stdout/stderr EPIPE uretebilir. Cikti
// kanalinin kopmasi HTTP ve WebSocket sunucusunu kapatmamalidir.
process.stdout?.on('error', (err) => {
  if (!isBrokenPipe(err)) process.exitCode = 1;
});
process.stderr?.on('error', (err) => {
  if (!isBrokenPipe(err)) process.exitCode = 1;
});

async function main(): Promise<void> {
  const app = createApp();
  const server = http.createServer(app);

  // WebSocket sunucusu — HTTP server'a attach et (path: /ws)
  const wsServer = new NexusWebSocketServer(server);

  // Onceki basarisiz/yarim yazimlardan kalan yetim tmp dosyalarini temizle.
  await cleanupDataTempFiles();

  // Bot manager route'lar gelmeden singleton olarak hazir olsun.
  const storage = getStorage();
  const botManager = getBotManager(storage);

  // Bot olaylarini WS uzerinden frontend'e yay.
  botManager.on('any', (evt: { type: string; botId: string; payload: unknown }) => {
    wsServer.broadcast({ type: 'bot-event', event: evt.type, botId: evt.botId, payload: evt.payload });
  });

  // HTTP/WS once acilsin; worker ve bot isinmasi arkada devam ederken
  // frontend proxy hatasi basmasin.
  await listen(server);

  // Python worker pool - bot motoru bunu kullanacak.
  // Backtest/cizim isleri ayri havuzda: uzun isler bot tick'lerini bloklamaz.
  await Promise.all([getWorkerPool().start(), getJobWorkerPool().start()]);

  // Kayitli botlari yukle, running paper botlari yeniden baslat.
  await botManager.bootstrap();
  const stopPaperPortfolioSupervisor = startPaperPortfolioSupervisor();
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
      stopPaperPortfolioSupervisor();
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
      msg.includes('write EPIPE') ||
      msg.includes('write EOF') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ECONNREFUSED') ||
      (err as NodeJS.ErrnoException)?.code === 'EPIPE' ||
      (err as NodeJS.ErrnoException)?.code === 'EOF'
    );
  };

  process.on('uncaughtException', (err) => {
    if (isRecoverable(err)) {
      if (isBrokenPipe(err)) return;
      log.warn({ err: err.message }, 'Recoverable runtime error — devam ediliyor');
      return;
    }
    log.fatal({ err }, 'Uncaught exception - kapatiliyor');
    setTimeout(() => process.exit(1), 500).unref();
  });
}

async function cleanupDataTempFiles(): Promise<void> {
  for (const dir of [env.DATA_DIR, path.join(env.DATA_DIR, 'backtests')]) {
    try {
      const { files, bytes } = await cleanupStaleTempFiles(dir);
      if (files > 0) {
        log.info({ dir, files, mb: Math.round(bytes / 1024 / 1024) }, 'Yetim tmp dosyalari temizlendi');
      }
    } catch (err) {
      log.warn({ dir, err }, 'Tmp dosya temizligi yapilamadi');
    }
  }
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(env.PORT, env.HOST, () => {
      server.off('error', onError);
      log.info(
        { host: env.HOST, port: env.PORT, env: env.NODE_ENV },
        `NexusTrade started in ${isDev ? 'DEV' : 'PROD'} mode at http://${env.HOST}:${env.PORT}`
      );
      log.info(`WebSocket: ws://${env.HOST}:${env.PORT}/ws`);
      resolve();
    });
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Baslatma hatasi');
  process.exit(1);
});
