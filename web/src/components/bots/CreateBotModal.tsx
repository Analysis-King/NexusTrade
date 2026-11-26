import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, CheckCircle2, Code2, Info, Loader2, Play, Save, Search, Upload, X } from 'lucide-react';
import {
  backtestsApi,
  marketApi,
  strategiesApi,
  type BacktestRun,
  type StrategyValidation,
} from '@/api/endpoints';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useCreateBot } from '@/hooks/useBots';
import { useStrategies } from '@/hooks/useStrategies';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/app';
import type { Interval } from '@/types/api';

const INTERVALS: Interval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

const DAY_OPTIONS = [
  { value: 10, label: '10g' },
  { value: 15, label: '15g' },
  { value: 30, label: '30g' },
  { value: 90, label: '90g' },
  { value: 180, label: '180g' },
  { value: 360, label: '1yıl' },
  { value: 730, label: '2yıl' },
];

const HEAVY_BACKTEST_CANDLE_THRESHOLD = 150_000;

type StopLossMode = 'target_ratio' | 'percent' | 'strategy';
type BacktestTradeRow = NonNullable<BacktestRun['trades']>[number];

interface BacktestTradeGroup {
  key: string;
  trades: number;
  winRatePct: number;
  netPnl: number;
  avgPnlPct: number;
  profitFactor: number | null;
}

const STOP_LOSS_MODE_OPTIONS: Array<{ value: StopLossMode; label: string; desc: string }> = [
  {
    value: 'target_ratio',
    label: 'TP mesafesine gore',
    desc: 'TP hedefi kac dolar uzaktaysa SL ters tarafta o oranla konur.',
  },
  {
    value: 'percent',
    label: 'Yuzde stop',
    desc: 'Sol taraftaki Stop loss (%) degerini kullanir.',
  },
  {
    value: 'strategy',
    label: 'Strateji seviyesi',
    desc: 'Strateji set_sl(price=...) gonderirse onu kullanir; yoksa yuzde stopa doner.',
  },
];

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
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [sym, setSym] = useState(symbol);
  const [interval, setInterval] = useState<Interval>('4h');
  const [strategyId, setStrategyId] = useState('');
  const [filename, setFilename] = useState('strategy.py');
  const [code, setCode] = useState('');
  const [dirty, setDirty] = useState(false);
  const [capital, setCapital] = useState('1000');
  const [maxPosition, setMaxPosition] = useState('1000');
  const [maxLossPct, setMaxLossPct] = useState('2');
  const [tpPct, setTpPct] = useState('4');
  const [dailyLossLimit, setDailyLossLimit] = useState('50');
  const [days, setDays] = useState(90);
  const [reportPeriodDays, setReportPeriodDays] = useState('1');
  const [feeBps, setFeeBps] = useState('10');
  const [slippageBps, setSlippageBps] = useState('2');
  const [allowRepaint, setAllowRepaint] = useState(true);
  const [stopLossMode, setStopLossMode] = useState<StopLossMode>('strategy');
  const [stopLossTargetRatio, setStopLossTargetRatio] = useState('0.2');
  const [strategyParamsText, setStrategyParamsText] = useState('{}');
  const [createError, setCreateError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [validation, setValidation] = useState<StrategyValidation | null>(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [backtest, setBacktest] = useState<BacktestRun | null>(null);
  const [activeBacktestId, setActiveBacktestId] = useState<string | null>(null);
  const [progressRun, setProgressRun] = useState<BacktestRun | null>(null);
  const [backtestRequestStartedAt, setBacktestRequestStartedAt] = useState<number | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningBacktest, setRunningBacktest] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [pendingHeavyBacktest, setPendingHeavyBacktest] = useState(false);

  const strategies = useStrategies();
  const createBot = useCreateBot();
  const symbols = useQuery({
    queryKey: ['symbols'],
    queryFn: () => marketApi.symbols(),
    staleTime: 60_000,
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setSym(symbol);
  }, [open, symbol]);

  useEffect(() => {
    setPendingHeavyBacktest(false);
  }, [days, interval]);

  useEffect(() => {
    if (strategyId || !strategies.data?.length) return;
    setStrategyId(strategies.data[0].filename);
  }, [strategies.data, strategyId]);

  const selectedStrategy = useQuery({
    queryKey: ['strategies', strategyId],
    queryFn: () => strategiesApi.get(strategyId),
    enabled: Boolean(strategyId),
    staleTime: 30_000,
  });

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
      setBacktest(run);
      setRunningBacktest(false);
      setActiveBacktestId(null);
      setBacktestRequestStartedAt(null);
    } else if (run.status === 'failed') {
      setBacktest(run);
      setBacktestError(run.error ?? 'Backtest basarisiz.');
      setRunningBacktest(false);
      setActiveBacktestId(null);
      setBacktestRequestStartedAt(null);
    }
  }, [activeBacktest.data]);

  useEffect(() => {
    if (!selectedStrategy.data) return;
    setFilename(selectedStrategy.data.filename);
    setCode(selectedStrategy.data.code);
    setDirty(false);
    setValidation(null);
    setEditorError(null);
    setEditorMessage(null);
    setBacktest(null);
    setBacktestError(null);
    setProgressRun(null);
    setActiveBacktestId(null);
    setBacktestRequestStartedAt(null);
  }, [selectedStrategy.data?.filename, selectedStrategy.data?.code]);

  const selectedMeta = strategies.data?.find((strategy) => strategy.filename === strategyId);
  const activeFilename = normalizeFilename(filename || strategyId || 'strategy.py');

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setCreateError(null);

    if (!code.trim()) {
      setCreateError('Bot olusturmak icin once strateji kodu gerekli.');
      return;
    }
    if (dirty) {
      setCreateError('Bot olusturmadan once stratejiyi kaydet.');
      return;
    }
    const params = parseParams(strategyParamsText);
    if (!params.ok) {
      setCreateError(params.error);
      return;
    }

    try {
      const bot = await createBot.mutateAsync({
        name: name.trim(),
        symbol: sym.trim().toUpperCase(),
        interval,
        mode: 'paper',
        strategyId: activeFilename,
        strategyParams: {
          ...params.value,
          allow_repaint: allowRepaint,
        },
        capitalUsd: Number(capital),
        risk: {
          maxLossPct: Number(maxLossPct),
          takeProfitPct: Number(tpPct),
          maxPositionUsd: Number(maxPosition),
          dailyMaxLossUsd: Number(dailyLossLimit),
          stopLossMode,
          stopLossTargetRatio: Number(stopLossTargetRatio),
        },
      });
      setName('');
      onCreated(bot.id);
      onClose();
    } catch (err) {
      setCreateError((err as Error).message);
    }
  };

  const loadLocalFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const safe = normalizeFilename(file.name);
      setFilename(safe);
      setStrategyId(safe);
      setCode(text);
      setDirty(true);
      setValidation(null);
      setBacktest(null);
      setProgressRun(null);
      setBacktestRequestStartedAt(null);
      setEditorError(null);
      setEditorMessage(`${safe} editore yuklendi.`);
    } catch (err) {
      setEditorError((err as Error).message);
    }
  };

  const validateStrategy = async (): Promise<void> => {
    setEditorError(null);
    setEditorMessage(null);
    setValidation(null);

    if (!code.trim()) {
      setEditorError('Validate icin strateji kodu gerekli.');
      return;
    }

    setValidating(true);
    try {
      const data = await strategiesApi.validate(activeFilename, code);
      setValidation(data);
      setEditorMessage(data.ok ? 'Validate basarili.' : 'Validate hata buldu.');
    } catch (err) {
      setEditorError((err as Error).message);
    } finally {
      setValidating(false);
    }
  };

  const saveStrategy = async (): Promise<void> => {
    setEditorError(null);
    setEditorMessage(null);

    if (!code.trim()) {
      setEditorError('Kaydetmek icin strateji kodu gerekli.');
      return;
    }

    setSaving(true);
    try {
      const saved = await strategiesApi.save(activeFilename, code);
      await qc.invalidateQueries({ queryKey: ['strategies'] });
      setFilename(saved.filename);
      setStrategyId(saved.filename);
      setDirty(false);
      setEditorMessage(`${saved.filename} kaydedildi.`);
    } catch (err) {
      setEditorError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const estimatedCandles = estimateCandles(days, interval);
  const needsBacktestConfirm = estimatedCandles >= HEAVY_BACKTEST_CANDLE_THRESHOLD;

  const runBacktest = async (force = false): Promise<void> => {
    setBacktestError(null);
    setBacktest(null);
    setProgressRun(null);
    setActiveBacktestId(null);
    setBacktestRequestStartedAt(null);

    if (!code.trim()) {
      setBacktestError('Backtest icin strateji kodu gerekli.');
      return;
    }

    if (needsBacktestConfirm && !force) {
      setPendingHeavyBacktest(true);
      return;
    }

    setPendingHeavyBacktest(false);
    setRunningBacktest(true);
    setBacktestRequestStartedAt(Date.now());
    try {
      const params = parseParams(strategyParamsText);
      if (!params.ok) {
        setBacktestError(params.error);
        setRunningBacktest(false);
        return;
      }
      const data = await backtestsApi.create({
        async: true,
        strategyFile: activeFilename,
        code,
        symbol: sym.trim().toUpperCase(),
        interval,
        days,
        initialCapital: Number(capital),
        feeBps: Number(feeBps),
        slippageBps: Number(slippageBps),
        fillModel: 'pessimistic_ohlc',
        params: {
          ...params.value,
          allow_repaint: allowRepaint,
          stop_loss_pct: Number(maxLossPct),
          take_profit_pct: Number(tpPct),
          stop_loss_mode: stopLossMode,
          stop_loss_target_ratio: Number(stopLossTargetRatio),
          max_position_usd: Number(maxPosition),
          report_period_days: Number(reportPeriodDays),
        },
      });
      setProgressRun(data);
      if (data.status === 'completed') {
        setBacktest(data);
        setRunningBacktest(false);
        setBacktestRequestStartedAt(null);
      } else if (data.status === 'failed') {
        setBacktest(data);
        setBacktestError(data.error ?? 'Backtest basarisiz.');
        setRunningBacktest(false);
        setBacktestRequestStartedAt(null);
      } else {
        setActiveBacktestId(data.id);
      }
    } catch (err) {
      setBacktestError((err as Error).message);
      setRunningBacktest(false);
      setBacktestRequestStartedAt(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Yeni Bot"
      className="h-[calc(100vh-48px)] max-h-[900px] w-[calc(100vw-32px)] max-w-[1240px]"
    >
      <form onSubmit={submit} className="grid h-full min-h-0 gap-4 lg:grid-cols-[390px_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="space-y-4">
            <SectionTitle title="Bot ayarlari" />

            <Field label="Bot adi">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Orn: BTC Bot"
                required
                autoFocus
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Sembol">
                <SymbolSearchInput
                  value={sym}
                  onChange={setSym}
                  symbols={symbols.data ?? []}
                  isLoading={symbols.isLoading}
                />
              </Field>

              <Field label="Zaman dilimi">
                <Select value={interval} onChange={(e) => setInterval(e.target.value as Interval)}>
                  {INTERVALS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Kayitli strateji">
              {strategies.isLoading ? (
                <InlineMuted>Stratejiler yukleniyor...</InlineMuted>
              ) : !strategies.data?.length ? (
                <InlineError>Strateji bulunamadi.</InlineError>
              ) : (
                <Select
                  value={strategyId}
                  onChange={(e) => {
                    setStrategyId(e.target.value);
                    setBacktest(null);
                    setBacktestError(null);
                  }}
                  required
                >
                  {strategies.data.map((strategy) => (
                    <option key={strategy.filename} value={strategy.filename}>
                      {strategy.name && strategy.name !== 'Isimsiz'
                        ? `${strategy.name} (${strategy.filename})`
                        : strategy.filename}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {selectedMeta?.desc && (
              <p className="text-xs leading-relaxed text-muted">
                <span className="font-medium text-text">Aciklama:</span> {selectedMeta.desc}
              </p>
            )}

            <div className="border-t border-border pt-3">
              <SectionTitle title="Sermaye ve risk" />
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

                <Field label="Maks. pozisyon (USDT)">
                  <Input
                    type="number"
                    value={maxPosition}
                    onChange={(e) => setMaxPosition(e.target.value)}
                    min="10"
                    step="10"
                    required
                  />
                </Field>

                <Field label="Stop loss (%)">
                  <Input
                    type="number"
                    value={maxLossPct}
                    onChange={(e) => setMaxLossPct(e.target.value)}
                    min="0.1"
                    step="0.1"
                    required
                  />
                </Field>

                <Field label="Take profit (%)">
                  <Input
                    type="number"
                    value={tpPct}
                    onChange={(e) => setTpPct(e.target.value)}
                    min="0.1"
                    step="0.1"
                    required
                  />
                </Field>

                <Field label="SL modeli">
                  <Select
                    value={stopLossMode}
                    onChange={(e) => setStopLossMode(e.target.value as StopLossMode)}
                  >
                    {STOP_LOSS_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="SL / TP orani">
                  <Input
                    type="number"
                    value={stopLossTargetRatio}
                    onChange={(e) => setStopLossTargetRatio(e.target.value)}
                    min="0.1"
                    step="0.05"
                    disabled={stopLossMode !== 'target_ratio'}
                  />
                </Field>

                <div className="col-span-2 rounded border border-border bg-surface/50 px-3 py-2 text-2xs leading-relaxed text-muted">
                  {STOP_LOSS_MODE_OPTIONS.find((option) => option.value === stopLossMode)?.desc}
                </div>

                <Field label="Gunluk maks. zarar" className="col-span-2">
                  <Input
                    type="number"
                    value={dailyLossLimit}
                    onChange={(e) => setDailyLossLimit(e.target.value)}
                    min="1"
                    step="1"
                    required
                  />
                </Field>

                <label className="col-span-2 flex items-center justify-between gap-3 rounded border border-border bg-surface/50 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-text">Repainting izin ver</span>
                    <span className="block text-2xs leading-relaxed text-muted">
                      Kapali olursa harmonik sinyal bir mum confirmation bekler.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={allowRepaint}
                    onChange={(e) => setAllowRepaint(e.target.checked)}
                    className="h-4 w-4 accent-accent"
                  />
                </label>
              </div>
            </div>

            <Field label="Bot ozel ayarlari (JSON)">
              <textarea
                value={strategyParamsText}
                onChange={(e) => setStrategyParamsText(e.target.value)}
                spellCheck={false}
                className="h-28 w-full resize-y rounded border border-muted/60 bg-surface p-3 font-mono text-[11px] leading-relaxed text-white outline-none placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </Field>

            <div className="rounded bg-accent/10 border border-accent/30 px-3 py-2 text-xs text-text">
              Mod: <strong>Paper</strong>. Live mod execution ve reconciliation tamamlaninca acilacak.
            </div>

            {createError && <InlineError>{createError}</InlineError>}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose}>
                Iptal
              </Button>
              <Button type="submit" variant="primary" disabled={createBot.isPending || !code.trim()}>
                {createBot.isPending ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Olusturuluyor...
                  </>
                ) : (
                  <>
                    <Save size={13} />
                    Botu olustur
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>

        <div className="min-h-0 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <div className="h-full min-h-0 overflow-y-auto pr-1">
            <div className="space-y-3">
              <section className="rounded border border-border bg-bg/40">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-text">
                    <Code2 size={14} />
                    <span className="truncate">Strateji editoru</span>
                    {dirty && <span className="text-2xs uppercase tracking-wider text-muted">degisti</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="icon"
                      variant={showGuide ? 'primary' : 'default'}
                      onClick={() => setShowGuide((value) => !value)}
                      title="Strateji kilavuzu"
                    >
                      <Info size={14} />
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".py,text/x-python,text/plain"
                      className="hidden"
                      onChange={(event) => void loadLocalFile(event)}
                    />
                    <Button type="button" size="sm" onClick={() => fileInputRef.current?.click()}>
                      <Upload size={13} />
                      Bot yukle
                    </Button>
                    <Button type="button" size="sm" onClick={() => void validateStrategy()} disabled={validating || !code.trim()}>
                      {validating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                      Validate
                    </Button>
                    <Button type="button" size="sm" variant="primary" onClick={() => void saveStrategy()} disabled={saving || !code.trim()}>
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                      Kaydet
                    </Button>
                  </div>
                </div>

                <div className="space-y-3 p-3">
                  <Field label="Dosya adi">
                    <Input
                      value={filename}
                      onChange={(e) => {
                        setFilename(e.target.value);
                        setDirty(true);
                      }}
                      onBlur={() => setFilename(activeFilename)}
                      placeholder="strategy.py"
                    />
                  </Field>

                  {selectedStrategy.isLoading ? (
                    <div className="flex h-72 items-center justify-center gap-2 rounded border border-border bg-surface/40 text-sm text-muted">
                      <Loader2 size={14} className="animate-spin" />
                      Kod yukleniyor...
                    </div>
                  ) : (
                    <textarea
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value);
                        setDirty(true);
                        setValidation(null);
                        setBacktest(null);
                      }}
                      spellCheck={false}
                      className="h-80 w-full resize-y rounded border border-muted/60 bg-surface p-3 font-mono text-[11px] leading-relaxed text-white outline-none placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
                    />
                  )}

                  {editorMessage && <ValidationBox validation={validation} message={editorMessage} />}
                  {editorError && <InlineError>{editorError}</InlineError>}
                </div>
              </section>

              {showGuide && <StrategyGuide onClose={() => setShowGuide(false)} />}

              <section className="rounded border border-border bg-surface/60 p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-text">
                    <BarChart3 size={14} />
                    Universal backtest
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={() => void runBacktest()}
                    disabled={runningBacktest || !code.trim()}
                  >
                    {runningBacktest ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        Calisiyor...
                      </>
                    ) : (
                      <>
                        <Play size={13} />
                        Backtest baslat
                      </>
                    )}
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Field label="Sure (gun)">
                    <Input
                      type="number"
                      value={days}
                      onChange={(e) => setDays(clampDays(Number(e.target.value)))}
                      min="1"
                      max="1825"
                      step="1"
                      required
                    />
                    <div className="mt-2 grid grid-cols-7 gap-1">
                      {DAY_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setDays(option.value)}
                          className={cn(
                            'h-7 rounded border px-1 text-2xs font-mono transition-colors',
                            days === option.value
                              ? 'border-accent bg-accent/15 text-accent'
                              : 'border-border bg-surface/50 text-muted hover:text-text'
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-1 text-2xs text-muted">
                      Tahmini mum: <span className="font-mono text-text">{estimatedCandles.toLocaleString('tr-TR')}</span>
                    </div>
                  </Field>

                  <Field label="Rapor suresi (gun)">
                    <Input
                      type="number"
                      value={reportPeriodDays}
                      onChange={(e) => setReportPeriodDays(e.target.value)}
                      min="0.25"
                      step="0.25"
                      required
                    />
                  </Field>

                  <Field label="Komisyon (bps)">
                    <Input
                      type="number"
                      value={feeBps}
                      onChange={(e) => setFeeBps(e.target.value)}
                      min="0"
                      max="100"
                      step="0.1"
                      required
                    />
                  </Field>

                  <Field label="Slippage (bps)">
                    <Input
                      type="number"
                      value={slippageBps}
                      onChange={(e) => setSlippageBps(e.target.value)}
                      min="0"
                      max="500"
                      step="0.1"
                      required
                    />
                  </Field>
                </div>

                {pendingHeavyBacktest && (
                  <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-text">
                    <div className="font-medium text-amber-300">
                      {estimatedCandles.toLocaleString('tr-TR')} mum taranacak.
                    </div>
                    <div className="mt-1 text-muted">
                      Bu seçim uzun sürebilir veya sunucu limitine takılabilir.
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={() => void runBacktest(true)}
                      disabled={runningBacktest}
                      className="mt-2"
                    >
                      Yine de çalıştır
                    </Button>
                  </div>
                )}

                {runningBacktest && (
                  <BacktestProgressPanel
                    run={progressRun}
                    estimatedCandles={estimatedCandles}
                    requestStartedAt={backtestRequestStartedAt}
                  />
                )}

                {backtestError && <div className="mt-3"><InlineError>{backtestError}</InlineError></div>}
              </section>

              <section className="rounded border border-border bg-bg/40 p-3">
                <BacktestAnalysis run={backtest} />
              </section>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function BacktestProgressPanel({
  run,
  estimatedCandles,
  requestStartedAt,
}: {
  run: BacktestRun | null;
  estimatedCandles: number;
  requestStartedAt: number | null;
}): JSX.Element {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const progress = run?.progress;
  const startedAt = progress?.startedAt ?? requestStartedAt ?? now;
  const elapsedMs = Math.max(0, now - startedAt);
  const pct = progress ? clampProgress(progress.pct) : estimateStartingProgress(elapsedMs);
  const remainingMs = progress && pct > 5 && pct < 100 ? (elapsedMs * (100 - pct)) / pct : null;
  const fetched = progress?.candlesFetched ?? progress?.candleCount;
  const candleLabel =
    fetched !== undefined
      ? `${formatInteger(fetched)} / ${formatInteger(progress?.estimatedCandles ?? estimatedCandles)}`
      : formatInteger(estimatedCandles);

  return (
    <div className="mt-3 rounded border border-accent/30 bg-accent/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-text">
            {progress?.message ?? formatStartingBacktestMessage(elapsedMs)}
          </div>
          <div className="mt-0.5 text-2xs uppercase tracking-wider text-muted">
            {formatBacktestStage(progress?.stage)}
          </div>
        </div>
        <div className="font-mono text-sm text-accent">{pct}%</div>
      </div>

      <div className="h-2 overflow-hidden rounded bg-bg/70">
        <div
          className="h-full rounded bg-accent transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-2xs">
        <InfoLine label="Gecen" value={formatDurationShort(elapsedMs)} />
        <InfoLine label="Kalan" value={remainingMs === null ? 'bekleniyor' : formatDurationShort(remainingMs)} />
        <InfoLine label="Mum" value={candleLabel} />
      </div>
    </div>
  );
}

function BacktestAnalysis({ run }: { run: BacktestRun | null }): JSX.Element {
  if (!run) {
    return (
      <div className="flex min-h-[220px] items-center justify-center text-center text-xs text-muted">
        Backtest tamamlaninca metrikler, sinyal kirilimi, varsayimlar ve ham sonuc burada gorunecek.
      </div>
    );
  }

  if (run.status === 'failed') {
    return <InlineError>{run.error ?? 'Backtest basarisiz.'}</InlineError>;
  }

  const summary = run.summary;
  const patterns = run.patterns ?? [];
  const observationStats = run.observationStats ?? [];
  const periodReports = run.periodReports ?? [];
  const trades = run.trades ?? [];
  const tradeGroups = groupBacktestTrades(trades);

  return (
    <div className="space-y-4">
      <div>
        <SectionTitle title="Analiz ozeti" />
        {summary ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Metric label="Getiri" value={formatPct(summary.totalReturnPct)} tone={summary.totalReturnPct >= 0 ? 'bull' : 'bear'} />
            <Metric label="Final" value={`$${formatNumber(summary.finalCapital)}`} />
            <Metric label="Islem" value={String(summary.totalTrades)} />
            <Metric label="Win rate" value={`${formatNumber(summary.winRatePct)}%`} />
            <Metric label="Max DD" value={`${formatNumber(summary.maxDrawdownPct)}%`} />
            <Metric label="PF" value={summary.profitFactor === null ? '-' : formatNumber(summary.profitFactor)} />
          </div>
        ) : (
          <InlineMuted>Ozet uretilemedi.</InlineMuted>
        )}
      </div>

      <div>
        <SectionTitle title="Donem raporu" />
        {periodReports.length ? (
          <div className="mt-2 max-h-56 overflow-auto rounded border border-border">
            <div className="grid min-w-[760px] grid-cols-[1.2fr_74px_74px_74px_64px_64px_82px] border-b border-border px-2 py-1.5 text-2xs uppercase tracking-wider text-muted">
              <span>Aralik</span>
              <span className="text-right">Getiri</span>
              <span className="text-right">Realize</span>
              <span className="text-right">Acik</span>
              <span className="text-right">TP/SL</span>
              <span className="text-right">Islem</span>
              <span className="text-right">Final</span>
            </div>
            {periodReports.map((report) => (
              <div
                key={`${report.period}-${report.startTime}`}
                className="grid min-w-[760px] grid-cols-[1.2fr_74px_74px_74px_64px_64px_82px] border-b border-border/50 px-2 py-1.5 text-xs last:border-0"
              >
                <span className="truncate text-text">
                  {formatShortDateTime(report.startTime)} - {formatShortDateTime(report.endTime)}
                </span>
                <span className={cn('text-right font-mono', safeNumber(report.returnPct) >= 0 ? 'text-bull' : 'text-bear')}>
                  {formatPct(report.returnPct)}
                </span>
                <span className={cn('text-right font-mono', safeNumber(report.realizedPnl) >= 0 ? 'text-bull' : 'text-bear')}>
                  ${formatNumber(report.realizedPnl)}
                </span>
                <span className={cn('text-right font-mono', safeNumber(report.openPnl) >= 0 ? 'text-bull' : 'text-bear')}>
                  ${formatNumber(report.openPnl)}
                </span>
                <span className="text-right font-mono">{safeNumber(report.tpTrades)}/{safeNumber(report.slTrades)}</span>
                <span className="text-right font-mono">{report.trades}</span>
                <span className="text-right font-mono text-text">${formatNumber(report.endEquity)}</span>
              </div>
            ))}
          </div>
        ) : (
          <InlineMuted>Rapor suresi girildiginde donemsel sonuc burada gorunur.</InlineMuted>
        )}
      </div>

      <div>
        <SectionTitle title="Sinyal kirilimi" />
        {patterns.length ? (
          <div className="mt-2 overflow-hidden rounded border border-border">
            <div className="grid grid-cols-[1fr_64px_74px_74px] border-b border-border px-2 py-1.5 text-2xs uppercase tracking-wider text-muted">
              <span>Tip</span>
              <span className="text-right">Islem</span>
              <span className="text-right">Win</span>
              <span className="text-right">Getiri</span>
            </div>
            {patterns.map((pattern) => (
              <div
                key={pattern.pattern}
                className="grid grid-cols-[1fr_64px_74px_74px] border-b border-border/50 px-2 py-1.5 text-xs last:border-0"
              >
                <span className="truncate text-text">{pattern.pattern}</span>
                <span className="text-right font-mono">{pattern.trades}</span>
                <span className="text-right font-mono">{formatNumber(pattern.winRatePct)}%</span>
                <span className={cn('text-right font-mono', pattern.totalReturnPct >= 0 ? 'text-bull' : 'text-bear')}>
                  {formatPct(pattern.totalReturnPct)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <InlineMuted>Bu aralikta islem bulunmadi.</InlineMuted>
        )}
      </div>

      <div>
        <SectionTitle title="Strateji etiketleri" />
        {tradeGroups.length ? (
          <div className="mt-2 max-h-64 overflow-auto rounded border border-border">
            <div className="grid min-w-[640px] grid-cols-[1fr_64px_74px_82px_64px] border-b border-border px-2 py-1.5 text-2xs uppercase tracking-wider text-muted">
              <span>Etiket</span>
              <span className="text-right">Islem</span>
              <span className="text-right">Win</span>
              <span className="text-right">Net</span>
              <span className="text-right">PF</span>
            </div>
            {tradeGroups.map((group) => (
              <div
                key={group.key}
                className="grid min-w-[640px] grid-cols-[1fr_64px_74px_82px_64px] border-b border-border/50 px-2 py-1.5 text-xs last:border-0"
              >
                <span className="truncate text-text">{group.key}</span>
                <span className="text-right font-mono">{group.trades}</span>
                <span className="text-right font-mono">{formatNumber(group.winRatePct)}%</span>
                <span className={cn('text-right font-mono', group.netPnl >= 0 ? 'text-bull' : 'text-bear')}>
                  ${formatNumber(group.netPnl)}
                </span>
                <span className="text-right font-mono text-muted">
                  {group.profitFactor === null ? '-' : formatNumber(group.profitFactor)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <InlineMuted>Strateji set_meta(...) ile etiket gonderirse burada gorunur.</InlineMuted>
        )}
      </div>

      <div>
        <SectionTitle title="Islem detaylari" />
        {trades.length ? (
          <div className="mt-2 max-h-72 overflow-auto rounded border border-border">
            <div className="grid min-w-[1120px] grid-cols-[1.1fr_1fr_56px_88px_88px_88px_88px_76px_74px_74px_70px] border-b border-border px-2 py-1.5 text-2xs uppercase tracking-wider text-muted">
              <span>Zaman</span>
              <span>Etiket</span>
              <span className="text-right">Yon</span>
              <span className="text-right">Giris</span>
              <span className="text-right">SL</span>
              <span className="text-right">TP</span>
              <span className="text-right">Cikis</span>
              <span className="text-right">Sebep</span>
              <span className="text-right">Islem %</span>
              <span className="text-right">Net</span>
              <span className="text-right">Fee</span>
            </div>
            {trades.map((trade) => (
              <div
                key={trade.id}
                className="grid min-w-[1120px] grid-cols-[1.1fr_1fr_56px_88px_88px_88px_88px_76px_74px_74px_70px] border-b border-border/50 px-2 py-1.5 text-xs last:border-0"
              >
                <span className="truncate text-text">
                  {formatShortDateTime(trade.entryTime)} - {formatShortDateTime(trade.exitTime)}
                </span>
                <span className="truncate text-muted">{tradeMetaLabel(trade)}</span>
                <span className={cn('text-right font-mono uppercase', trade.side === 'long' ? 'text-bull' : 'text-bear')}>
                  {trade.side}
                </span>
                <span className="text-right font-mono">{formatPrice(trade.entryPrice)}</span>
                <span className="text-right font-mono text-muted">{formatPrice(trade.slPrice)}</span>
                <span className="text-right font-mono text-muted">{formatPrice(trade.tpPrice)}</span>
                <span className="text-right font-mono">{formatPrice(trade.exitPrice)}</span>
                <span className={cn('text-right font-mono uppercase', trade.reason === 'tp' ? 'text-bull' : trade.reason === 'sl' ? 'text-bear' : 'text-muted')}>
                  {formatTradeReason(trade.reason)}
                </span>
                <span className={cn('text-right font-mono', safeNumber(trade.pnlPct) >= 0 ? 'text-bull' : 'text-bear')}>
                  {formatPct(trade.pnlPct)}
                </span>
                <span className={cn('text-right font-mono', safeNumber(trade.netPnl) >= 0 ? 'text-bull' : 'text-bear')}>
                  ${formatNumber(trade.netPnl)}
                </span>
                <span className="text-right font-mono text-muted">${formatNumber(trade.feePaid)}</span>
              </div>
            ))}
          </div>
        ) : (
          <InlineMuted>Bu backtestte kapanan islem yok.</InlineMuted>
        )}
      </div>

      <div>
        <SectionTitle title="Gozlemler" />
        {observationStats.length ? (
          <div className="mt-2 overflow-hidden rounded border border-border">
            <div className="grid grid-cols-[1fr_58px_64px_72px_64px] border-b border-border px-2 py-1.5 text-2xs uppercase tracking-wider text-muted">
              <span>Kosul</span>
              <span className="text-right">Yon</span>
              <span className="text-right">Adet</span>
              <span className="text-right">Win</span>
              <span className="text-right">Ort.</span>
            </div>
            {observationStats.map((item) => (
              <div
                key={`${item.name}-${item.side}`}
                className="grid grid-cols-[1fr_58px_64px_72px_64px] border-b border-border/50 px-2 py-1.5 text-xs last:border-0"
              >
                <span className="truncate text-text">{item.name}</span>
                <span className="text-right font-mono">{item.side}</span>
                <span className="text-right font-mono">{item.count}</span>
                <span className="text-right font-mono">{formatNumber(item.winRatePct)}%</span>
                <span className={cn('text-right font-mono', item.avgReturnPct >= 0 ? 'text-bull' : 'text-bear')}>
                  {formatPct(item.avgReturnPct)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <InlineMuted>Bu aralikta gozlem kaydi yok.</InlineMuted>
        )}
      </div>

      <div>
        <SectionTitle title="Varsayimlar" />
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <InfoLine label="Mum" value={String(run.candleCount)} />
          <InfoLine label="Fee" value={`${run.assumptions.feeBps} bps`} />
          <InfoLine label="Slippage" value={`${run.assumptions.slippageBps} bps`} />
          <InfoLine label="Fill" value={run.assumptions.fillModel} />
        </div>
      </div>

      <div>
        <SectionTitle title="Ham sonuc" />
        <pre className="mt-2 max-h-44 overflow-auto rounded bg-surface-2/40 p-2 font-mono text-[10px] leading-relaxed text-muted">
          {JSON.stringify(run.raw ?? run, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function SymbolSearchInput({
  value,
  onChange,
  symbols,
  isLoading,
}: {
  value: string;
  onChange: (value: string) => void;
  symbols: string[];
  isLoading: boolean;
}): JSX.Element {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toUpperCase();
    const source = symbols.length ? symbols : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    if (!q) return source.slice(0, 40);
    return source.filter((symbol) => symbol.includes(q)).slice(0, 40);
  }, [symbols, deferredQuery]);

  const commit = (next: string): void => {
    const safe = next.trim().toUpperCase();
    setQuery(safe);
    onChange(safe);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
      <Input
        value={query}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          const next = e.target.value.toUpperCase();
          setQuery(next);
          onChange(next);
          setOpen(true);
        }}
        placeholder="BTCUSDT"
        required
        className="pl-8 font-mono"
      />

      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded border border-border bg-surface shadow-xl">
          {isLoading ? (
            <div className="px-3 py-2 text-xs text-muted">Semboller yukleniyor...</div>
          ) : filtered.length ? (
            filtered.map((symbol) => (
              <button
                key={symbol}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(symbol)}
                className={cn(
                  'block w-full border-b border-border/50 px-3 py-2 text-left font-mono text-xs last:border-0',
                  'hover:bg-surface-2',
                  value === symbol && 'bg-accent/10 text-accent'
                )}
              >
                {symbol}
              </button>
            ))
          ) : (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(query)}
              className="block w-full px-3 py-2 text-left font-mono text-xs text-text hover:bg-surface-2"
            >
              {query || 'Sembol gir'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StrategyGuide({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <section className="rounded border border-border bg-bg/40 p-3 text-xs">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-text">
          <Info size={14} />
          Strateji kilavuzu
        </div>
        <Button type="button" size="icon" variant="ghost" onClick={onClose} title="Kilavuzu kapat">
          <X size={14} />
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2 text-muted">
          <SectionTitle title="Fonksiyonlar" />
          <GuideLine code="def initialize()" text="Opsiyonel. Strateji ilk yuklenirken varsayilan config dondurebilir." />
          <GuideLine code="REQUIRES_FOOTPRINT = True" text="Stratejinin gerceklesen islem akisini istedigini bildirir." />
          <GuideLine code="def on_candle(candle, portfolio, config)" text="Zorunlu. Her kapanan mumda ust motor tarafindan cagrilir." />
          <GuideLine code="config" text="Bot ekranindaki o bot'a ozel JSON ayarlari burada okunur." />
          <GuideLine code="candle" text="Son kapanan mum: open, high, low, close, volume, time." />
          <GuideLine code="portfolio" text="Bot durumu: has_position, usdt, pnl, side." />
        </div>
        <div className="space-y-2 text-muted">
          <SectionTitle title="Ust motor komutlari" />
          <GuideLine code="buy()" text="Ust motora alis/long sinyali gonderir." />
          <GuideLine code="sell()" text="Ust motora satis/short veya pozisyon kapatma sinyali gonderir." />
          <GuideLine code="hold()" text="Bu mumda islem yok demektir." />
          <GuideLine code="observe('shark', side='short')" text="Emir acmadan kosul/pattern basarisini takip eder." />
          <GuideLine code="set_meta(pattern='ABCD')" text="Acilan islemin raporuna stratejiye ozel etiket ekler." />
          <GuideLine code="set_sl(pct=2)" text="Sinyale stop-loss yuzdesi ekler." />
          <GuideLine code="set_tp(pct=4)" text="Sinyale take-profit yuzdesi ekler." />
          <GuideLine code="indicators.rsi(14)" text="Hazir indikator ornegi." />
          <GuideLine code="indicators.ema(20)" text="Hazir indikator ornegi." />
          <GuideLine code="indicators.candles()" text="Gecmis mum listesini verir." />
          <GuideLine code="indicators.footprint()" text="Son kapanan mumun delta, POC ve fiyat seviyesi hacimlerini verir." />
          <GuideLine code="indicators.footprints()" text="Bot basladiktan sonra biriken tamamlanmis footprint listesini verir." />
          <GuideLine code="plot(series, title='EMA')" text="Seri degerlerini grafikte cizer." />
          <GuideLine code="line.new(p1, p2)" text="Iki {time, price} noktasi arasina cizgi cizer." />
          <GuideLine code="label.new(point, text='ABCD')" text="Bir {time, price} noktasina etiket koyar." />
        </div>
      </div>

      <SectionTitle title="Example" />
      <pre className="mt-3 max-h-44 overflow-auto rounded bg-bg/70 p-2 font-mono text-[10px] leading-relaxed text-muted">
{`def initialize():
    return {}

def on_candle(candle, portfolio, config):
    rsi = indicators.rsi(14)
    candles = indicators.candles()
    closes = [x["c"] for x in candles]
    plot(closes[-50:], title="Close", color="#60a5fa")

    if rsi < 30:
        observe("rsi.oversold", side="long")
        label.new({"time": candle.time, "price": candle.close}, text="RSI long")
        set_meta(pattern="RSI oversold", direction="bullish")
        buy()
    elif rsi > 70:
        observe("rsi.overbought", side="short")
        if len(candles) > 1:
            line.new(
                {"time": candles[-2]["t"], "price": candles[-2]["c"]},
                {"time": candle.time, "price": candle.close},
                color="#ef4444"
            )
        set_meta(pattern="RSI overbought", direction="bearish")
        sell()
    else:
        hold()`}
      </pre>
    </section>
  );
}

function GuideLine({ code, text }: { code: string; text: string }): JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(140px,0.9fr)_1fr] gap-2">
      <code className="truncate rounded bg-bg/70 px-1.5 py-0.5 font-mono text-[10px] text-text">{code}</code>
      <span>{text}</span>
    </div>
  );
}

function ValidationBox({
  validation,
  message,
}: {
  validation: StrategyValidation | null;
  message: string;
}): JSX.Element {
  if (!validation) return <InlineMuted>{message}</InlineMuted>;
  return (
    <div
      className={cn(
        'rounded border px-3 py-2 text-xs',
        validation.ok ? 'border-bull/30 bg-bull/10 text-bull' : 'border-bear/30 bg-bear/10 text-bear'
      )}
    >
      <div className="font-medium">{message}</div>
      {validation.errors.length > 0 && <div className="mt-1 text-bear">{validation.errors.join(' ')}</div>}
      {validation.warnings.length > 0 && <div className="mt-1 text-muted">{validation.warnings.join(' ')}</div>}
    </div>
  );
}

function clampDays(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(1825, Math.round(value)));
}

function estimateCandles(days: number, interval: Interval): number {
  const minutes = intervalToMinutes(interval);
  return Math.ceil((days * 24 * 60) / minutes);
}

function intervalToMinutes(interval: Interval): number {
  const map: Record<Interval, number> = {
    '1m': 1,
    '3m': 3,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '2h': 120,
    '4h': 240,
    '6h': 360,
    '8h': 480,
    '12h': 720,
    '1d': 1440,
    '3d': 4320,
    '1w': 10080,
    '1M': 43200,
  };
  return map[interval] ?? 1;
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <label className={cn('block min-w-0', className)}>
      <div className="mb-1 text-2xs uppercase tracking-wider text-muted">{label}</div>
      {children}
    </label>
  );
}

function SectionTitle({ title }: { title: string }): JSX.Element {
  return <div className="text-2xs uppercase tracking-wider text-muted">{title}</div>;
}

function InlineMuted({ children }: { children: ReactNode }): JSX.Element {
  return <div className="rounded bg-surface-2/40 px-3 py-2 text-xs text-muted">{children}</div>;
}

function InlineError({ children }: { children: ReactNode }): JSX.Element {
  return <div className="rounded bg-bear/10 border border-bear/30 px-3 py-2 text-xs text-bear">{children}</div>;
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
    <div className="rounded border border-border bg-surface/50 px-2 py-1.5">
      <div className="text-2xs uppercase tracking-wider text-muted">{label}</div>
      <div className={cn('mt-0.5 truncate font-mono text-sm tabular-nums', color)}>{value}</div>
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="truncate font-mono text-text">{value}</span>
    </div>
  );
}

function normalizeFilename(value: string): string {
  const raw = value.trim().split(/[\\/]/).pop() || 'strategy.py';
  const noExt = raw.replace(/\.py$/i, '');
  const safe = noExt.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'strategy';
  return `${safe.slice(0, 76)}.py`;
}

function parseParams(value: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = value.trim() ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Bot ozel ayarlari JSON obje olmali.' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'Bot ozel ayarlari gecersiz JSON.' };
  }
}

function tradeMetaLabel(trade: BacktestTradeRow): string {
  const meta = trade.meta ?? {};
  const pattern = typeof meta.pattern === 'string' && meta.pattern.trim() ? meta.pattern.trim() : '';
  const direction = typeof meta.direction === 'string' && meta.direction.trim() ? meta.direction.trim() : trade.side;
  const lengthValue = meta.zigzag_length ?? meta.length ?? meta.period;
  const length = typeof lengthValue === 'number' || typeof lengthValue === 'string' ? String(lengthValue) : '';
  if (!pattern && !length) return '-';
  return `${pattern || 'Strateji'}${length ? ` L${length}` : ''} ${direction}`;
}

function groupBacktestTrades(trades: BacktestTradeRow[]): BacktestTradeGroup[] {
  const groups = new Map<string, {
    trades: number;
    wins: number;
    netPnl: number;
    pnlPct: number;
    winPnl: number;
    lossPnl: number;
  }>();

  for (const trade of trades) {
    const key = tradeMetaLabel(trade);
    if (key === '-') continue;
    const current = groups.get(key) ?? {
      trades: 0,
      wins: 0,
      netPnl: 0,
      pnlPct: 0,
      winPnl: 0,
      lossPnl: 0,
    };
    const netPnl = safeNumber(trade.netPnl);
    current.trades += 1;
    current.netPnl += netPnl;
    current.pnlPct += safeNumber(trade.pnlPct);
    if (netPnl > 0) {
      current.wins += 1;
      current.winPnl += netPnl;
    } else if (netPnl < 0) {
      current.lossPnl += netPnl;
    }
    groups.set(key, current);
  }

  return [...groups.entries()]
    .map(([key, item]) => ({
      key,
      trades: item.trades,
      winRatePct: item.trades ? (item.wins / item.trades) * 100 : 0,
      netPnl: item.netPnl,
      avgPnlPct: item.trades ? item.pnlPct / item.trades : 0,
      profitFactor: item.lossPnl < 0 ? item.winPnl / Math.abs(item.lossPnl) : null,
    }))
    .sort((a, b) => Math.abs(b.netPnl) - Math.abs(a.netPnl));
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

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  return formatNumber(value);
}

function formatTradeReason(value: string): string {
  if (value === 'tp') return 'TP';
  if (value === 'sl') return 'SL';
  if (value === 'signal') return 'SIGNAL';
  if (value === 'end_of_test') return 'END';
  return value.toUpperCase();
}

function formatShortDateTime(value: number): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
