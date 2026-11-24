/**
 * Bot listesi.
 *
 * Her satırda: durum badge, isim, sembol/interval, mod, kompakt aksiyonlar.
 * Tıklanınca detaya geçer.
 */

import { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Plus, Loader2, ShieldCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { paperPortfoliosApi } from '@/api/endpoints';
import { useAppStore, type Interval } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { StatusBadge } from './StatusBadge';
import { useBots, useDeployProfileGate, useProfileGate } from '@/hooks/useBots';
import type { BotConfig, PaperPortfolioReport } from '@/types/api';

interface BotListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export function BotList({ selectedId, onSelect, onCreate }: BotListProps): JSX.Element {
  const { data: bots, isLoading, isError } = useBots();
  const profileGate = useProfileGate();
  const deployGate = useDeployProfileGate();
  const [capitalUsd, setCapitalUsd] = useState('1000');
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const paperPortfolios = useQuery({
    queryKey: ['paper-portfolios'],
    queryFn: () => paperPortfoliosApi.list(),
    refetchInterval: 15_000,
  });

  const deployProfileGate = async (): Promise<void> => {
    setGateMessage(null);
    try {
      const result = await deployGate.mutateAsync({
        capitalUsd: Number(capitalUsd) || 1000,
        mode: 'paper',
        prefix: 'Gate',
      });
      const created = result.created.length;
      const skipped = result.skipped.length;
      setGateMessage(`${created} bot kuruldu, ${skipped} bot zaten vardi.`);
      const first = result.created[0]?.bot ?? result.skipped[0]?.bot;
      if (first) onSelect(first.id);
    } catch (err) {
      setGateMessage((err as Error).message);
    }
  };

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

        {profileGate.data && (
          <div className="border-b border-border/60 p-3">
            <div className="rounded border border-accent/30 bg-accent/10 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-text">
                  <ShieldCheck size={14} className="text-accent" />
                  <span className="truncate">Profil kapisi</span>
                </div>
                <span className="font-mono text-xs text-accent">
                  {formatMaybePct(profileGate.data.allocation.expectedDailyPct)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-2xs">
                <GateMetric label="Plan" value={profileGate.data.allocation.plan} />
                <GateMetric
                  label="Kaldirac"
                  value={`${profileGate.data.allocation.leverage ?? 1}x`}
                />
              </div>

              <div className="mt-2 space-y-1">
                {profileGate.data.allocation.profiles.map((profile) => (
                  <div
                    key={`${profile.symbol}-${profile.interval}`}
                    className="grid grid-cols-[1fr_48px_58px] gap-2 text-2xs"
                  >
                    <span className="truncate font-mono text-text">
                      {profile.symbol} {profile.interval}
                    </span>
                    <span className="text-right font-mono text-muted">
                      %{profile.capital_weight_pct.toFixed(1)}
                    </span>
                    <span className="text-right font-mono text-accent">
                      {formatMaybePct(profile.latest_daily_pct)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <Input
                  value={capitalUsd}
                  onChange={(event) => setCapitalUsd(event.target.value)}
                  inputMode="decimal"
                  className="h-8 font-mono text-xs"
                  placeholder="1000"
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void deployProfileGate()}
                  disabled={deployGate.isPending}
                >
                  {deployGate.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  Kur
                </Button>
              </div>

              {gateMessage && (
                <div className="mt-2 rounded border border-border bg-surface/60 px-2 py-1.5 text-xs text-text">
                  {gateMessage}
                </div>
              )}
            </div>
          </div>
        )}

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
  const running = runtimeStatus === 'running';
  const stale = runtimeStatus === 'stale' || report.runtimeStale === true || (report.status === 'running' && paperReportIsStale(report));
  const active = running && !stale;
  const badgeLabel = stale ? 'Guncel degil' : running ? 'Calisiyor' : 'Tamamlandi';
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
          <Badge variant={active ? 'bull' : stale ? 'warning' : 'muted'}>{badgeLabel}</Badge>
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
        <span>{report.remainingDays.toFixed(2)} gun kaldi</span>
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
        </div>
      )}
    </div>
  );
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

function GateMetric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0 rounded border border-border/60 bg-surface/60 px-2 py-1.5">
      <div className="uppercase tracking-wider text-muted">{label}</div>
      <div className="truncate font-mono text-text">{value}</div>
    </div>
  );
}

function formatMaybePct(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `%${value.toFixed(3)}` : '-';
}
