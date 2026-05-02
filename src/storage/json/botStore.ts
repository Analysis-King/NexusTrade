/**
 * JSON dosya tabanlı BotStore implementasyonu.
 *
 * Tüm botları tek dosyada (bots.json) tutar. Küçük ölçek için yeterli.
 * Ölçek büyüdüğünde SQLite implementasyonu ile değiştirilecek.
 */

import path from 'node:path';
import type { BotConfig } from '../../types/domain.js';
import type { BotStore } from '../types.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { readJson, writeJson } from './atomicFile.js';

interface BotsFile {
  version: 1;
  bots: BotConfig[];
}

export class JsonBotStore implements BotStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'bots.json');
  }

  private async readAll(): Promise<BotsFile> {
    return readJson<BotsFile>(this.filePath, { version: 1, bots: [] });
  }

  private async writeAll(data: BotsFile): Promise<void> {
    await writeJson(this.filePath, data);
  }

  async list(): Promise<BotConfig[]> {
    const data = await this.readAll();
    return data.bots;
  }

  async get(id: string): Promise<BotConfig | null> {
    const data = await this.readAll();
    return data.bots.find((b) => b.id === id) ?? null;
  }

  async create(bot: BotConfig): Promise<BotConfig> {
    const data = await this.readAll();
    if (data.bots.some((b) => b.id === bot.id)) {
      throw new ConflictError(`Bot zaten var: ${bot.id}`);
    }
    data.bots.push(bot);
    await this.writeAll(data);
    return bot;
  }

  async update(id: string, patch: Partial<BotConfig>): Promise<BotConfig> {
    const data = await this.readAll();
    const idx = data.bots.findIndex((b) => b.id === id);
    if (idx === -1) throw new NotFoundError(`Bot ${id}`);
    const updated: BotConfig = {
      ...data.bots[idx]!,
      ...patch,
      id, // ID değiştirilemez
      updatedAt: Date.now(),
    };
    data.bots[idx] = updated;
    await this.writeAll(data);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const data = await this.readAll();
    const before = data.bots.length;
    data.bots = data.bots.filter((b) => b.id !== id);
    if (data.bots.length === before) throw new NotFoundError(`Bot ${id}`);
    await this.writeAll(data);
  }
}
