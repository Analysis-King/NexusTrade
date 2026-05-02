/**
 * Sembol seçici modal.
 *
 * Backend'den popüler 100 USDT paritesini çeker, arama ile filtreler.
 * TradingView'deki gibi "üstte arama, altta liste" mantığı.
 */

import { useDeferredValue, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { marketApi } from '@/api/endpoints';
import { useAppStore } from '@/store/app';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

export function SymbolPicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const setSymbol = useAppStore((s) => s.setSymbol);
  const currentSymbol = useAppStore((s) => s.symbol);

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const { data: symbols = [], isLoading } = useQuery({
    queryKey: ['symbols'],
    queryFn: () => marketApi.symbols(),
    staleTime: 60_000,
    enabled: open,
  });

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toUpperCase();
    if (!q) return symbols;
    return symbols.filter((s) => s.includes(q));
  }, [symbols, deferredQuery]);

  const select = (s: string): void => {
    setSymbol(s);
    setQuery('');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Sembol Seç">
      <div className="space-y-3">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          />
          <Input
            autoFocus
            placeholder="Ara: BTC, ETH, SOL..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="h-80 overflow-y-auto border border-border rounded bg-surface-2/40">
          {isLoading && (
            <div className="p-4 text-sm text-muted text-center">Yükleniyor...</div>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="p-4 text-sm text-muted text-center">Sonuç yok</div>
          )}
          {filtered.map((s) => (
            <button
              key={s}
              onClick={() => select(s)}
              className={cn(
                'w-full text-left px-3 py-2 text-sm font-mono transition-colors',
                'hover:bg-surface-2 border-b border-border/50 last:border-0',
                currentSymbol === s && 'bg-accent/10 text-accent'
              )}
            >
              {s}
            </button>
          ))}
        </div>

        <p className="text-xs text-muted">
          {symbols.length} popüler USDT paritesi
        </p>
      </div>
    </Modal>
  );
}
