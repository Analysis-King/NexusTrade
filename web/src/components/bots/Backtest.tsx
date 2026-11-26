import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { backtestsApi, type BacktestRun } from '@/api/endpoints';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { BotConfig } from '@/types/api';

const DAY_OPTIONS = [
  { value: 7, label: '7 gun' },
  { value: 30, label: '30 gun' },
  { value: 90, label: '90 gun' },
  { value: 180, label: '180 gun' },
  { value: 365, label: '1 yil' },
];

export function Backtest({ bot }: { bot: BotConfig }): JSX.Element {
  const [days, setDays] = useState(90);
  const [reportPeriodDays, setReportPeriodDays] = useState('1');
  const [feeBps, setFeeBps] = useState('10');
  const [slippageBps, setSlippageBps] = useState('2');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestRun | null>(null);
  const [activeBacktestId, setActiveBacktestId] = useState<string | null>(null);
  const [progressRun, setProgressRun] = useState<BacktestRun | null>(null);
  const [requestStartedAt, setRequestStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeBacktest = useQuery({
    queryKey: ['backtests', activeBacktestId],
    queryFn: () => backtestsApi.get(activeBacktestId!),
    enabled: Boolean(activeBacktestId),
    refetchInterval: activeBacktestId ? 1000 : false,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const run = activeBacktest.data;
    if (!run) return;

    setProgressRun(run);
    if (run.status === 'completed') {
      setResult(run);
      setRunning(false);
      setActiveBacktestId(null);
      setRequestStartedAt(null);
    } else if (run.status === 'failed') {
      setResult(run);
      setError(run.error ?? 'Backtest basarisiz.');
      setRunning(false);
      setActiveBacktestId(null);
      setRequestStartedAt(null);
    }
  }, [activeBacktest.data]);

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    setResult(null);
    setProgressRun(null);
    setActiveBacktestId(null);
    setRequestStartedAt(Date.now());

    try {
      const data = await backtestsApi.create({
        async: true,
        strategyFile: bot.strategyId,
        symbol: bot.symbol,
        interval: bot.interval,
        days,
        initialCapital: bot.capitalUsd,
        feeBps: Number(feeBps),
        slippageBps: Number(slippageBps),
        fillModel: 'pessimistic_ohlc',
        params: {
          ...bot.strategyParams,
          stop_loss_pct: bot.risk.maxLossPct,
          take_profit_pct: bot.risk.takeProfitPct,
          stop_loss_mode: bot.risk.stopLossMode ?? 'target_ratio',
          stop_loss_target_ratio: bot.risk.stopLossTargetRatio ?? 0.2,
          max_position_usd: bot.risk.maxPositionUsd,
          report_period_days: Number(reportPeriodDays),
        },
      });
      setProgressRun(data);
      if (data.status === 'completed') {
        setResult(data);
        setRunning(false);
        setRequestStartedAt(null);
      } else if (data.status === 'failed') {
        setResult(data);
        setError(data.error ?? 'Backtest basarisiz.');
        setRunning(false);
        setRequestStartedAt(null);
      } else {
        setActiveBacktestId(data.id);
      }
    } catch (err) {
      setError((err as Error).message);
      setRunning(false);
      setRequestStartedAt(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <div className="text-2xs uppercase tracking-wider text-muted mb-1">Sure</div>
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="block">
          <div className="text-2xs uppercase tracking-wider text-muted mb-1">Rapor (gun)</div>
          <Input
            type="number"
            value={reportPeriodDays}
            onChange={(e) => setReportPeriodDays(e.target.value)}
            min="0.25"
            step="0.25"
          />
        </label>

        <label className="block">
          <div className="text-2xs uppercase tracking-wider text-muted mb-1">Komisyon (bps)</div>
          <Input
            type="number"
            value={feeBps}
            onChange={(e) => setFeeBps(e.target.value)}
            min="0"
            max="100"
            step="0.1"
          />
        </label>

        <label className="block">
          <div className="text-2xs uppercase tracking-wider text-muted mb-1">Slippage (bps)</div>
          <Input
            type="number"
            value={slippageBps}
            onChange={(e) => setSlippageBps(e.target.value)}
            min="0"
            max="500"
            step="0.1"
          />
        </label>
      </div>

      <Button onClick={run} disabled={running} variant="primary" className="w-full">
        {running ? (
          <>
            <Loader2 size={13} className="animate-spin" />
            Calisiyor...
          </>
        ) : (
          'Calistir'
        )}
      </Button>

      {error && (
        <div className="rounded bg-bear/10 border border-bear/30 px-2 py-1.5 text-xs text-bear">
          {error}
        </div>
      )}

      {running && <BacktestProgress result={progressRun} requestStartedAt={requestStartedAt} />}

      {result && <BacktestResult result={result} />}

      <p className="text-2xs text-muted">
        {bot.symbol} - {bot.interval} - son {days} gun - {bot.strategyId}
      </p>
    </div>
  );
}

function BacktestProgress({
  result,
  requestStartedAt,
}: {
  result: BacktestRun | null;
  requestStartedAt: number | null;
}): JSX.Element {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const progress = result?.progress;
  const startedAt = progress?.startedAt ?? requestStartedAt ?? now;
  const elapsedMs = Math.max(0, now - startedAt);
  const pct = progress ? clampProgress(progress.pct) : estimateStartingProgress(elapsedMs);
  const remainingMs = progress && pct > 5 && pct < 100 ? (elapsedMs * (100 - pct)) / pct : null;
  const candleCount = progress?.candlesFetched ?? progress?.candleCount;

  return (
    <div className="rounded border border-accent/30 bg-accent/10 p-2 text-xs">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-text">{progress?.message ?? formatStartingBacktestMessage(elapsedMs)}</div>
          <div className="text-2xs uppercase tracking-wider text-muted">{formatBacktestStage(progress?.stage)}</div>
        </div>
        <div className="font-mono text-accent">{pct}%</div>
      </div>
      <div className="h-2 overflow-hidden rounded bg-bg/70">
        <div className="h-full rounded bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-2xs">
        <Metric label="Gecen" value={formatDurationShort(elapsedMs)} />
        <Metric label="Kalan" value={remainingMs === null ? 'bekleniyor' : formatDurationShort(remainingMs)} />
        <Metric label="Mum" value={candleCount === undefined ? '-' : formatInteger(candleCount)} />
      </div>
    </div>
  );
}

function BacktestResult({ result }: { result: BacktestRun }): JSX.Element {
  const summary = result.summary;
  const topPatterns = (result.patterns ?? [])
    .filter((pattern) => pattern.trades > 0)
    .sort((a, b) => b.totalReturnPct - a.totalReturnPct)
    .slice(0, 3);
  const observationRows = (result.observationStats ?? [])
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || b.winRatePct - a.winRatePct);
  const recentReports = (result.periodReports ?? []).slice(-3);
  const recentTrades = (result.trades ?? []).slice(-3);

  return (
    <div className="rounded border border-border bg-surface-2/60 p-2 text-xs">
      {result.status === 'failed' ? (
        <div className="text-bear">{result.error ?? 'Backtest basarisiz.'}</div>
      ) : !summary ? (
        <div className="text-muted">Sonuc bos. Strateji backtest desteklemeyebilir.</div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <Metric
              label="Getiri"
              value={formatPct(summary.totalReturnPct)}
              tone={summary.totalReturnPct >= 0 ? 'bull' : 'bear'}
            />
            <Metric label="Islem" value={String(summary.totalTrades)} />
            <Metric label="Win rate" value={`${formatNumber(summary.winRatePct)}%`} />
            <Metric label="Max DD" value={`${formatNumber(summary.maxDrawdownPct)}%`} />
            <Metric label="PF" value={summary.profitFactor === null ? '-' : formatNumber(summary.profitFactor)} />
            <Metric label="Mum" value={String(result.candleCount)} />
          </div>

          {topPatterns.length > 0 && (
            <div className="border-t border-border pt-2 space-y-1">
              {topPatterns.map((pattern) => (
                <div key={pattern.pattern} className="flex items-center justify-between gap-2">
                  <span className="text-muted truncate">{pattern.pattern}</span>
                  <span className="font-mono tabular-nums text-text">
                    {pattern.trades} islem - {formatPct(pattern.totalReturnPct)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {observationRows.length > 0 && (
            <div className="border-t border-border pt-2">
              <div className="mb-1 text-2xs uppercase tracking-wider text-muted">Formasyon analizi</div>
              <div className="overflow-hidden rounded border border-border">
                <div className="grid grid-cols-[1fr_38px_40px_48px_50px_50px_50px] gap-1 border-b border-border px-2 py-1 text-2xs uppercase tracking-wider text-muted">
                  <span>Ad</span>
                  <span className="text-right">Yon</span>
                  <span className="text-right">Adet</span>
                  <span className="text-right">Win</span>
                  <span className="text-right">Ort</span>
                  <span className="text-right">Kotu</span>
                  <span className="text-right">En iyi</span>
                </div>
                {observationRows.map((item) => (
                  <div
                    key={`${item.name}-${item.side}`}
                    className="grid grid-cols-[1fr_38px_40px_48px_50px_50px_50px] gap-1 border-b border-border/50 px-2 py-1 text-2xs last:border-0"
                  >
                    <span className="truncate text-text">{item.name}</span>
                    <span className="text-right font-mono text-muted">{item.side}</span>
                    <span className="text-right font-mono text-text">{item.count}</span>
                    <span className="text-right font-mono text-text">{formatNumber(item.winRatePct)}%</span>
                    <span className={`text-right font-mono ${safeNumber(item.avgReturnPct) >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {formatPct(item.avgReturnPct)}
                    </span>
                    <span className={`text-right font-mono ${safeNumber(item.worstReturnPct) >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {formatPct(item.worstReturnPct)}
                    </span>
                    <span className={`text-right font-mono ${safeNumber(item.bestReturnPct) >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {formatPct(item.bestReturnPct)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {recentReports.length > 0 && (
            <div className="border-t border-border pt-2 space-y-1">
              {recentReports.map((report) => (
                <div key={`${report.period}-${report.startTime}`} className="flex items-center justify-between gap-2">
                  <span className="text-muted truncate">Rapor {report.period}</span>
                  <span className={`font-mono tabular-nums ${safeNumber(report.returnPct) >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {formatPct(report.returnPct)} / R ${formatNumber(report.realizedPnl)} / {safeNumber(report.tpTrades)}/{safeNumber(report.slTrades)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {recentTrades.length > 0 && (
            <div className="border-t border-border pt-2 space-y-1">
              {recentTrades.map((trade) => (
                <div key={trade.id} className="flex items-center justify-between gap-2">
                  <span className="text-muted truncate">
                    {trade.side} {formatTradeReason(trade.reason)}
                  </span>
                  <span className={`font-mono tabular-nums ${safeNumber(trade.pnlPct) >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {formatPct(trade.pnlPct)} / ${formatNumber(trade.netPnl)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'bull' | 'bear';
}): JSX.Element {
  const color = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-text';

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted truncate">{label}</span>
      <span className={`font-mono tabular-nums truncate ${color}`}>{value}</span>
    </div>
  );
}

function safeNumber(value: number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function estimateStartingProgress(elapsedMs: number): number {
  return Math.min(18, 3 + Math.floor(elapsedMs / 1000) * 2);
}

function formatStartingBacktestMessage(elapsedMs: number): string {
  if (elapsedMs < 1500) return 'Backtest istegi sunucuya gonderiliyor...';
  if (elapsedMs < 8000) return 'Sunucudan is kimligi bekleniyor...';
  return 'Sunucu cevap bekleniyor. Backend yeniden baslatilmadiysa eski akista olabilir.';
}

function formatInteger(value: number | null | undefined): string {
  return Math.round(safeNumber(value)).toLocaleString('tr-TR');
}

function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds < 1) return '<1 sn';
  if (totalSeconds < 60) return `${totalSeconds} sn`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes} dk ${seconds} sn` : `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} sa ${restMinutes} dk` : `${hours} sa`;
}

function formatBacktestStage(stage: string | undefined): string {
  if (stage === 'queued') return 'Sirada';
  if (stage === 'fetching_data') return 'Veri cekiliyor';
  if (stage === 'loading_worker') return 'Motor hazirlaniyor';
  if (stage === 'running_strategy') return 'Strateji calisiyor';
  if (stage === 'finalizing') return 'Rapor hazirlaniyor';
  if (stage === 'completed') return 'Tamamlandi';
  if (stage === 'failed') return 'Hata';
  return 'Baslatiliyor';
}

function formatNumber(value: number | null | undefined): string {
  const n = safeNumber(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function formatPct(value: number | null | undefined): string {
  const n = safeNumber(value);
  return `${n >= 0 ? '+' : ''}${formatNumber(n)}%`;
}

function formatTradeReason(value: string): string {
  if (value === 'tp') return 'TP';
  if (value === 'sl') return 'SL';
  if (value === 'signal') return 'SIGNAL';
  if (value === 'end_of_test') return 'END';
  return value.toUpperCase();
}
