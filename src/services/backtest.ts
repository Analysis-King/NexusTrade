import crypto from 'node:crypto';
import { BinanceClient } from './binance/client.js';
import { intervalToMs, klineToCandle } from './binance/marketData.js';
import { getStrategyService } from './strategies.js';
import { getStorage } from '../storage/index.js';
import { candleToRaw } from '../workers/types.js';
import { getWorkerPool } from '../workers/pool.js';
import { ValidationError } from '../utils/errors.js';
import type { Candle, Interval } from '../types/domain.js';
import type {
  BacktestAssumptions,
  BacktestProgress,
  BacktestRun,
  BacktestSummary,
  BacktestTrade,
  CreateBacktestInput,
  EquityPoint,
  ObservationEvent,
  ObservationStat,
  PatternStat,
  PeriodReport,
} from '../types/backtest.js';

const publicClient = BinanceClient.public();
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BACKTEST_CANDLES = 200_000;

interface PreparedBacktest {
  input: CreateBacktestInput;
  strategy: {
    filename: string;
    code: string;
  };
  range: { startTime: number; endTime: number };
  id: string;
  instanceId: string;
  startedAt: number;
  baseRun: BacktestRun;
}

export class BacktestService {
  async list(opts: Parameters<ReturnType<typeof getStorage>['backtests']['list']>[0] = {}) {
    return getStorage().backtests.list(opts);
  }

  async get(id: string): Promise<BacktestRun> {
    const run = await getStorage().backtests.get(id);
    if (!run) throw new ValidationError(`Backtest bulunamadi: ${id}`);
    return run;
  }

  async delete(id: string): Promise<void> {
    await getStorage().backtests.delete(id);
  }

  async create(input: CreateBacktestInput): Promise<BacktestRun> {
    const prepared = await this.prepare(input, 'running');
    return this.execute(prepared);
  }

  async createAsync(input: CreateBacktestInput): Promise<BacktestRun> {
    const prepared = await this.prepare(input, 'queued');
    void this.execute(prepared).catch(() => undefined);
    return prepared.baseRun;
  }

  private async prepare(input: CreateBacktestInput, status: BacktestRun['status']): Promise<PreparedBacktest> {
    const strategy = input.code
      ? {
          filename: input.strategyFile,
          code: input.code,
        }
      : await getStrategyService().get(input.strategyFile);
    const strategyHash = hashText(strategy.code);
    const range = resolveRange(input);
    const assumptions: BacktestAssumptions = {
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
      fillModel: input.fillModel,
      sameCandleTpSl:
        input.params.same_candle_tp_sl === 'take_profit_first' ? 'take_profit_first' : 'stop_first',
    };

    const now = new Date().toISOString();
    const id = createRunId();
    const instanceId = `backtest_${id}`;
    const startedAt = Date.now();
    const baseRun: BacktestRun = {
      id,
      createdAt: now,
      updatedAt: now,
      status,
      strategyFile: strategy.filename,
      strategyHash,
      symbol: input.symbol,
      interval: input.interval,
      startTime: range.startTime,
      endTime: range.endTime,
      candleCount: 0,
      initialCapital: input.initialCapital,
      params: input.params,
      assumptions,
      progress: {
        stage: status === 'queued' ? 'queued' : 'fetching_data',
        pct: status === 'queued' ? 1 : 5,
        message: status === 'queued' ? 'Backtest siraya alindi.' : 'Mum verisi cekiliyor...',
        startedAt,
        updatedAt: startedAt,
      },
    };

    await getStorage().backtests.create(baseRun);
    return { input, strategy, range, id, instanceId, startedAt, baseRun };
  }

  private async execute(prepared: PreparedBacktest): Promise<BacktestRun> {
    const { input, strategy, range, id, instanceId, startedAt } = prepared;
    try {
      await this.updateProgress(id, startedAt, {
        stage: 'fetching_data',
        pct: 5,
        message: 'Mum verisi cekiliyor...',
      });
      const candles = await fetchCandles(input.symbol, input.interval, range.startTime, range.endTime, (progress) =>
        this.updateProgress(id, startedAt, {
          stage: 'fetching_data',
          pct: 5 + Math.min(40, Math.round((progress.fetched / Math.max(1, progress.estimated)) * 40)),
          message: `${progress.fetched.toLocaleString('tr-TR')} mum alindi.`,
          candlesFetched: progress.fetched,
          estimatedCandles: progress.estimated,
        })
      );
      if (candles.length === 0) {
        throw new ValidationError('Secilen aralikta mum verisi bulunamadi');
      }
      if (candles.length > MAX_BACKTEST_CANDLES) {
        throw new ValidationError(`Backtest cok buyuk: ${candles.length} mum`);
      }

      await this.updateProgress(id, startedAt, {
        stage: 'loading_worker',
        pct: 52,
        message: 'Strateji motoru hazirlaniyor...',
        candleCount: candles.length,
      });

      if (input.code) {
        await getWorkerPool().loadCode(instanceId, strategy.filename, strategy.code, input.params);
      } else {
        await getWorkerPool().load(instanceId, strategy.filename, input.params);
      }

      await this.updateProgress(id, startedAt, {
        stage: 'running_strategy',
        pct: 68,
        message: 'Strateji mumlar uzerinde calisiyor...',
        candleCount: candles.length,
      });
      const rawResult = await getWorkerPool().backtest(instanceId, {
        candles: candles.map(candleToRaw),
        initial_capital: input.initialCapital,
        fee_bps: input.feeBps,
        slippage_bps: input.slippageBps,
        fill_model: input.fillModel,
        params: input.params,
      });

      const raw = toRecord(rawResult);
      if (typeof raw.error === 'string') {
        throw new ValidationError(raw.error);
      }

      await this.updateProgress(id, startedAt, {
        stage: 'finalizing',
        pct: 92,
        message: 'Sonuc raporu hazirlaniyor...',
        candleCount: candles.length,
      });
      const normalized = normalizeBacktestResult(raw, input.initialCapital, range.startTime, range.endTime);
      return getStorage().backtests.update(id, {
        status: 'completed',
        candleCount: candles.length,
        progress: {
          stage: 'completed',
          pct: 100,
          message: 'Backtest tamamlandi.',
          startedAt,
          updatedAt: Date.now(),
          candleCount: candles.length,
        },
        summary: normalized.summary,
        trades: normalized.trades,
        equity: normalized.equity,
        patterns: normalized.patterns,
        observations: normalized.observations,
        observationStats: normalized.observationStats,
        periodReports: normalized.periodReports,
        raw,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await getStorage().backtests.update(id, {
        status: 'failed',
        error: message,
        progress: {
          stage: 'failed',
          pct: 100,
          message,
          startedAt,
          updatedAt: Date.now(),
        },
      });
      throw err;
    } finally {
      await getWorkerPool().drop(instanceId).catch(() => undefined);
    }
  }

  private async updateProgress(
    id: string,
    startedAt: number,
    progress: Omit<BacktestProgress, 'startedAt' | 'updatedAt'> & Partial<Pick<BacktestProgress, 'startedAt'>>
  ): Promise<void> {
    await getStorage().backtests
      .update(id, {
        status: progress.stage === 'failed' ? 'failed' : progress.stage === 'completed' ? 'completed' : 'running',
        progress: {
          ...progress,
          pct: clampProgress(progress.pct),
          startedAt: progress.startedAt ?? startedAt,
          updatedAt: Date.now(),
        },
      })
      .catch(() => undefined);
  }
}

let service: BacktestService | null = null;
export function getBacktestService(): BacktestService {
  if (!service) service = new BacktestService();
  return service;
}

async function fetchCandles(
  symbol: string,
  interval: Interval,
  startTime: number,
  endTime: number,
  onProgress?: (progress: { fetched: number; estimated: number }) => void | Promise<void>
): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startTime;
  const intervalMs = intervalToMs(interval);
  const estimated = Math.max(1, Math.ceil((endTime - startTime) / intervalMs) + 1);

  while (cursor <= endTime) {
    const raw = await publicClient.klines({
      symbol,
      interval,
      startTime: cursor,
      endTime,
      limit: 1000,
    });
    if (raw.length === 0) break;

    for (const k of raw) {
      const candle = klineToCandle(k);
      if (candle.openTime >= startTime && candle.openTime <= endTime) all.push(candle);
    }
    await onProgress?.({ fetched: all.length, estimated });

    const last = raw[raw.length - 1]!;
    const next = last[6] + 1;
    if (next <= cursor) cursor += intervalMs;
    else cursor = next;

    if (raw.length < 1000) break;
    await sleep(250);
  }

  const byTime = new Map<number, Candle>();
  for (const candle of all) byTime.set(candle.openTime, candle);
  await onProgress?.({ fetched: byTime.size, estimated });
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resolveRange(input: CreateBacktestInput): { startTime: number; endTime: number } {
  const endTime = input.endTime ?? Date.now();
  const days = input.days ?? 90;
  const startTime = input.startTime ?? endTime - days * DAY_MS;

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new ValidationError('Gecersiz backtest tarih araligi');
  }
  if (startTime >= endTime) {
    throw new ValidationError('startTime endTime degerinden kucuk olmali');
  }
  if (endTime - startTime > 5 * 365 * DAY_MS) {
    throw new ValidationError('Backtest araligi en fazla 5 yil olabilir');
  }
  return { startTime, endTime };
}

function normalizeBacktestResult(
  raw: Record<string, unknown>,
  initialCapital: number,
  startTime: number,
  endTime: number
): {
  summary: BacktestSummary;
  trades: BacktestTrade[];
  equity: EquityPoint[];
  patterns: PatternStat[];
  observations: ObservationEvent[];
  observationStats: ObservationStat[];
  periodReports: PeriodReport[];
} {
  if (isRecord(raw.summary)) {
    const summary = normalizeSummary(raw.summary, initialCapital);
    return {
      summary,
      trades: normalizeTrades(raw.trades),
      equity: normalizeEquity(raw.equity, startTime, endTime, initialCapital, summary.finalCapital),
      patterns: normalizePatterns(raw),
      observations: normalizeObservations(raw.observations),
      observationStats: normalizeObservationStats(raw.observationStats),
      periodReports: normalizePeriodReports(raw.periodReports),
    };
  }

  const patterns = normalizePatterns(raw);
  const totalTrades = patterns.reduce((sum, p) => sum + p.trades, 0);
  const totalReturnPct = round2(patterns.reduce((sum, p) => sum + p.totalReturnPct, 0));
  const weightedWins = patterns.reduce((sum, p) => sum + (p.trades * p.winRatePct) / 100, 0);
  const winRatePct = totalTrades > 0 ? round2((weightedWins / totalTrades) * 100) : 0;
  const maxDrawdownPct = round2(Math.max(0, ...patterns.map((p) => p.maxDrawdownPct ?? 0)));
  const profitFactors = patterns.filter((p) => p.profitFactor !== null && Number.isFinite(p.profitFactor));
  const profitFactor =
    profitFactors.length > 0
      ? round2(
          profitFactors.reduce((sum, p) => sum + (p.profitFactor ?? 0) * Math.max(1, p.trades), 0) /
            profitFactors.reduce((sum, p) => sum + Math.max(1, p.trades), 0)
        )
      : null;
  const finalCapital = round2(initialCapital * (1 + totalReturnPct / 100));
  const returns = patterns.map((p) => p.totalReturnPct);
  const summary: BacktestSummary = {
    initialCapital,
    finalCapital,
    totalReturnPct,
    maxDrawdownPct,
    winRatePct,
    profitFactor,
    sharpe: calcSharpe(returns),
    totalTrades,
    avgTradePct: totalTrades > 0 ? round2(totalReturnPct / totalTrades) : null,
    bestTradePct: returns.length ? round2(Math.max(...returns)) : null,
    worstTradePct: returns.length ? round2(Math.min(...returns)) : null,
  };

  return {
    summary,
    trades: [],
    equity: [
      { t: startTime, value: initialCapital },
      { t: endTime, value: finalCapital },
    ],
    patterns,
    observations: normalizeObservations(raw.observations),
    observationStats: normalizeObservationStats(raw.observationStats),
    periodReports: normalizePeriodReports(raw.periodReports),
  };
}

function normalizePeriodReports(raw: unknown): PeriodReport[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((row, idx) => ({
    period: numberValue(row.period, idx + 1),
    startTime: numberValue(row.startTime ?? row.start_time, 0),
    endTime: numberValue(row.endTime ?? row.end_time, 0),
    startEquity: numberValue(row.startEquity ?? row.start_equity, 0),
    endEquity: numberValue(row.endEquity ?? row.end_equity, 0),
    pnl: numberValue(row.pnl, 0),
    returnPct: numberValue(row.returnPct ?? row.return_pct, 0),
    realizedPnl: numberValue(row.realizedPnl ?? row.realized_pnl, 0),
    realizedReturnPct: numberValue(row.realizedReturnPct ?? row.realized_return_pct, 0),
    openPnl: numberValue(row.openPnl ?? row.open_pnl, 0),
    openReturnPct: numberValue(row.openReturnPct ?? row.open_return_pct, 0),
    feePaid: numberValue(row.feePaid ?? row.fee_paid, 0),
    trades: numberValue(row.trades, 0),
    tpTrades: numberValue(row.tpTrades ?? row.tp_trades, 0),
    slTrades: numberValue(row.slTrades ?? row.sl_trades, 0),
    signalTrades: numberValue(row.signalTrades ?? row.signal_trades, 0),
    endTrades: numberValue(row.endTrades ?? row.end_trades, 0),
    wins: numberValue(row.wins, 0),
    losses: numberValue(row.losses, 0),
    winRatePct: numberValue(row.winRatePct ?? row.win_rate_pct, 0),
    profitFactor:
      row.profitFactor === null || row.profit_factor === null
        ? null
        : numberValue(row.profitFactor ?? row.profit_factor, 0),
    maxDrawdownPct: numberValue(row.maxDrawdownPct ?? row.max_drawdown_pct, 0),
  }));
}

function normalizeTrades(raw: unknown): BacktestTrade[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((row, idx) => ({
    id: stringValue(row.id, `tr_${idx + 1}`),
    side: normalizeSide(row.side),
    entryTime: numberValue(row.entryTime ?? row.entry_time, 0),
    entryPrice: numberValue(row.entryPrice ?? row.entry_price, 0),
    slPrice:
      row.slPrice === null || row.slPrice === undefined || row.sl_price === null || row.sl_price === undefined
        ? null
        : numberValue(row.slPrice ?? row.sl_price, 0),
    tpPrice:
      row.tpPrice === null || row.tpPrice === undefined || row.tp_price === null || row.tp_price === undefined
        ? null
        : numberValue(row.tpPrice ?? row.tp_price, 0),
    exitTime: numberValue(row.exitTime ?? row.exit_time, 0),
    exitPrice: numberValue(row.exitPrice ?? row.exit_price, 0),
    qty: numberValue(row.qty, 0),
    notional: numberValue(row.notional, 0),
    grossPnl: numberValue(row.grossPnl ?? row.gross_pnl, 0),
    netPnl: numberValue(row.netPnl ?? row.net_pnl, 0),
    pnlPct: numberValue(row.pnlPct ?? row.pnl_pct, 0),
    accountReturnPct: numberValue(row.accountReturnPct ?? row.account_return_pct, 0),
    feePaid: numberValue(row.feePaid ?? row.fee_paid, 0),
    reason: normalizeTradeReason(row.reason),
    meta: isRecord(row.meta) ? row.meta : undefined,
  }));
}

function normalizeObservations(raw: unknown): ObservationEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((row, idx) => ({
    id: stringValue(row.id, `obs_${idx + 1}`),
    name: stringValue(row.name, `observation_${idx + 1}`),
    side: normalizeSide(row.side),
    signalTime: numberValue(row.signalTime, 0),
    entryTime: numberValue(row.entryTime, 0),
    entryPrice: numberValue(row.entryPrice, 0),
    exitTime: numberValue(row.exitTime, 0),
    exitPrice: numberValue(row.exitPrice, 0),
    returnPct: numberValue(row.returnPct, 0),
    success: Boolean(row.success),
    reason: normalizeObservationReason(row.reason),
    horizonBars: numberValue(row.horizonBars, 0),
    meta: isRecord(row.meta) ? row.meta : undefined,
  }));
}

function normalizeObservationStats(raw: unknown): ObservationStat[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((row) => ({
    name: stringValue(row.name, 'observation'),
    side: normalizeSide(row.side),
    count: numberValue(row.count, 0),
    wins: numberValue(row.wins, 0),
    losses: numberValue(row.losses, 0),
    winRatePct: numberValue(row.winRatePct, 0),
    avgReturnPct: numberValue(row.avgReturnPct, 0),
    bestReturnPct: row.bestReturnPct === null || row.bestReturnPct === undefined ? null : numberValue(row.bestReturnPct, 0),
    worstReturnPct:
      row.worstReturnPct === null || row.worstReturnPct === undefined ? null : numberValue(row.worstReturnPct, 0),
    tpFirst: numberValue(row.tpFirst, 0),
    slFirst: numberValue(row.slFirst, 0),
    horizon: numberValue(row.horizon, 0),
  }));
}

function normalizePatterns(raw: Record<string, unknown>): PatternStat[] {
  const source = Array.isArray(raw.patterns) ? raw.patterns : Object.values(raw);
  return source
    .filter(isRecord)
    .filter((row) => 'trades' in row || 'pattern' in row)
    .map((row, idx) => {
      const pattern = stringValue(row.pattern, `pattern_${idx + 1}`);
      const trades = numberValue(row.trades, 0);
      const winRatePct = numberValue(row.win_rate ?? row.winRate ?? row.winRatePct, 0);
      const profitFactorRaw = row.profit_factor ?? row.profitFactor;
      return {
        pattern,
        trades,
        winRatePct,
        profitFactor: profitFactorRaw === undefined ? null : numberValue(profitFactorRaw, 0),
        totalReturnPct: numberValue(row.total_pnl ?? row.totalPnl ?? row.totalReturnPct, 0),
        maxDrawdownPct:
          row.max_drawdown === undefined && row.maxDrawdown === undefined && row.maxDrawdownPct === undefined
            ? null
            : numberValue(row.max_drawdown ?? row.maxDrawdown ?? row.maxDrawdownPct, 0),
      };
    });
}

function calcSharpe(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  return round2(mean / sd);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSide(value: unknown): 'long' | 'short' {
  return value === 'short' || value === 'sell' || value === 'bearish' ? 'short' : 'long';
}

function normalizeObservationReason(value: unknown): ObservationEvent['reason'] {
  return value === 'tp' || value === 'sl' || value === 'end_of_data' ? value : 'horizon';
}

function normalizeTradeReason(value: unknown): BacktestTrade['reason'] {
  if (value === 'tp' || value === 'sl' || value === 'signal' || value === 'timeout' || value === 'end_of_test') {
    return value;
  }
  return 'timeout';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeSummary(raw: Record<string, unknown>, initialCapital: number): BacktestSummary {
  const finalCapital = numberValue(raw.finalCapital ?? raw.final_capital, initialCapital);
  return {
    initialCapital: numberValue(raw.initialCapital ?? raw.initial_capital, initialCapital),
    finalCapital,
    totalReturnPct: numberValue(raw.totalReturnPct ?? raw.total_return_pct, 0),
    maxDrawdownPct: numberValue(raw.maxDrawdownPct ?? raw.max_drawdown_pct, 0),
    winRatePct: numberValue(raw.winRatePct ?? raw.win_rate_pct, 0),
    profitFactor:
      raw.profitFactor === null || raw.profit_factor === null
        ? null
        : numberValue(raw.profitFactor ?? raw.profit_factor, 0),
    sharpe: raw.sharpe === null || raw.sharpe === undefined ? null : numberValue(raw.sharpe, 0),
    totalTrades: numberValue(raw.totalTrades ?? raw.total_trades, 0),
    avgTradePct:
      raw.avgTradePct === null || raw.avg_trade_pct === null
        ? null
        : numberValue(raw.avgTradePct ?? raw.avg_trade_pct, 0),
    bestTradePct:
      raw.bestTradePct === null || raw.best_trade_pct === null
        ? null
        : numberValue(raw.bestTradePct ?? raw.best_trade_pct, 0),
    worstTradePct:
      raw.worstTradePct === null || raw.worst_trade_pct === null
        ? null
        : numberValue(raw.worstTradePct ?? raw.worst_trade_pct, 0),
  };
}

function normalizeEquity(
  raw: unknown,
  startTime: number,
  endTime: number,
  initialCapital: number,
  finalCapital: number
): EquityPoint[] {
  if (Array.isArray(raw)) {
    const points = raw
      .filter(isRecord)
      .map((point) => ({
        t: numberValue(point.t ?? point.time, 0),
        value: numberValue(point.value ?? point.equity, initialCapital),
      }))
      .filter((point) => point.t > 0);
    if (points.length) return points;
  }
  return [
    { t: startTime, value: initialCapital },
    { t: endTime, value: finalCapital },
  ];
}

function createRunId(): string {
  return `bt_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
