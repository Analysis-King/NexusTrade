#!/usr/bin/env node
// data/ klasorunu tarihli bir .tar.gz arsivine yedekler ve eski arsivleri temizler.
//
//   node scripts/backup-data.cjs                     -> varsayilan hedef: <repo>/../nexustrade-backups
//   node scripts/backup-data.cjs --dest=E:\yedek     -> farkli hedef (BACKUP_DIR ortam degiskeni de olur)
//   node scripts/backup-data.cjs --keep=30           -> son 30 arsivi tut (varsayilan 14)
//
// Haric: klines_cache/ (Binance'ten yeniden indirilebilir), kilit ve gecici dosyalar.
// .env yedeklenmez: icindeki anahtarlar duz metin arsive girmesin; onu sifre yoneticisinde sakla.
// Hedef ayni diskteyse sadece yanlislikla silmeye karsi korur; disk arizasi icin baska bir disk
// ya da bulutla senkronlanan bir klasor (OneDrive vb.) sec.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PREFIX = 'nexustrade-data-';
const SUFFIX = '.tar.gz';
const EXCLUDES = ['klines_cache', '*.lock', '*.tmp', '*.partial'];

const args = Object.fromEntries(process.argv.slice(2)
  .filter((value) => value.startsWith('--'))
  .map((value) => {
    const [key, ...rest] = value.slice(2).split('=');
    return [key, rest.length ? rest.join('=') : 'true'];
  }));

const destDir = path.resolve(args.dest || process.env.BACKUP_DIR || path.join(ROOT, '..', 'nexustrade-backups'));
const keep = Math.max(1, Math.floor(Number(args.keep || process.env.BACKUP_KEEP || 14)) || 14);

try {
  main();
} catch (error) {
  console.error(`Yedekleme basarisiz: ${error.message}`);
  process.exitCode = 1;
}

function main() {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`data klasoru yok: ${DATA_DIR}`);
  if (isInside(destDir, ROOT)) throw new Error(`Hedef repo icinde olamaz: ${destDir}`);
  fs.mkdirSync(destDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const finalPath = path.join(destDir, `${PREFIX}${stamp}${SUFFIX}`);
  const partialPath = `${finalPath}.partial`;
  const started = Date.now();

  // State dosyalari atomik (tmp + rename) yaziliyor; arsivleme sirasinda biri degisirse tar
  // uyari verip hata kodu donebilir. Bir kez daha dene.
  let result = createArchive(partialPath);
  if (result.status !== 0) {
    console.warn(`tar ilk denemede ${result.status} dondu, tekrar deneniyor: ${firstLine(result.stderr)}`);
    result = createArchive(partialPath);
  }
  if (result.status !== 0) {
    fs.rmSync(partialPath, { force: true });
    throw new Error(`tar ${result.status} koduyla cikti: ${firstLine(result.stderr) || result.error?.message || ''}`);
  }

  const entries = listArchive(partialPath);
  if (entries < 1) {
    fs.rmSync(partialPath, { force: true });
    throw new Error('Arsiv bos ya da okunamiyor.');
  }
  fs.renameSync(partialPath, finalPath);

  const sizeMb = fs.statSync(finalPath).size / 1024 / 1024;
  const removed = pruneOldArchives();
  console.log(`Yedek alindi: ${finalPath}`);
  console.log(`${entries} kayit, ${sizeMb.toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} sn`);
  console.log(`Tutulan arsiv: en fazla ${keep}${removed.length ? `; silinen eski arsiv: ${removed.length}` : ''}`);
}

function createArchive(outputPath) {
  fs.rmSync(outputPath, { force: true });
  const excludeArgs = EXCLUDES.flatMap((pattern) => ['--exclude', pattern]);
  return spawnSync(tarCommand(), ['-czf', outputPath, ...excludeArgs, '-C', DATA_DIR, '.'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function listArchive(archivePath) {
  const result = spawnSync(tarCommand(), ['-tzf', archivePath], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return 0;
  return result.stdout.split(/\r?\n/).filter((line) => line && !line.endsWith('/')).length;
}

// Sadece bu script'in olusturdugu adlara dokunur; hedefteki baska dosyalar silinmez.
function pruneOldArchives() {
  const pattern = new RegExp(`^${PREFIX}\\d{8}T\\d{6}Z${SUFFIX.replace(/\./g, '\\.')}$`);
  const archives = fs.readdirSync(destDir).filter((name) => pattern.test(name)).sort();
  const excess = archives.slice(0, Math.max(0, archives.length - keep));
  for (const name of excess) fs.rmSync(path.join(destDir, name), { force: true });
  return excess;
}

// Windows'ta Git Bash'in GNU tar'i "C:" gibi yollari uzak sunucu sanar; sistemin bsdtar'ini kullan.
function tarCommand() {
  if (process.platform === 'win32') {
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(systemTar)) return systemTar;
  }
  return 'tar';
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function firstLine(text) {
  return String(text || '').trim().split(/\r?\n/)[0] || '';
}
