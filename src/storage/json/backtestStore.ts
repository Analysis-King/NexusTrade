/**
 * JSON dosya tabanlı BacktestStore — her çalıştırma ayrı dosyada.
 *
 *   data/backtests/<id>.json
 *
 * Eskiden tüm çalıştırmalar tek bir `backtests.json` içindeydi (~90 MB). Her
 * liste/detay isteği bu dosyayı baştan sona okuyor, her ilerleme güncellemesi
 * de 90 MB'ı yeniden yazıyordu. Artık:
 *   - Filtre/sıralama için hafif bir indeks bellekte tutulur.
 *   - Okuma/yazma sadece ilgili çalıştırmanın dosyasına dokunur.
 *
 * Eski `backtests.json` ilk erişimde otomatik bölünür ve
 * `backtests.json.migrated-<zaman>` olarak yeniden adlandırılır (silinmez).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BacktestRun, BacktestStatus } from '../../types/backtest.js';
import type { BacktestStore } from '../types.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import { readJson, updateJson, writeJson } from './atomicFile.js';

const log = createLogger('backtest-store');

interface LegacyBacktestsFile {
  version: 1;
  runs: BacktestRun[];
}

interface IndexEntry {
  id: string;
  createdAtMs: number;
  status: BacktestStatus;
  symbol: string;
  strategyFile: string;
}

const MAX_RUNS = 1000;
/** Dosya adı olarak güvenli id (path traversal engeli). */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export class JsonBacktestStore implements BacktestStore {
  private readonly dir: string;
  private readonly legacyPath: string;
  private index: Map<string, IndexEntry> | null = null;
  private loading: Promise<Map<string, IndexEntry>> | null = null;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'backtests');
    this.legacyPath = path.join(dataDir, 'backtests.json');
  }

  async list(
    opts: { limit?: number; status?: BacktestStatus; symbol?: string; strategyFile?: string } = {}
  ): Promise<BacktestRun[]> {
    const index = await this.ensureIndex();
    let entries = [...index.values()];
    if (opts.status) entries = entries.filter((r) => r.status === opts.status);
    if (opts.symbol) entries = entries.filter((r) => r.symbol === opts.symbol);
    if (opts.strategyFile) entries = entries.filter((r) => r.strategyFile === opts.strategyFile);
    entries.sort((a, b) => b.createdAtMs - a.createdAtMs);
    if (opts.limit) entries = entries.slice(0, opts.limit);

    const runs = await Promise.all(entries.map((entry) => this.readRun(entry.id)));
    return runs.filter((run): run is BacktestRun => run !== null);
  }

  async get(id: string): Promise<BacktestRun | null> {
    if (!SAFE_ID_RE.test(id)) return null;
    const index = await this.ensureIndex();
    if (!index.has(id)) return null;
    return this.readRun(id);
  }

  async create(run: BacktestRun): Promise<BacktestRun> {
    assertSafeId(run.id);
    const index = await this.ensureIndex();
    if (index.has(run.id)) {
      throw new ConflictError(`Backtest zaten var: ${run.id}`);
    }
    // Indeksi yazimdan once ayir — ayni id ile eszamanli create cakismasin.
    index.set(run.id, toIndexEntry(run));
    try {
      await writeJson(this.runPath(run.id), run, { pretty: false });
    } catch (err) {
      index.delete(run.id);
      throw err;
    }
    await this.trimOldRuns(index);
    return run;
  }

  async update(id: string, patch: Partial<BacktestRun>): Promise<BacktestRun> {
    if (!SAFE_ID_RE.test(id)) throw new NotFoundError(`Backtest ${id}`);
    const index = await this.ensureIndex();
    if (!index.has(id)) throw new NotFoundError(`Backtest ${id}`);

    const updated = await updateJson<BacktestRun | null, BacktestRun>(
      this.runPath(id),
      null,
      (current) => {
        if (!current) throw new NotFoundError(`Backtest ${id}`);
        // Yerinde guncelle — updateJson ayni nesneyi diske yazar.
        Object.assign(current, patch, { id, updatedAt: new Date().toISOString() });
        return current;
      },
      { pretty: false }
    );
    index.set(id, toIndexEntry(updated));
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!SAFE_ID_RE.test(id)) throw new NotFoundError(`Backtest ${id}`);
    const index = await this.ensureIndex();
    if (!index.has(id)) throw new NotFoundError(`Backtest ${id}`);
    await fs.rm(this.runPath(id), { force: true });
    index.delete(id);
  }

  /* ─── Internal ─────────────────────────────────────────── */

  private runPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async readRun(id: string): Promise<BacktestRun | null> {
    try {
      return await readJson<BacktestRun | null>(this.runPath(id), null);
    } catch (err) {
      log.warn({ id, err }, 'Backtest dosyasi okunamadi');
      return null;
    }
  }

  private ensureIndex(): Promise<Map<string, IndexEntry>> {
    if (this.index) return Promise.resolve(this.index);
    if (!this.loading) {
      this.loading = this.loadIndex()
        .then((index) => {
          this.index = index;
          return index;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  private async loadIndex(): Promise<Map<string, IndexEntry>> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.migrateLegacyFile();

    const index = new Map<string, IndexEntry>();
    const names = await fs.readdir(this.dir);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!SAFE_ID_RE.test(id)) continue;
      const run = await this.readRun(id);
      if (run && run.id === id) index.set(id, toIndexEntry(run));
    }
    log.info({ count: index.size }, 'Backtest indeksi yuklendi');
    return index;
  }

  /** Tek dosyalık eski formatı çalıştırma başına dosyalara böler. */
  private async migrateLegacyFile(): Promise<void> {
    let legacy: LegacyBacktestsFile | null;
    try {
      legacy = await readJson<LegacyBacktestsFile | null>(this.legacyPath, null);
    } catch (err) {
      log.error({ err, file: this.legacyPath }, 'Eski backtests.json okunamadi, tasima atlandi');
      return;
    }
    if (!legacy) return;

    const runs = Array.isArray(legacy.runs) ? legacy.runs : [];
    let moved = 0;
    for (const run of runs) {
      if (!run || typeof run.id !== 'string' || !SAFE_ID_RE.test(run.id)) continue;
      const target = this.runPath(run.id);
      if (await exists(target)) continue;
      await writeJson(target, run, { pretty: false });
      moved += 1;
    }

    const archived = `${this.legacyPath}.migrated-${Date.now()}`;
    try {
      await fs.rename(this.legacyPath, archived);
      log.info({ moved, total: runs.length, archived }, 'backtests.json calistirma basina dosyalara tasindi');
    } catch (err) {
      // Dosyalar zaten tasindi; eski dosya kilitliyse bir sonraki acilista
      // tekrar denenir (var olan calistirma dosyalari atlanir).
      log.warn({ err, moved }, 'Eski backtests.json yeniden adlandirilamadi');
    }
  }

  private async trimOldRuns(index: Map<string, IndexEntry>): Promise<void> {
    if (index.size <= MAX_RUNS) return;
    const oldest = [...index.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, index.size - MAX_RUNS);
    for (const entry of oldest) {
      index.delete(entry.id);
      await fs.rm(this.runPath(entry.id), { force: true }).catch(() => undefined);
    }
  }
}

function toIndexEntry(run: BacktestRun): IndexEntry {
  const createdAtMs = Date.parse(run.createdAt);
  return {
    id: run.id,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    status: run.status,
    symbol: run.symbol,
    strategyFile: run.strategyFile,
  };
}

function assertSafeId(id: string): void {
  if (!SAFE_ID_RE.test(id)) throw new ConflictError(`Gecersiz backtest id: ${id}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
