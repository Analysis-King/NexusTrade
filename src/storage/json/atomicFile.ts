/**
 * Atomik JSON dosya yazma.
 *
 * Mevcut sistemde yarım yazma sırasında crash olursa bots.json bozuluyor.
 * Atomik yazım: önce .tmp'ye yaz, sonra rename. POSIX'te rename atomiktir.
 *
 * Aynı dosyaya eşzamanlı yazma race condition'ını basit bir mutex ile çözüyoruz.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StorageError } from '../../utils/errors.js';

/** Dosya başına basit yazma kuyruğu. */
const writeLocks = new Map<string, Promise<void>>();

async function withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  writeLocks.set(filePath, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (writeLocks.get(filePath) === prev.then(() => next)) {
      writeLocks.delete(filePath);
    }
  }
}

export async function readJson<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultValue;
    throw new StorageError(`JSON okuma hatası: ${filePath}`, err);
  }
}

export async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await withLock(filePath, async () => {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      throw new StorageError(`JSON yazma hatası: ${filePath}`, err);
    }
  });
}
