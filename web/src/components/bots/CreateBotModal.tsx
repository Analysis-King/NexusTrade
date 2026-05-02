/**
 * Yeni bot oluşturma modalı.
 *
 * Mod seçimi paper'a sabit (live için Hafta 3 — API key encryption şart).
 * Strateji listesi backend'den (.py dosyaları). Sembol şu an aktif sembol default.
 */

import { useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { useStrategies } from '@/hooks/useStrategies';
import { useCreateBot } from '@/hooks/useBots';
import { useAppStore } from '@/store/app';
import type { Interval } from '@/types/api';

const INTERVALS: Interval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

export function CreateBotModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const symbol = useAppStore((s) => s.symbol);

  const [name, setName] = useState('');
  const [sym, setSym] = useState(symbol);
  const [interval, setInterval] = useState<Interval>('15m');
  const [strategyId, setStrategyId] = useState('');
  const [capital, setCapital] = useState('1000');
  const [maxPosition, setMaxPosition] = useState('100');
  const [maxLossPct, setMaxLossPct] = useState('2');
  const [tpPct, setTpPct] = useState('4');
  const [dailyLossLimit, setDailyLossLimit] = useState('50');
  const [error, setError] = useState<string | null>(null);

  const strategies = useStrategies();
  const createBot = useCreateBot();

  // Default strateji set
  if (!strategyId && strategies.data && strategies.data.length > 0) {
    setStrategyId(strategies.data[0]!.filename);
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      const bot = await createBot.mutateAsync({
        name: name.trim(),
        symbol: sym.trim().toUpperCase(),
        interval,
        mode: 'paper', // Hafta 3'te live açılacak
        strategyId,
        capitalUsd: Number(capital),
        risk: {
          maxLossPct: Number(maxLossPct),
          takeProfitPct: Number(tpPct),
          maxPositionUsd: Number(maxPosition),
          dailyMaxLossUsd: Number(dailyLossLimit),
        },
      });
      // Reset
      setName('');
      onCreated(bot.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Yeni Bot">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Bot Adı">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn: BTC RSI Bot"
            required
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Sembol">
            <Input
              value={sym}
              onChange={(e) => setSym(e.target.value.toUpperCase())}
              placeholder="BTCUSDT"
              required
            />
          </Field>

          <Field label="Zaman Dilimi">
            <Select
              value={interval}
              onChange={(e) => setInterval(e.target.value as Interval)}
            >
              {INTERVALS.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Strateji">
          {strategies.isLoading ? (
            <div className="text-sm text-muted py-2">Stratejiler yükleniyor...</div>
          ) : !strategies.data || strategies.data.length === 0 ? (
            <div className="text-sm text-bear py-2">
              Strateji bulunamadı. python/strategies/ klasörüne .py dosyası ekle.
            </div>
          ) : (
            <Select
              value={strategyId}
              onChange={(e) => setStrategyId(e.target.value)}
              required
            >
              {strategies.data.map((s) => (
                <option key={s.filename} value={s.filename}>
                  {s.name !== 'İsimsiz' ? `${s.name} (${s.filename})` : s.filename}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="border-t border-border pt-3">
          <div className="text-2xs uppercase tracking-wider text-muted mb-2">
            Sermaye & Risk
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Sermaye (USDT)">
              <Input
                type="number"
                value={capital}
                onChange={(e) => setCapital(e.target.value)}
                min="10"
                step="10"
                required
              />
            </Field>

            <Field label="Maks. Pozisyon (USDT)">
              <Input
                type="number"
                value={maxPosition}
                onChange={(e) => setMaxPosition(e.target.value)}
                min="10"
                step="10"
                required
              />
            </Field>

            <Field label="Stop Loss (%)">
              <Input
                type="number"
                value={maxLossPct}
                onChange={(e) => setMaxLossPct(e.target.value)}
                min="0.1"
                step="0.1"
                required
              />
            </Field>

            <Field label="Take Profit (%)">
              <Input
                type="number"
                value={tpPct}
                onChange={(e) => setTpPct(e.target.value)}
                min="0.1"
                step="0.1"
                required
              />
            </Field>

            <Field label="Günlük Maks. Zarar (USDT)" className="col-span-2">
              <Input
                type="number"
                value={dailyLossLimit}
                onChange={(e) => setDailyLossLimit(e.target.value)}
                min="1"
                step="1"
                required
              />
            </Field>
          </div>
        </div>

        <div className="rounded bg-accent/10 border border-accent/30 px-3 py-2 text-xs text-text">
          Mod: <strong>Paper</strong>. Live mod (gerçek emir) Hafta 3 sonrası açılacak.
        </div>

        {error && (
          <div className="rounded bg-bear/10 border border-bear/30 px-3 py-2 text-xs text-bear">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            İptal
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={createBot.isPending || !strategyId}
          >
            {createBot.isPending ? 'Oluşturuluyor...' : 'Oluştur'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <label className={`block ${className ?? ''}`}>
      <div className="text-2xs uppercase tracking-wider text-muted mb-1">{label}</div>
      {children}
    </label>
  );
}
