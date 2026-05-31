import path from 'node:path';
import type { BacktestRun, BacktestStatus } from '../../types/backtest.js';
import type { BacktestStore } from '../types.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { readJson, writeJson } from './atomicFile.js';

interface BacktestsFile {
  version: 1;
  runs: BacktestRun[];
}

const MAX_RUNS = 1000;

export class JsonBacktestStore implements BacktestStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'backtests.json');
  }

  private async readAll(): Promise<BacktestsFile> {
    return readJson<BacktestsFile>(this.filePath, { version: 1, runs: [] });
  }

  private async writeAll(data: BacktestsFile): Promise<void> {
    await writeJson(this.filePath, data);
  }

  async list(
    opts: { limit?: number; status?: BacktestStatus; symbol?: string; strategyFile?: string } = {}
  ): Promise<BacktestRun[]> {
    const data = await this.readAll();
    let runs = data.runs;
    if (opts.status) runs = runs.filter((r) => r.status === opts.status);
    if (opts.symbol) runs = runs.filter((r) => r.symbol === opts.symbol);
    if (opts.strategyFile) runs = runs.filter((r) => r.strategyFile === opts.strategyFile);
    runs = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (opts.limit) runs = runs.slice(0, opts.limit);
    return runs;
  }

  async get(id: string): Promise<BacktestRun | null> {
    const data = await this.readAll();
    return data.runs.find((r) => r.id === id) ?? null;
  }

  async create(run: BacktestRun): Promise<BacktestRun> {
    const data = await this.readAll();
    if (data.runs.some((r) => r.id === run.id)) {
      throw new ConflictError(`Backtest zaten var: ${run.id}`);
    }
    data.runs.push(run);
    if (data.runs.length > MAX_RUNS) {
      data.runs = data.runs
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(-MAX_RUNS);
    }
    await this.writeAll(data);
    return run;
  }

  async update(id: string, patch: Partial<BacktestRun>): Promise<BacktestRun> {
    const data = await this.readAll();
    const idx = data.runs.findIndex((r) => r.id === id);
    if (idx === -1) throw new NotFoundError(`Backtest ${id}`);
    const updated: BacktestRun = {
      ...data.runs[idx]!,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    };
    data.runs[idx] = updated;
    await this.writeAll(data);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const data = await this.readAll();
    const before = data.runs.length;
    data.runs = data.runs.filter((r) => r.id !== id);
    if (data.runs.length === before) throw new NotFoundError(`Backtest ${id}`);
    await this.writeAll(data);
  }
}
