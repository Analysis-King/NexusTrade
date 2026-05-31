import type { Interval } from './domain.js';

export type BacktestStatus = 'queued' | 'running' | 'completed' | 'failed';
export type BacktestFillModel = 'close_next_open' | 'pessimistic_ohlc';
export type BacktestProgressStage =
  | 'queued'
  | 'fetching_data'
  | 'loading_worker'
  | 'running_strategy'
  | 'finalizing'
  | 'completed'
  | 'failed';

export interface BacktestProgress {
  stage: BacktestProgressStage;
  pct: number;
  message: string;
  startedAt: number;
  updatedAt: number;
  candlesFetched?: number;
  estimatedCandles?: number;
  candleCount?: number;
}

export interface BacktestAssumptions {
  feeBps: number;
  slippageBps: number;
  fillModel: BacktestFillModel;
  sameCandleTpSl: 'stop_first' | 'take_profit_first';
}

export interface BacktestSummary {
  initialCapital: number;
  finalCapital: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number | null;
  sharpe: number | null;
  totalTrades: number;
  avgTradePct: number | null;
  bestTradePct: number | null;
  worstTradePct: number | null;
}

export interface BacktestTrade {
  id: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  slPrice?: number | null;
  tpPrice?: number | null;
  exitTime: number;
  exitPrice: number;
  qty: number;
  notional?: number;
  grossPnl: number;
  netPnl: number;
  pnlPct: number;
  accountReturnPct?: number;
  feePaid: number;
  reason: 'tp' | 'sl' | 'signal' | 'timeout' | 'end_of_test';
  meta?: Record<string, unknown>;
}

export interface EquityPoint {
  t: number;
  value: number;
}

export interface PatternStat {
  pattern: string;
  trades: number;
  winRatePct: number;
  profitFactor: number | null;
  totalReturnPct: number;
  maxDrawdownPct: number | null;
}

export interface ObservationEvent {
  id: string;
  name: string;
  side: 'long' | 'short';
  signalTime: number;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  returnPct: number;
  success: boolean;
  reason: 'tp' | 'sl' | 'horizon' | 'end_of_data';
  horizonBars: number;
  meta?: Record<string, unknown>;
}

export interface ObservationStat {
  name: string;
  side: 'long' | 'short';
  count: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgReturnPct: number;
  bestReturnPct: number | null;
  worstReturnPct: number | null;
  tpFirst: number;
  slFirst: number;
  horizon: number;
}

export interface PeriodReport {
  period: number;
  startTime: number;
  endTime: number;
  startEquity: number;
  endEquity: number;
  pnl: number;
  returnPct: number;
  realizedPnl: number;
  realizedReturnPct: number;
  openPnl: number;
  openReturnPct: number;
  feePaid: number;
  trades: number;
  tpTrades: number;
  slTrades: number;
  signalTrades: number;
  endTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

export interface BacktestRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: BacktestStatus;
  strategyFile: string;
  strategyHash: string;
  symbol: string;
  interval: Interval;
  startTime: number;
  endTime: number;
  candleCount: number;
  initialCapital: number;
  params: Record<string, unknown>;
  assumptions: BacktestAssumptions;
  progress?: BacktestProgress;
  summary?: BacktestSummary;
  trades?: BacktestTrade[];
  equity?: EquityPoint[];
  patterns?: PatternStat[];
  observations?: ObservationEvent[];
  observationStats?: ObservationStat[];
  periodReports?: PeriodReport[];
  raw?: Record<string, unknown>;
  error?: string;
}

export interface CreateBacktestInput {
  strategyFile: string;
  code?: string;
  symbol: string;
  interval: Interval;
  startTime?: number;
  endTime?: number;
  days?: number;
  initialCapital: number;
  feeBps: number;
  slippageBps: number;
  fillModel: BacktestFillModel;
  params: Record<string, unknown>;
}
