/**
 * Bot listesi.
 *
 * Her satırda: durum badge, isim, sembol/interval, mod, kompakt aksiyonlar.
 * Tıklanınca detaya geçer.
 */

import { Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { StatusBadge } from './StatusBadge';
import { useBots } from '@/hooks/useBots';
import type { BotConfig } from '@/types/api';

interface BotListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export function BotList({ selectedId, onSelect, onCreate }: BotListProps): JSX.Element {
  const { data: bots, isLoading, isError } = useBots();

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
