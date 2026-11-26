#!/usr/bin/env node
/**
 * Backend'i baslatir; ciktiyi hem konsola hem logs/backend.log dosyasina yazar.
 *
 * Amac: backend coktugunde sebebi kaybolmasin. Bellek tasmasi (OOM) gibi
 * Node'un kendi stderr'e bastigi hatalar da dosyaya duser. Her calistirmanin
 * basina ve sonuna zaman damgali bir satir eklenir (cikis kodu / sinyal ile).
 *
 * Dosya 10 MB'i gecerse backend.log.1 olarak saklanir (tek yedek).
 *
 * Ortam degiskenleri:
 *   NEXUS_BACKEND_LOG  log dosyasinin yolu (varsayilan: logs/backend.log)
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const logFile = path.resolve(root, process.env.NEXUS_BACKEND_LOG || path.join('logs', 'backend.log'));
const MAX_BYTES = 10 * 1024 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

fs.mkdirSync(path.dirname(logFile), { recursive: true });
rotateIfLarge();

const out = fs.createWriteStream(logFile, { flags: 'a' });
const stamp = () => new Date().toISOString();
const toFile = (text) => out.write(text.replace(ANSI_RE, ''));

// Konsol penceresi kapaninca EPIPE gelebilir; sarmalayici yuzunden dusmesin.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

toFile(`\n===== ${stamp()} backend basliyor =====\n`);

const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'server.ts')], {
  cwd: root,
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  toFile(chunk);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  toFile(chunk);
});

// Ctrl+C ayni konsoldaki backend'e de gider; o kendi duzgun kapanisini yapar.
// Sarmalayici erken cikip son satirlari kaybetmesin diye sinyali yutuyoruz.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => child.kill('SIGTERM'));

child.on('error', (err) => {
  const msg = `===== ${stamp()} backend baslatilamadi: ${err.message} =====\n`;
  process.stderr.write(msg);
  toFile(msg);
  out.end(() => process.exit(1));
});

child.on('exit', (code, signal) => {
  const msg = `===== ${stamp()} backend kapandi (code=${code}, signal=${signal}) =====\n`;
  process.stderr.write(msg);
  toFile(msg);
  out.end(() => process.exit(code === null ? 1 : code));
});

function rotateIfLarge() {
  try {
    if (fs.statSync(logFile).size < MAX_BYTES) return;
    fs.rmSync(`${logFile}.1`, { force: true });
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* dosya yok ya da kilitli — sorun degil, eklemeye devam */
  }
}
