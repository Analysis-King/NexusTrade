/**
 * Bot listesi.
 *
 * Her satırda: durum badge, isim, sembol/interval, mod, kompakt aksiyonlar.
 * Tıklanınca detaya geçer.
 */

import { useState } from 'react';
import { Plus, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { StatusBadge } from './StatusBadge';
import { useBots, useDeployProfileGate, useProfileGate } from '@/hooks/useBots';
import type { BotConfig } from '@/types/api';

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
