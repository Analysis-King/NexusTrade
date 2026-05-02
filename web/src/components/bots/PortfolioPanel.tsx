/**
 * Portföy paneli.
 *
 * - Toplam paper bakiye (tüm botların capital toplamı)
 * - Toplam günlük + toplam gerçekleşmiş PnL (tüm bot'lardan toplam)
 * - Açık pozisyonlar listesi
 *
 * Multi-bot snapshot için her botun /bots/:id endpoint'ine gitmek lazım.
 * useBotPortfolio hook'unu yazmak yerine basit yaklaşım: liste alındığında
 * her birinin detayını paralel çek.
 */

import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Loader2, Wallet, TrendingUp } from 'lucide-react';
import { botsApi } from '@/api/endpoints';
import { ws } from '@/api/ws';
import { useBots } from '@/hooks/useBots';
import { Badge } from '@/components/ui/Badge';
import { formatPrice } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { BotConfig, Position } from '@/types/api';

export function PortfolioPanel(): JSX.Element {
  const { data: bots, isLoading } = useBots();
  const qc = useQueryClient();

  // Her bot için detay sorgusu
  const detailQueries = useQueries({
    queries: (bots ?? []).map((b) => ({
      queryKey: ['bots', b.id],
      queryFn: () => botsApi.get(b.id),
      refetchInterval: 5_000,
    })),
  });

  // WS bot-event geldiğinde tüm portföyü tazele
  useEffect(() => {
    return ws.onBotEvent(() => {
      qc.invalidateQueries({ queryKey: ['bots'] });
    });
  }, [qc]);

  const summary = useMemo(() => {
    let totalCapital = 0;
    let todayPnl = 0;
    let totalPnl = 0;
    const openPositions: Array<{ bot: BotConfig; position: Position }> = [];

    if (bots) {
      for (let i = 0; i < bots.length; i++) {
        const bot = bots[i]!;
        totalCapital += bot.capitalUsd;
        const snap = detailQueries[i]?.data;
        if (snap) {
          todayPnl += snap.state.todayPnlUsd;
          totalPnl += snap.state.realizedPnlUsd;
          if (snap.state.position) {
            openPositions.push({ bot, position: snap.state.position });
          }
        }
      }
    }
    return { totalCapital, todayPnl, totalPnl, openPositions };
  }, [bots, detailQueries]);

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted text-sm flex items-center justify-center gap-2">
        <Loader2 size={14} className="animate-spin" />
        Yükleniyor...
      </div>
    );
  }

  if (!bots || bots.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-muted">
        <Wallet size={28} className="mx-auto mb-2 opacity-30" />
        <div>Henüz bot yok.</div>
        <div className="text-xs mt-1">İşlemler tab'ından oluştur.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Üst — özet kartlar */}
      <div className="p-3 border-b border-border space-y-2">
        <SummaryRow
          label="Toplam Sermaye"
          value={summary.totalCapital}
          kind="usd"
        />
        <SummaryRow
          label="Bugünkü PnL"
          value={summary.todayPnl}
          kind="pnl"
          highlight
        />
        <SummaryRow
          label="Gerçekleşmiş PnL"
          value={summary.totalPnl}
          kind="pnl"
        />
      </div>

      {/* Açık pozisyonlar */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2 text-2xs uppercase tracking-wider text-muted flex items-center justify-between">
          <span>Açık Pozisyonlar</span>
          <span className="text-text">{summary.openPositions.length}</span>
        </div>

        {summary.openPositions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">
            Açık pozisyon yok
          </div>
        ) : (
          <div className="px-1">
            {summary.openPositions.map(({ bot, position }) => (
              <PositionRow key={bot.id} bot={bot} position={position} />
            ))}
          </div>
        )}

        {/* Bot durum özeti */}
        <div className="px-3 py-2 mt-2 text-2xs uppercase tracking-wider text-muted">
          Botlar
        </div>
        <div className="px-1 pb-3 space-y-1">
          {bots.map((b) => (
            <div
              key={b.id}
              className="px-2 py-1.5 rounded hover:bg-surface-2 flex items-center justify-between text-xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-text truncate">{b.name}</span>
                <span className="text-muted font-mono">{b.symbol}</span>
              </div>
              <Badge
                variant={
                  b.status === 'running'
                    ? 'bull'
                    : b.status === 'error'
                      ? 'bear'
                      : b.status === 'paused'
                        ? 'warning'
                        : 'muted'
                }
              >
                {b.status}
              </Badge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  kind,
  highlight,
}: {
  label: string;
  value: number;
  kind: 'usd' | 'pnl';
  highlight?: boolean;
}): JSX.Element {
  const formatted =
    kind === 'pnl'
      ? `${value >= 0 ? '+' : ''}$${formatPrice(Math.abs(value))}`
      : `$${formatPrice(value)}`;
  const color =
    kind === 'pnl'
      ? value > 0
        ? 'text-bull'
        : value < 0
          ? 'text-bear'
          : 'text-text'
      : 'text-text';

  return (
    <div
      className={cn(
        'flex items-center justify-between rounded px-2 py-1.5',
        highlight && 'bg-surface-2'
      )}
    >
      <span className="text-2xs uppercase tracking-wider text-muted">{label}</span>
      <span className={cn('font-mono tabular-nums font-medium', color, highlight && 'text-base')}>
        {formatted}
      </span>
    </div>
  );
}

function PositionRow({ bot, position }: { bot: BotConfig; position: Position }): JSX.Element {
  const isLong = position.side === 'BUY';
  return (
    <div className="px-2 py-2 border-b border-border/30 last:border-0 hover:bg-surface-2 rounded">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="min-w-0">
          <div className="text-xs font-medium text-text truncate">{bot.name}</div>
          <div className="text-2xs text-muted font-mono">
            {position.symbol} · {position.quantity.toFixed(6)}
          </div>
        </div>
        <Badge variant={isLong ? 'bull' : 'bear'}>{isLong ? 'LONG' : 'SHORT'}</Badge>
      </div>
      <div className="grid grid-cols-3 gap-1 text-2xs">
        <div>
          <div className="text-muted">Giriş</div>
          <div className="font-mono text-text">${formatPrice(position.entryPrice)}</div>
        </div>
        {position.stopLossPrice !== undefined && (
          <div>
            <div className="text-muted">SL</div>
            <div className="font-mono text-bear">${formatPrice(position.stopLossPrice)}</div>
          </div>
        )}
        {position.takeProfitPrice !== undefined && (
          <div>
            <div className="text-muted">TP</div>
            <div className="font-mono text-bull">${formatPrice(position.takeProfitPrice)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// kullanılmıyor uyarısı
void TrendingUp;
