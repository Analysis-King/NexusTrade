import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { CreateBotInput } from '../bot/manager.js';
import type { BotMode, Interval } from '../types/domain.js';

const intervalSchema = z.enum([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

const allocationProfileSchema = z.object({
  symbol: z.string().min(1),
  interval: intervalSchema,
  capital_weight_pct: z.number(),
  latest_daily_pct: z.number().nullable().optional(),
});

const recommendedAllocationSchema = z.object({
  strategy: z.string().min(1),
  plan: z.string().min(1),
  leverage: z.number().nullable().optional(),
  max_position_pct: z.number().nullable().optional(),
  expectedDailyPct: z.number().nullable().optional(),
  walkForwardAvgDailyPct: z.number().nullable().optional(),
  walkForwardMedianDailyPct: z.number().nullable().optional(),
  walkForwardWorstDailyPct: z.number().nullable().optional(),
  profiles: z.array(allocationProfileSchema),
});

const reportSchema = z.object({
  generatedAt: z.string().optional(),
  recommendedAllocation: recommendedAllocationSchema,
});

export interface PortfolioProfileGate {
  source: string;
  generatedAt: string | null;
  allocation: z.infer<typeof recommendedAllocationSchema>;
}

export interface PortfolioDeployOptions {
  capitalUsd: number;
  mode: BotMode;
  prefix: string;
  maxLossPct: number;
  takeProfitPct: number;
  dailyMaxLossPct: number;
  stopLossMode: 'percent' | 'target_ratio' | 'strategy';
  stopLossTargetRatio: number;
  leverage?: number;
}

export interface PortfolioBotDraft {
  profile: string;
  weightPct: number;
  expectedDailyPct: number | null;
  bot: CreateBotInput;
}

export async function loadPortfolioProfileGate(): Promise<PortfolioProfileGate> {
  const source = path.resolve(env.PORTFOLIO_PROFILE_REPORT);
  const raw = await fs.readFile(source, 'utf8');
  const parsed = reportSchema.parse(JSON.parse(raw));
  return {
    source,
    generatedAt: parsed.generatedAt ?? null,
    allocation: parsed.recommendedAllocation,
  };
}

export function buildPortfolioBotDrafts(
  gate: PortfolioProfileGate,
  options: PortfolioDeployOptions
): PortfolioBotDraft[] {
  const allocation = gate.allocation;
  const strategyId = normalizeStrategyId(allocation.strategy);
  const leverage = normalizePositive(options.leverage ?? allocation.leverage ?? 1, 1);
  const maxPositionPct = normalizePositive(allocation.max_position_pct ?? 100, 100);

  return allocation.profiles.map((profile) => {
    const weightPct = Math.max(0, profile.capital_weight_pct);
    const weight = weightPct / 100;
    const botCapital = roundUsd(options.capitalUsd * weight);
    const maxPositionUsd = roundUsd(botCapital * leverage * (maxPositionPct / 100));
    const dailyMaxLossUsd = roundUsd(botCapital * (options.dailyMaxLossPct / 100));
    const profileKey = `${profile.symbol}:${profile.interval}`;

    return {
      profile: profileKey,
      weightPct,
      expectedDailyPct: profile.latest_daily_pct ?? null,
      bot: {
        name: makeBotName(options.prefix, profile.symbol, profile.interval),
        symbol: profile.symbol,
        interval: profile.interval as Interval,
        mode: options.mode,
        strategyId,
        capitalUsd: botCapital,
        strategyParams: {
          profile_gate: {
            source: path.basename(gate.source),
            generatedAt: gate.generatedAt,
            plan: allocation.plan,
            profile: profileKey,
            weightPct,
            latestDailyPct: profile.latest_daily_pct ?? null,
            expectedDailyPct: allocation.expectedDailyPct ?? null,
            walkForwardAvgDailyPct: allocation.walkForwardAvgDailyPct ?? null,
            walkForwardMedianDailyPct: allocation.walkForwardMedianDailyPct ?? null,
            walkForwardWorstDailyPct: allocation.walkForwardWorstDailyPct ?? null,
          },
        },
        risk: {
          maxLossPct: options.maxLossPct,
          takeProfitPct: options.takeProfitPct,
          maxPositionUsd,
          dailyMaxLossUsd,
          stopLossMode: options.stopLossMode,
          stopLossTargetRatio: options.stopLossTargetRatio,
          leverage,
        },
      },
    };
  });
}

function normalizeStrategyId(strategy: string): string {
  const trimmed = strategy.trim();
  return trimmed.endsWith('.py') ? trimmed : `${trimmed}.py`;
}

function makeBotName(prefix: string, symbol: string, interval: string): string {
  const cleanPrefix = prefix.trim() || 'Gate';
  return `${cleanPrefix} ${symbol} ${interval}`.slice(0, 60);
}

function normalizePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
