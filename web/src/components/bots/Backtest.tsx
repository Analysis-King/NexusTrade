/**
 * Backtest paneli — bot detay içinde collapsible.
 *
 * Şu an /api/dev/pool/backtest endpoint'ini kullanıyor (Hafta 4'te kalıcı).
 * Botun stratejisini ve sembolünü kullanır, kullanıcı sadece "kaç gün" seçer.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { devApi } from '@/api/endpoints';
import type { BotConfig, Interval } from '@/types/api';

const DAY_OPTIONS = [
  { value: 1,  label: '1 gün'   },
  { value: 3,  label: '3 gün'   },
  { value: 7,  label: '7 gün'   },
  { value: 14, label: '14 gün'  },
  { value: 30, label: '30 gün'  },
];

export function Backtest({ bot }: { bot: BotConfig }): JSX.Element {
  const [days, setDays] = useState(7);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      // Worker pool botunu zaten yüklemiş olmalı. Ama emin olmak için yükleyelim.
      try {
        await devApi.poolLoad(bot.id, bot.strategyId);
      } catch {
        // Zaten yüklü olabilir, sorun değil
      }

      const r = await devApi.backtest({
        instance: bot.id,
        symbol: bot.symbol,
        interval: bot.interval as Interval,
        days,
      });
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
        <label className="block">
          <div className="text-2xs uppercase tracking-wider text-muted mb-1">Süre</div>
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        <Button onClick={run} disabled={running} variant="primary">
          {running ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              Çalışıyor...
            </>
          ) : (
            'Çalıştır'
          )}
        </Button>
      </div>

      {error && (
        <div className="rounded bg-bear/10 border border-bear/30 px-2 py-1.5 text-xs text-bear">
          {error}
        </div>
      )}

      {result && <BacktestResult result={result} />}

      <p className="text-2xs text-muted">
        {bot.symbol} · {bot.interval} · son {days} gün · {bot.strategyId}
      </p>
    </div>
  );
}

function BacktestResult({ result }: { result: Record<string, unknown> }): JSX.Element {
  // Backend strateji-bağımlı response veriyor, esnek render
  const pretty = (value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return String(value);
      return value.toFixed(2);
    }
    if (typeof value === 'string' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value).slice(0, 120);
  };

  // Anahtarları tablo halinde göster
  const entries = Object.entries(result).filter(
    ([key]) => !['drawings', 'trades_detail', 'positions_detail'].includes(key)
  );

  return (
    <div className="rounded border border-border bg-surface-2/60 p-2 text-xs">
      {entries.length === 0 ? (
        <div className="text-muted">Sonuç boş — strateji backtest desteklemeyebilir.</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2 truncate">
              <span className="text-muted truncate">{k}</span>
              <span className="text-text font-mono tabular-nums truncate">{pretty(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
