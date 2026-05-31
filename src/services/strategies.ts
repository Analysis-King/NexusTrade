/**
 * Strateji dosyaları (Python) için CRUD servisi.
 *
 * python/strategies/ klasöründeki .py dosyalarını listeler/okur/yazar.
 * Frontend bot editörü buradan çağırıyor.
 *
 * Güvenlik notu:
 *   - filename validation şart (path traversal guard)
 *   - Bu klasörde Python kodu çalıştırılıyor → user-uploaded kod = code execution.
 *   - Multi-user'a geçtiğimizde (Hafta 4+) kullanıcı başına sandbox lazım.
 *     Şimdilik tek kullanıcı varsayımıyla güvenli kabul ediyoruz.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';

export interface StrategyMeta {
  filename: string;
  name: string;
  desc: string;
  author: string;
}

export interface StrategyFull extends StrategyMeta {
  code: string;
}

// Sadece harf/rakam/alt çizgi/tire izin verilir + .py uzantısı
const FILENAME_RE = /^[a-zA-Z0-9_-]{1,80}\.py$/;

export class StrategyService {
  constructor(private readonly dir: string) {}

  /** Klasör yoksa oluştur. */
  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<StrategyMeta[]> {
    await this.ensureDir();
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.py'));
    const out: StrategyMeta[] = [];
    for (const f of files) {
      try {
        const raw = await fs.readFile(path.join(this.dir, f), 'utf8');
        out.push({ filename: f, ...parseMeta(raw) });
      } catch {
        // Bozuk dosyayı atla, listenin geri kalanını döndür
      }
    }
    return out;
  }

  async get(filename: string): Promise<StrategyFull> {
    const safe = this.validateFilename(filename);
    const filepath = path.join(this.dir, safe);
    try {
      const code = await fs.readFile(filepath, 'utf8');
      return { filename: safe, code, ...parseMeta(code) };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`Strateji ${safe}`);
      }
      throw err;
    }
  }

  /** Yeni strateji oluştur — varsa hata. */
  async create(filename: string, code: string): Promise<StrategyMeta> {
    const safe = this.validateFilename(filename);
    await this.ensureDir();
    const filepath = path.join(this.dir, safe);
    try {
      await fs.access(filepath);
      throw new ConflictError(`Strateji zaten var: ${safe}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (err instanceof ConflictError) throw err;
      }
    }
    await fs.writeFile(filepath, code, 'utf8');
    return { filename: safe, ...parseMeta(code) };
  }

  /** Var olan stratejiyi güncelle (üzerine yazar). */
  async update(filename: string, code: string): Promise<StrategyMeta> {
    const safe = this.validateFilename(filename);
    await this.ensureDir();
    const filepath = path.join(this.dir, safe);
    // Var mı kontrol et
    try {
      await fs.access(filepath);
    } catch {
      throw new NotFoundError(`Strateji ${safe}`);
    }
    await fs.writeFile(filepath, code, 'utf8');
    return { filename: safe, ...parseMeta(code) };
  }

  async delete(filename: string): Promise<void> {
    const safe = this.validateFilename(filename);
    const filepath = path.join(this.dir, safe);
    try {
      await fs.unlink(filepath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`Strateji ${safe}`);
      }
      throw err;
    }
  }

  /** filename'i doğrula, path traversal koru, .py ekle (yoksa). */
  private validateFilename(input: string): string {
    if (typeof input !== 'string' || !input.trim()) {
      throw new ValidationError('filename gerekli');
    }
    let f = input.trim();
    if (!f.endsWith('.py')) f = `${f}.py`;
    // path.basename ile dizin parçasını kes (../etc gibi saldırılar)
    f = path.basename(f);
    if (!FILENAME_RE.test(f)) {
      throw new ValidationError('Geçersiz strateji adı (sadece harf, rakam, _, -)');
    }
    return f;
  }
}

function parseMeta(code: string): { name: string; desc: string; author: string } {
  const lines = code.split('\n').slice(0, 15);
  const grab = (key: string): string => {
    const line = lines.find((l) => l.trimStart().startsWith(`# ${key}:`));
    return line ? line.slice(line.indexOf(':') + 1).trim() : '';
  };
  return {
    name: grab('name') || 'İsimsiz',
    desc: grab('desc'),
    author: grab('author'),
  };
}

/* ─── Singleton ────────────────────────────────────────── */

let svc: StrategyService | null = null;
export function getStrategyService(): StrategyService {
  if (!svc) {
    const dir = path.resolve(process.cwd(), 'python/strategies');
    svc = new StrategyService(dir);
  }
  return svc;
}
