/**
 * Bot detay paneli.
 *
 * - Üstte: durum + aksiyon butonları (Start/Stop/Pause/Resume/Delete)
 * - Sermaye & risk özeti
 * - Açık pozisyon kartı (varsa)
 * - Performans (PnL bugün / toplam, son sinyal, candle sayısı)
 * - Son trade'ler listesi
 */

import { useEffect, useState } from 'react';
import {
  ArrowLeft, Play, Pause, Square, Trash2, Loader2,
  TrendingUp, TrendingDown, Activity,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { StatusBadge } from './StatusBadge';
import {
  useBot, useBotTrades, useStartBot, useStopBot,
  usePauseBot, useResumeBot, useDeleteBot,
} from '@/hooks/useBots';
import { formatPrice, formatTimeShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/app';
import type { BotStatus, Trade, Position } from '@/types/api';
import type { Interval } from '@/store/app';

export function BotDetail({
  botId,
  onBack,
}: {
  botId: string;
  onBack: () => void;
}): JSX.Element {
  const { data: snap, isLoading } = useBot(botId);
  const { data: trades } = useBotTrades(botId, 20);
  const start = useStartBot();
  const stop = useStopBot();
  const pause = usePauseBot();
  const resume = useResumeBot();
  const del = useDeleteBot();
  const setSymbol = useAppStore((s) => s.setSymbol);
  const setInterval = useAppStore((s) => s.setInterval);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!snap) return;
    setSymbol(snap.config.symbol);
    setInterval(snap.config.interval as Interval);
  }, [snap?.config.symbol, snap?.config.interval, setInterval, setSymbol]);

  if (isLoading || !snap) {
    return (
      <div className="p-4 text-center text-muted text-sm flex items-center justify-center gap-2">
        <Loader2 size={14} className="animate-spin" />
        Yükleniyor...
      </div>
    );
  }

  const cfg = snap.config;
  const st = snap.state;
  const status: BotStatus = cfg.status;

  const canStart = status === 'idle' || status === 'stopped' || status === 'error';
  const canStop = status === 'running' || status === 'paused';
  const canPause = status === 'running';
  const canResume = status === 'paused';

  const handleDelete = async (): Promise<void> => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    await del.mutateAsync(botId);
    onBack();
  };

  const runAction = async (
    action: typeof start | typeof stop | typeof pause | typeof resume
  ): Promise<void> => {
    setActionError(null);
    try {
      await action.mutateAsync(botId);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const busy = start.isPending || stop.isPending || pause.isPending || resume.isPending;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
        <button
          onClick={onBack}
          className="text-muted hover:text-text transition-colors"
          title="Listeye dön"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text truncate">{cfg.name}</div>
          <div className="text-xs text-muted">
            {cfg.symbol} · {cfg.interval} · {cfg.strategyId}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Body — scrollable */}
      <div className="flex-1 overflow-y-auto">
        {/* Aksiyonlar */}
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex gap-2">
            {canStart && (
              <Button
                size="sm"
                variant="bull"
                onClick={() => void runAction(start)}
                disabled={busy}
                className="flex-1"
              >
                <Play size={13} />
                Başlat
              </Button>
            )}
            {canPause && (
              <Button
                size="sm"
                variant="default"
                onClick={() => void runAction(pause)}
                disabled={busy}
                className="flex-1"
              >
                <Pause size={13} />
                Duraklat
              </Button>
            )}
            {canResume && (
              <Button
                size="sm"
                variant="bull"
                onClick={() => void runAction(resume)}
                disabled={busy}
                className="flex-1"
              >
                <Play size={13} />
                Devam et
              </Button>
            )}
            {canStop && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => void runAction(stop)}
                disabled={busy}
                className="flex-1"
              >
                <Square size={13} />
                Durdur
              </Button>
            )}
          </div>

          {busy && (
            <div className="rounded bg-accent/10 border border-accent/30 px-2 py-1.5 text-xs text-text flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" />
              Islem yapiliyor...
            </div>
          )}

          {actionError && (
            <div className="rounded bg-bear/10 border border-bear/30 px-2 py-1.5 text-xs text-bear">
              Hata: {actionError}
            </div>
          )}

          {cfg.lastError && (
            <div
              className={cn(
                'rounded border px-2 py-1.5 text-xs',
                cfg.status === 'error'
                  ? 'bg-bear/10 border-bear/30 text-bear'
                  : 'bg-accent/10 border-accent/30 text-accent'
              )}
            >
              {cfg.status === 'error' ? 'Hata' : 'Son uyari'}: {cfg.lastError}
            </div>
          )}
        </div>

        {/* Açık pozisyon (varsa) */}
        {st.position && <PositionCard position={st.position} />}

        {/* Stats */}
        <div className="p-3 border-b border-border">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Bugünkü PnL" value={st.todayPnlUsd} kind="pnl" />
            <Stat label="Toplam PnL" value={st.realizedPnlUsd} kind="pnl" />
            <Stat label="Sermaye" value={cfg.capitalUsd} kind="usd" />
            <Stat label="Maks Pozisyon" value={cfg.risk.maxPositionUsd} kind="usd" />
            <Stat label="Kaldirac" value={cfg.risk.leverage ?? 1} kind="multiplier" />
            <Stat label="SL %" value={cfg.risk.maxLossPct} kind="pct" />
            <Stat label="TP %" value={cfg.risk.takeProfitPct} kind="pct" />
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-muted">
            <span>Son sinyal:</span>
            <span className="text-text">
              {st.lastSignal ? (
                <Badge
                  variant={
                    st.lastSignal === 'buy'
                      ? 'bull'
                      : st.lastSignal === 'sell'
                        ? 'bear'
                        : 'muted'
                  }
                >
                  {st.lastSignal}
                </Badge>
              ) : (
                <span className="text-muted">—</span>
              )}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs text-muted">
            <span>Mum sayısı:</span>
            <span className="text-text font-mono">{st.candleCount}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs text-muted">
            <span>Son tick:</span>
            <span className="text-text font-mono">
              {st.lastTickAt ? formatTimeShort(st.lastTickAt) : '—'}
            </span>
          </div>
        </div>

        {/* Trade history */}
        <div>
          <div className="px-3 py-2 text-2xs uppercase tracking-wider text-muted">
            Son İşlemler ({trades?.length ?? 0})
          </div>
          {!trades || trades.length === 0 ? (
            <div className="px-3 pb-3 text-xs text-muted">Henüz işlem yok.</div>
          ) : (
            <div className="px-1 pb-1">
              {trades.map((t) => (
                <TradeRow key={t.id} trade={t} />
              ))}
            </div>
          )}
        </div>

        {/* Sil */}
        <div className="p-3 border-t border-border">
          <Button
            size="sm"
            variant="danger"
            onClick={handleDelete}
            disabled={del.isPending || canStop}
            className="w-full"
          >
            <Trash2 size={13} />
            {confirmDelete ? 'Emin misin? Tekrar tıkla' : 'Botu sil'}
          </Button>
          {canStop && (
            <p className="text-2xs text-muted mt-1 text-center">
              Silmek için önce durdur
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Yardımcı bileşenler ─────────────────────────────── */

function PositionCard({ position }: { position: Position }): JSX.Element {
  const isLong = position.side === 'BUY';
  return (
    <div className="p-3 border-b border-border bg-accent/5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xs uppercase tracking-wider text-muted">Açık Pozisyon</span>
        <Badge variant={isLong ? 'bull' : 'bear'}>{isLong ? 'LONG' : 'SHORT'}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="Giriş" value={position.entryPrice} kind="price" small />
        <Stat label="Adet" value={position.quantity} kind="qty" small />
        {position.stopLossPrice !== undefined && (
          <Stat label="SL" value={position.stopLossPrice} kind="price" small variant="bear" />
        )}
        {position.takeProfitPrice !== undefined && (
          <Stat label="TP" value={position.takeProfitPrice} kind="price" small variant="bull" />
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  kind,
  small,
  variant,
}: {
  label: string;
  value: number;
  kind: 'pnl' | 'usd' | 'pct' | 'price' | 'qty' | 'multiplier';
  small?: boolean;
  variant?: 'bull' | 'bear';
}): JSX.Element {
  const formatted =
    kind === 'pnl'
      ? `${value >= 0 ? '+' : ''}$${formatPrice(Math.abs(value))}`
      : kind === 'usd'
        ? `$${formatPrice(value)}`
        : kind === 'pct'
          ? `${value}%`
          : kind === 'multiplier'
            ? `${value}x`
          : kind === 'price'
            ? `$${formatPrice(value)}`
            : value.toFixed(6);

  const color =
    variant === 'bull'
      ? 'text-bull'
      : variant === 'bear'
        ? 'text-bear'
        : kind === 'pnl'
          ? value > 0
            ? 'text-bull'
            : value < 0
              ? 'text-bear'
              : 'text-text'
          : 'text-text';

  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-muted">{label}</div>
      <div className={cn('font-mono tabular-nums', small ? 'text-xs' : 'text-sm', color)}>
        {formatted}
      </div>
    </div>
  );
}

function TradeRow({ trade }: { trade: Trade }): JSX.Element {
  const isBuy = trade.side === 'BUY';
  const label = formatTradeActionLabel(trade);
  const metaLabel = formatTradeMetaLabel(trade);
  const pnl = trade.pnlUsd ?? 0;
  const tone =
    trade.pnlUsd !== undefined
      ? pnl > 0
        ? 'text-bull'
        : pnl < 0
          ? 'text-bear'
          : 'text-muted'
      : isBuy
        ? 'text-bull'
        : 'text-bear';
  const Icon = isBuy ? TrendingUp : TrendingDown;
  return (
    <div className="px-2 py-1.5 border-b border-border/30 last:border-0 hover:bg-surface-2 rounded text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon size={12} className={isBuy ? 'text-bull' : 'text-bear'} />
          <span className={cn('font-medium', tone)}>
            {label}
          </span>
          <span className="text-muted font-mono text-2xs">{trade.side}</span>
          <span className="text-muted">·</span>
          <span className="font-mono">${formatPrice(trade.price)}</span>
        </div>
        {trade.pnlUsd !== undefined && (
          <span
            className={cn(
              'font-mono tabular-nums',
              trade.pnlUsd > 0 ? 'text-bull' : trade.pnlUsd < 0 ? 'text-bear' : 'text-muted'
            )}
          >
            {trade.pnlUsd >= 0 ? '+' : ''}${formatPrice(Math.abs(trade.pnlUsd))}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between text-2xs text-muted mt-0.5">
        <span className="font-mono">{trade.quantity.toFixed(6)}</span>
        <span>{formatTimeShort(trade.createdAt)}</span>
      </div>
      {metaLabel && (
        <div className="mt-0.5 truncate text-2xs text-muted">
          {metaLabel}
        </div>
      )}
    </div>
  );
}

// kullanılmıyor uyarısı engellesin
function formatTradeActionLabel(trade: Trade): string {
  const isClose = trade.pnlUsd !== undefined;
  if (isClose) return trade.side === 'BUY' ? 'SHORT kapandi' : 'LONG kapandi';
  return trade.side === 'BUY' ? 'LONG acildi' : 'SHORT acildi';
}

function formatTradeMetaLabel(trade: Trade): string {
  const meta = trade.meta ?? {};
  const pattern = typeof meta.pattern === 'string' ? meta.pattern : '';
  const direction = typeof meta.direction === 'string' ? meta.direction : '';
  const length = typeof meta.zigzag_length === 'number' || typeof meta.zigzag_length === 'string'
    ? `L${meta.zigzag_length}`
    : '';
  return [pattern, length, direction].filter(Boolean).join(' ');
}

void Activity;
