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
import { Search, Activity, Settings, ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { marketApi } from '@/api/endpoints';
import { ws } from '@/api/ws';
import { useAppStore } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { formatPrice, formatPct } from '@/lib/format';
import type { Interval } from '@/types/api';

const TIMEFRAMES: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function TopBar({ onOpenSymbolPicker }: { onOpenSymbolPicker: () => void }): JSX.Element {
  const symbol = useAppStore((s) => s.symbol);
  const interval = useAppStore((s) => s.interval);
  const setInterval = useAppStore((s) => s.setInterval);

  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected'>('disconnected');
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
      <Button variant="ghost" size="sm" disabled title="Yakında">
        Göstergeler
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
    </div>
  );
}
