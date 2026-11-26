/**
 * Atomik JSON dosya yazma.
 *
 * Atomik yazım: önce benzersiz bir .tmp dosyasına yaz, sonra rename.
 *
 * Eşzamanlılık: aynı dosyaya yapılan TÜM erişimler (okuma, yazma ve
 * oku-değiştir-yaz) dosya başına bir kuyruktan geçer. Böylece iki bot aynı
 * anda trade eklediğinde biri diğerinin kaydını ezmez (lost update) ve
 * Windows'ta açık bir okuma handle'ı rename'i EPERM ile düşürmez.
 *
 * Windows: rename hedef dosya başka bir handle tarafından (antivirüs, indeksleyici)
 * kısa süre tutulduğunda EPERM/EACCES/EBUSY verebilir — birkaç kez yeniden denenir.
 * Başarısız yazımda .tmp dosyası silinir, diskte yetim dosya bırakılmaz.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StorageError } from '../../utils/errors.js';

/** Dosya başına erişim kuyruğu (kuyruğun kuyruğu — asla reject olmaz). */
const fileQueues = new Map<string, Promise<unknown>>();

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRIES = 8;

/** Yetim tmp dosya adı: `<isim>.json.tmp.<pid>.<ms>[.<hex>]` */
const TEMP_FILE_RE = /\.json\.tmp\.\d+\.\d+(?:\.[0-9a-f]+)?$/;

export interface WriteJsonOptions {
  /** true (varsayılan): okunabilir girintili JSON. Büyük dosyalarda false kullanın. */
  pretty?: boolean;
}

/** Aynı dosya için `fn`'i sıraya sokar; önceki işlemler bitmeden başlamaz. */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = fileQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => undefined);
  fileQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (fileQueues.get(key) === tail) fileQueues.delete(key);
  }
}

export async function readJson<T>(filePath: string, defaultValue: T): Promise<T> {
  return withFileLock(filePath, () => readJsonUnlocked(filePath, defaultValue));
}

export async function writeJson<T>(filePath: string, data: T, opts: WriteJsonOptions = {}): Promise<void> {
  await withFileLock(filePath, () => writeJsonUnlocked(filePath, data, opts));
}

/**
 * Oku → değiştir → yaz işlemini tek kilit altında yapar.
 *
 * `mutate` veriyi yerinde değiştirebilir; dönüş değeri çağırana iletilir.
 * `mutate` hata fırlatırsa dosyaya hiçbir şey yazılmaz.
 */
export async function updateJson<T, R>(
  filePath: string,
  defaultValue: T,
  mutate: (data: T) => R | Promise<R>,
  opts: WriteJsonOptions = {}
): Promise<R> {
  return withFileLock(filePath, async () => {
    const data = await readJsonUnlocked(filePath, defaultValue);
    const result = await mutate(data);
    await writeJsonUnlocked(filePath, data, opts);
    return result;
  });
}

/**
 * Önceki çökmüş/başarısız yazımlardan kalan tmp dosyalarını siler.
 * Sadece bu modülün ürettiği isim kalıbına uyan ve `olderThanMs`'den eski
 * dosyalara dokunur (o an süren bir yazımı silmemek için).
 */
export async function cleanupStaleTempFiles(
  dir: string,
  olderThanMs = 10 * 60_000
): Promise<{ files: number; bytes: number }> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { files: 0, bytes: 0 };
    throw err;
  }

  const cutoff = Date.now() - olderThanMs;
  let files = 0;
  let bytes = 0;
  for (const name of entries) {
    if (!TEMP_FILE_RE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      await fs.rm(full, { force: true });
      files += 1;
      bytes += stat.size;
    } catch {
      /* kilitli/erişilemeyen dosya — bir sonraki açılışta tekrar denenir */
    }
  }
  return { files, bytes };
}

/* ─── Internal ─────────────────────────────────────────── */

async function readJsonUnlocked<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultValue;
    throw new StorageError(`JSON okuma hatası: ${filePath}`, err);
  }
}

async function writeJsonUnlocked<T>(filePath: string, data: T, opts: WriteJsonOptions): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const body = opts.pretty === false ? JSON.stringify(data) : JSON.stringify(data, null, 2);
    await fs.writeFile(tmp, body, 'utf8');
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new StorageError(`JSON yazma hatası: ${filePath}`, err);
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRIES) throw err;
      await delay(Math.min(1000, 20 * 2 ** attempt));
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
