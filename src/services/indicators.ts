import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getJobWorkerPool as getWorkerPool } from '../workers/pool.js';
import { candleToRaw } from '../workers/types.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import type { Candle } from '../types/domain.js';

export interface IndicatorMeta {
  filename: string;
  id: string;
  name: string;
  desc: string;
  author: string;
  category: string;
  drawable: boolean;
}

export interface IndicatorDrawResult {
  drawings: unknown[];
}

const FILENAME_RE = /^[a-zA-Z0-9_-]{1,80}\.py$/;

export class IndicatorService {
  constructor(private readonly dir: string) {}

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<IndicatorMeta[]> {
    await this.ensureDir();
    const files = (await fs.readdir(this.dir))
      .filter((file) => file.endsWith('.py'))
      .filter((file) => !file.startsWith('__'))
      .filter((file) => file !== 'indicators.py');

    const out: IndicatorMeta[] = [];
    for (const file of files) {
      try {
        const code = await fs.readFile(path.join(this.dir, file), 'utf8');
        out.push({ filename: file, id: file.replace(/\.py$/i, ''), ...parseMeta(code) });
      } catch {
        // Bozuk indicator dosyasi listeyi bozmamali.
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }

  async get(filename: string): Promise<{ filename: string; filepath: string; code: string } & IndicatorMeta> {
    const safe = this.validateFilename(filename);
    const filepath = path.join(this.dir, safe);
    try {
      const code = await fs.readFile(filepath, 'utf8');
      return { filename: safe, filepath, code, id: safe.replace(/\.py$/i, ''), ...parseMeta(code) };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`Indikator ${safe}`);
      }
      throw err;
    }
  }

  async draw(filename: string, candles: Candle[], params: Record<string, unknown> = {}): Promise<IndicatorDrawResult> {
    const indicator = await this.get(filename);
    if (!indicator.drawable) {
      throw new ValidationError(`${indicator.name} grafik cizimi desteklemiyor`);
    }
    if (candles.length < 2) return { drawings: [] };

    const instanceId = `indicator_${indicator.id}_${Date.now().toString(36)}`;
    try {
      await getWorkerPool().loadCode(instanceId, indicator.filepath, indicator.code, params);
      const data = await getWorkerPool().draw(instanceId, {
        candles: candles.map(candleToRaw),
      });
      return { drawings: Array.isArray(data.drawings) ? data.drawings : [] };
    } finally {
      await getWorkerPool().drop(instanceId).catch(() => undefined);
    }
  }

  private validateFilename(input: string): string {
    if (typeof input !== 'string' || !input.trim()) {
      throw new ValidationError('filename gerekli');
    }
    let file = input.trim();
    if (!file.endsWith('.py')) file = `${file}.py`;
    file = path.basename(file);
    if (!FILENAME_RE.test(file)) {
      throw new ValidationError('Gecersiz indikator adi');
    }
    return file;
  }
}

function parseMeta(code: string): Omit<IndicatorMeta, 'filename' | 'id'> {
  const lines = code.split('\n').slice(0, 20);
  const grab = (key: string): string => {
    const line = lines.find((item) => item.trimStart().startsWith(`# ${key}:`));
    return line ? line.slice(line.indexOf(':') + 1).trim() : '';
  };
  return {
    name: grab('name') || 'Isimsiz',
    desc: grab('desc'),
    author: grab('author'),
    category: grab('category') || 'Genel',
    drawable: /\ndef\s+draw\s*\(/.test(`\n${code}`),
  };
}

let svc: IndicatorService | null = null;
export function getIndicatorService(): IndicatorService {
  if (!svc) {
    svc = new IndicatorService(path.resolve(process.cwd(), 'python/indicators'));
  }
  return svc;
}
