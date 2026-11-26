/**
 * Bot listesi.
 *
 * Her satırda: durum badge, isim, sembol/interval, mod, kompakt aksiyonlar.
 * Tıklanınca detaya geçer.
 */

import { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Plus, Loader2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { paperPortfoliosApi } from '@/api/endpoints';
import { useAppStore, type Interval } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { StatusBadge } from './StatusBadge';
import { useBots } from '@/hooks/useBots';
import type { BotConfig, PaperPortfolioReport } from '@/types/api';

interface BotListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export function BotList({ selectedId, onSelect, onCreate }: BotListProps): JSX.Element {
  const { data: bots, isLoading, isError } = useBots();
  const paperPortfolios = useQuery({
    queryKey: ['paper-portfolios'],
    queryFn: () => paperPortfoliosApi.list(),
    refetchInterval: 15_000,
  });

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <span className="text-2xs uppercase tracking-wider text-muted">
          Botlar {bots ? `(${bots.length})` : ''}
        </span>
        <Button size="sm" variant="primary" onClick={onCreate}>
          <Plus size={13} />
          Yeni
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {paperPortfolios.data?.map((report) => (
          <PaperPortfolioRow key={report.sourceFile} report={report} />
        ))}

        {isLoading && (
          <div className="p-6 text-center text-muted text-sm flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            Yükleniyor...
          </div>
        )}

        {isError && (
          <div className="p-6 text-center text-bear text-sm">
            Botlar yüklenemedi
          </div>
        )}

        {bots && bots.length === 0 && (
          <div className="p-6 text-center text-muted text-sm">
            <div className="text-text font-medium mb-1">Henüz bot yok</div>
            <div className="text-xs">"Yeni" ile bir bot oluşturarak başla</div>
          </div>
        )}

        {bots?.map((bot) => (
          <BotRow
            key={bot.id}
            bot={bot}
            selected={bot.id === selectedId}
            onClick={() => onSelect(bot.id)}
          />
        ))}
      </div>
    </div>
  );
}

function PaperPortfolioRow({ report }: { report: PaperPortfolioReport }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const setSymbol = useAppStore((state) => state.setSymbol);
  const setInterval = useAppStore((state) => state.setInterval);
  const setDrawingMode = useAppStore((state) => state.setDrawingMode);
  const setSelectedPaperPosition = useAppStore((state) => state.setSelectedPaperPosition);
  const runtimeStatus = report.runtimeStatus ?? report.status;
  const updating = report.status === 'running' || report.status === 'closing';
  const stale = runtimeStatus === 'stale' || report.runtimeStale === true || (updating && paperReportIsStale(report));
  const active = report.status === 'running' && !stale;
  const badge = paperStatusBadge(report, stale);
  const metrics = report.metrics;
  const duration = Math.max(report.elapsedDays + report.remainingDays, 0.0001);
  const progress = Math.max(0, Math.min(100, report.elapsedDays / duration * 100));
  const strategyName = report.config.botName
    ?? report.config.strategyFile?.replace(/\.py$/i, '').replaceAll('_', ' ')
    ?? 'Paper portfoy';
  const selectPosition = (positionId: string, symbol: string): void => {
    setSymbol(symbol);
    setInterval((report.config.interval ?? '1h') as Interval);
    setDrawingMode('all');
    setSelectedPaperPosition({ sourceFile: report.sourceFile, positionId });
  };

  const toggleDetails = (): void => {
    setExpanded((value) => !value);
    const firstOpen = report.openPositions[0];
    if (firstOpen) selectPosition(firstOpen.id, firstOpen.symbol);
  };

  return (
    <div className="border-b border-border/60 bg-surface/40 px-3 py-3">
      <button
        type="button"
        data-testid={`paper-portfolio-${report.sourceFile}`}
        onClick={toggleDetails}
        className="flex w-full items-start justify-between gap-2 text-left"
        title={expanded ? 'Ayrintilari gizle' : 'Ayrintilari goster'}
      >
        <div className="flex min-w-0 items-start gap-2">
          <Activity size={15} className={active ? 'mt-0.5 text-bull' : stale ? 'mt-0.5 text-amber-400' : 'mt-0.5 text-muted'} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium capitalize text-text">{strategyName}</div>
            <div className="mt-0.5 text-2xs text-muted">
              {report.symbols.length} sembol · {report.config.interval ?? '1h'} · paper portfoy
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      <div className="mt-3 grid grid-cols-4 gap-2">
        <PaperMetric label="Getiri" value={formatSignedPct(metrics.markReturnPct)} />
        <PaperMetric
          label="Gunluk"
          value={report.elapsedDays >= 1 ? formatSignedPct(metrics.markCompoundDailyReturnPct) : '-'}
        />
        <PaperMetric label="Acik" value={String(metrics.openPositions)} />
        <PaperMetric label="Maks DD" value={`${metrics.markMaxDrawdownPct.toFixed(2)}%`} />
      </div>

      <div className="mt-3 h-1 overflow-hidden rounded bg-border/70">
        <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-2xs text-muted">
        <span>{report.elapsedDays.toFixed(2)} gun</span>
        <span>{paperRemainingLabel(report)}</span>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <PaperDetail label="Sermaye" value={`$${metrics.markEquity.toFixed(2)}`} />
            <PaperDetail label="Kapanan" value={String(metrics.closedTrades)} />
            <PaperDetail label="Win rate" value={metrics.winRatePct === null ? '-' : `%${metrics.winRatePct.toFixed(2)}`} />
            <PaperDetail label="Kaldirac" value={`${report.config.portfolioLeverage ?? 1}x`} />
          </div>

          <div className="mt-3 text-2xs uppercase text-muted">Acik pozisyonlar</div>
          {report.openPositions.length === 0 ? (
            <div className="mt-1 text-xs text-muted">Acik pozisyon yok.</div>
          ) : (
            <div className="mt-1 divide-y divide-border/50">
              {report.openPositions.map((position) => (
                <button
                  key={position.id}
                  type="button"
                  onClick={() => selectPosition(position.id, position.symbol)}
                  className="grid w-full grid-cols-[1fr_auto] gap-2 py-2 text-left text-xs hover:bg-surface-2"
                  title={`${position.symbol} grafigine git`}
                >
                  <div className="min-w-0">
                    <span className="font-mono text-text">{position.symbol}</span>
                    <span className={position.side === 'long' ? 'ml-2 text-bull' : 'ml-2 text-bear'}>
                      {position.side.toUpperCase()}
                    </span>
                  </div>
                  <span className="font-mono text-muted">Hedef %{position.targetPct.toFixed(2)}</span>
                </button>
              ))}
            </div>
          )}

          {report.controllable && <PaperPortfolioControls report={report} />}
        </div>
      )}
    </div>
  );
}

const EXTEND_DAYS = 30;

function PaperPortfolioControls({ report }: { report: PaperPortfolioReport }): JSX.Element | null {
  const qc = useQueryClient();
  const [confirmStop, setConfirmStop] = useState(false);
  const onSettled = (): Promise<void> => qc.invalidateQueries({ queryKey: ['paper-portfolios'] });
  const stop = useMutation({
    mutationFn: () => paperPortfoliosApi.stop(report.sourceFile),
    onSettled,
  });
  const extend = useMutation({
    mutationFn: () => paperPortfoliosApi.extend(report.sourceFile, EXTEND_DAYS),
    onSettled,
  });

  if (report.status === 'stopped') return null;

  const busy = Boolean(report.pendingAction) || stop.isPending || extend.isPending;
  const expired = report.status === 'closing' || report.status === 'completed';
  const openCount = report.openPositions.length;
  const error = stop.error?.message ?? extend.error?.message ?? report.actionError;

  const handleStop = (): void => {
    if (!confirmStop) {
      setConfirmStop(true);
      window.setTimeout(() => setConfirmStop(false), 5000);
      return;
    }
    setConfirmStop(false);
    stop.mutate();
  };

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={handleStop}
          data-testid={`paper-portfolio-stop-${report.sourceFile}`}
        >
          {confirmStop ? 'Emin misin? Tekrar tikla' : 'Durdur'}
        </Button>
        {expired && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => extend.mutate()}
            title={`Planlanan bitisi ${EXTEND_DAYS} gun ileri alir; portfoy yeniden yeni islem acar.`}
          >
            Sureyi {EXTEND_DAYS} gun uzat
          </Button>
        )}
      </div>
      {confirmStop && (
        <div className="mt-2 text-2xs text-muted">
          {openCount > 0
            ? `${openCount} acik pozisyon son fiyattan kapatilir. `
            : ''}
          Portfoy bir daha islem acmaz; geri alinamaz.
        </div>
      )}
      {error && <div className="mt-2 text-2xs text-bear">{error}</div>}
    </div>
  );
}

function paperStatusBadge(
  report: PaperPortfolioReport,
  stale: boolean
): { label: string; variant: 'bull' | 'warning' | 'muted' } {
  // Rozet buyuk harfle (tr) gosterilir; ASCII "i" orada "İ" olur, bu yuzden Turkce karakter.
  if (report.pendingAction === 'stop') return { label: 'Durduruluyor…', variant: 'warning' };
  if (report.pendingAction === 'extend') return { label: 'Uzatılıyor…', variant: 'warning' };
  if (report.status === 'stopped') return { label: 'Durduruldu', variant: 'muted' };
  if (stale) return { label: 'Güncel değil', variant: 'warning' };
  if (report.status === 'running') return { label: 'Çalışıyor', variant: 'bull' };
  if (report.status === 'closing') return { label: 'Kapanıyor', variant: 'muted' };
  return { label: 'Tamamlandı', variant: 'muted' };
}

function paperRemainingLabel(report: PaperPortfolioReport): string {
  if (report.status === 'stopped') return 'Durduruldu';
  if (report.status === 'closing') return 'Sure doldu · yeni islem yok';
  if (report.status === 'completed') return 'Tamamlandi';
  return `${report.remainingDays.toFixed(2)} gun kaldi`;
}

function PaperMetric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="truncate text-2xs text-muted">{label}</div>
      <div className="truncate font-mono text-xs text-text">{value}</div>
    </div>
  );
}

function PaperDetail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="truncate font-mono text-text">{value}</span>
    </div>
  );
}

function formatSignedPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function paperReportIsStale(report: PaperPortfolioReport): boolean {
  const generatedAt = Number(report.generatedAt);
  if (!Number.isFinite(generatedAt)) return true;
  const intervalMs = intervalToMs(report.config.interval ?? '1h');
  return Date.now() - generatedAt > intervalMs * 2.5;
}

function intervalToMs(interval: string): number {
  const match = interval.match(/^(\d+)([mhd])$/i);
  if (!match) return 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function BotRow({
  bot,
  selected,
  onClick,
}: {
  bot: BotConfig;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`
        w-full text-left p-3 border-b border-border/50 transition-colors
        ${selected ? 'bg-accent/10' : 'hover:bg-surface-2'}
      `}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="text-sm font-medium text-text truncate">{bot.name}</span>
        <StatusBadge status={bot.status} />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-mono">{bot.symbol}</span>
        <span>·</span>
        <span>{bot.interval}</span>
        <span>·</span>
        <Badge variant={bot.mode === 'live' ? 'warning' : 'muted'}>{bot.mode}</Badge>
      </div>
    </button>
  );
}
