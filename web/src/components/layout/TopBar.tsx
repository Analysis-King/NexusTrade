/**
 * Üst bar.
 *
 * Soldan sağa:
 *   - Logo / brand
 *   - Sembol arama düğmesi (BTCUSDT ▼)
 *   - Timeframe seçim grubu (1m, 5m, 15m, 1h, 4h, 1d)
 *   - Göstergeler düğmesi (placeholder — Hafta 5)
 *   ─── boşluk ───
 *   - Anlık fiyat + 24h % değişim
 *   - Sağ ikonlar: WS durumu, ayarlar
 */

import { useEffect, useState } from 'react';
import { Search, Activity, Settings, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { indicatorsApi, marketApi, type IndicatorMeta } from '@/api/endpoints';
import { ws } from '@/api/ws';
import { useAppStore } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { cn } from '@/lib/cn';
import { formatPrice, formatPct } from '@/lib/format';
import type { Interval } from '@/types/api';

const TIMEFRAMES: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function TopBar({ onOpenSymbolPicker }: { onOpenSymbolPicker: () => void }): JSX.Element {
  const symbol = useAppStore((s) => s.symbol);
  const interval = useAppStore((s) => s.interval);
  const setInterval = useAppStore((s) => s.setInterval);
  const activeIndicatorIds = useAppStore((s) => s.activeIndicatorIds);
  const toggleIndicator = useAppStore((s) => s.toggleIndicator);

  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  useEffect(() => ws.onStatus(setWsStatus), []);

  // Ticker — REST polling. Canlı fiyat aslında stream'den gelir, ama 24h % için polling şart.
  const ticker = useQuery({
    queryKey: ['ticker', symbol],
    queryFn: () => marketApi.ticker(symbol),
    refetchInterval: 5_000,
  });

  const lastPrice = ticker.data ? Number(ticker.data.lastPrice) : null;
  const changePct = ticker.data ? Number(ticker.data.priceChangePercent) : null;
  const isUp = (changePct ?? 0) >= 0;

  return (
    <div className="flex items-center w-full h-full px-2 gap-2">
      {/* Brand */}
      <div className="text-sm font-semibold tracking-tight text-text px-2 select-none">
        NexusTrade
      </div>

      <div className="w-px h-6 bg-border" />

      {/* Sembol seçici */}
      <button
        onClick={onOpenSymbolPicker}
        className={cn(
          'flex items-center gap-2 px-3 h-8 rounded',
          'bg-surface-2 hover:bg-border transition-colors',
          'border border-border'
        )}
      >
        <Search size={13} className="text-muted" />
        <span className="font-medium text-sm">{symbol}</span>
        <ChevronDown size={13} className="text-muted" />
      </button>

      {/* Timeframe seçici */}
      <div className="flex items-center bg-surface-2 rounded border border-border h-8 overflow-hidden">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => setInterval(tf)}
            className={cn(
              'px-2.5 h-full text-xs font-medium transition-colors',
              interval === tf ? 'bg-accent text-white' : 'text-muted hover:text-text hover:bg-border'
            )}
          >
            {tf}
          </button>
        ))}
      </div>

      {/* Göstergeler placeholder */}
      <Button
        variant={activeIndicatorIds.length ? 'default' : 'ghost'}
        size="sm"
        title="Gostergeler"
        onClick={() => setIndicatorsOpen(true)}
      >
        <SlidersHorizontal size={13} />
        Gostergeler
        {activeIndicatorIds.length > 0 && (
          <span className="rounded bg-accent/20 px-1.5 py-0.5 font-mono text-2xs text-accent">
            {activeIndicatorIds.length}
          </span>
        )}
      </Button>

      {/* Boşluk */}
      <div className="flex-1" />

      {/* Fiyat + değişim */}
      <div className="flex items-center gap-3 px-3 font-mono">
        {lastPrice !== null && (
          <>
            <span className="text-base font-semibold tabular-nums">
              ${formatPrice(lastPrice)}
            </span>
            <span
              className={cn(
                'text-xs font-medium tabular-nums',
                isUp ? 'text-bull' : 'text-bear'
              )}
            >
              {formatPct(changePct ?? 0)}
            </span>
          </>
        )}
      </div>

      <div className="w-px h-6 bg-border" />

      {/* Sağ ikonlar */}
      <div
        className="flex items-center gap-1.5 px-2 text-2xs uppercase tracking-wider"
        title={wsStatus === 'connected' ? 'WebSocket bağlı' : 'WebSocket kopuk'}
      >
        <Activity
          size={13}
          className={wsStatus === 'connected' ? 'text-bull' : 'text-bear'}
        />
        <span className={wsStatus === 'connected' ? 'text-bull' : 'text-bear'}>
          {wsStatus === 'connected' ? 'live' : 'offline'}
        </span>
      </div>

      <Button variant="ghost" size="icon" title="Ayarlar (yakında)" disabled>
        <Settings size={15} />
      </Button>

      <IndicatorsModal
        open={indicatorsOpen}
        onClose={() => setIndicatorsOpen(false)}
        activeIds={activeIndicatorIds}
        onToggle={toggleIndicator}
      />
    </div>
  );
}

function IndicatorsModal({
  open,
  onClose,
  activeIds,
  onToggle,
}: {
  open: boolean;
  onClose: () => void;
  activeIds: string[];
  onToggle: (id: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const indicators = useQuery({
    queryKey: ['indicators'],
    queryFn: () => indicatorsApi.list(),
    enabled: open,
    staleTime: 30_000,
  });

  const needle = query.trim().toLowerCase();
  const list = (indicators.data ?? []).filter((indicator) => {
    if (!needle) return true;
    return [indicator.name, indicator.desc, indicator.category, indicator.filename]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });

  return (
    <Modal open={open} onClose={onClose} title="Gostergeler" className="max-w-2xl">
      <div className="flex h-[520px] min-h-0 flex-col gap-3">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ara..."
            className="h-9 w-full rounded border border-border bg-surface pl-9 pr-3 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border">
          {indicators.isLoading ? (
            <div className="p-4 text-xs text-muted">Gostergeler yukleniyor...</div>
          ) : list.length ? (
            list.map((indicator) => (
              <IndicatorRow
                key={indicator.id}
                indicator={indicator}
                active={activeIds.includes(indicator.id)}
                onToggle={() => onToggle(indicator.id)}
              />
            ))
          ) : (
            <div className="p-4 text-xs text-muted">Eslesen gosterge yok.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function IndicatorRow({
  indicator,
  active,
  onToggle,
}: {
  indicator: IndicatorMeta;
  active: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={indicator.drawable ? onToggle : undefined}
      disabled={!indicator.drawable}
      className={cn(
        'flex w-full items-center justify-between gap-3 border-b border-border px-3 py-3 text-left last:border-0',
        indicator.drawable ? 'hover:bg-surface-2' : 'cursor-not-allowed opacity-45',
        active && 'bg-accent/10'
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text">{indicator.name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">{indicator.desc || indicator.filename}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="rounded border border-border px-2 py-1 text-2xs uppercase tracking-wider text-muted">
          {indicator.category}
        </span>
        <span
          className={cn(
            'h-4 w-8 rounded-full border transition-colors',
            active ? 'border-accent bg-accent' : 'border-border bg-surface'
          )}
        >
          <span
            className={cn(
              'block h-3.5 w-3.5 rounded-full bg-white transition-transform',
              active && 'translate-x-4'
            )}
          />
        </span>
      </span>
    </button>
  );
}
