import { useMemo, useState, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  Bot,
  BookOpen,
  Loader2,
  ScrollText,
  ShoppingCart,
  Target,
} from 'lucide-react';
import { marketApi, botsApi } from '@/api/endpoints';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { BotList } from './BotList';
import { BotDetail } from './BotDetail';
import { CreateBotModal } from './CreateBotModal';
import { useBots } from '@/hooks/useBots';
import { cn } from '@/lib/cn';
import { formatPrice, formatTimeShort } from '@/lib/format';
import { useAppStore } from '@/store/app';
import type { BotConfig, BotSnapshot, OrderBook, Position, Trade } from '@/types/api';

type PanelTab = 'order' | 'book' | 'trades' | 'positions' | 'bots';
type OrderSide = 'BUY' | 'SELL';
type ManualOrderType = 'LIMIT' | 'MARKET' | 'STOP_L' | 'OCO' | 'TWAP';

const PANEL_TABS: Array<{ id: PanelTab; label: string; icon: typeof ShoppingCart }> = [
  { id: 'order', label: 'Emir', icon: ShoppingCart },
  { id: 'book', label: 'Defter', icon: BookOpen },
  { id: 'trades', label: 'İşlem', icon: ScrollText },
  { id: 'positions', label: 'Pozisyon', icon: Target },
  { id: 'bots', label: 'Botlar', icon: Bot },
];

const ORDER_TYPES: Array<{ id: ManualOrderType; label: string }> = [
  { id: 'LIMIT', label: 'Limit' },
  { id: 'MARKET', label: 'Piyasa' },
  { id: 'STOP_L', label: 'Stop-L' },
  { id: 'OCO', label: 'OCO' },
  { id: 'TWAP', label: 'TWAP' },
];

export function TradingPanel(): JSX.Element {
  const [activeTab, setActiveTab] = useState<PanelTab>('order');
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const setSelectedBotId = useAppStore((s) => s.setSelectedBotId);

  const selectBot = (id: string | null): void => {
    setSelected(id);
    setSelectedBotId(id);
    if (id) setActiveTab('bots');
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-11 flex-shrink-0 border-b border-border bg-surface">
        {PANEL_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'relative flex min-w-0 flex-1 items-center justify-center gap-1 px-1 text-2xs uppercase tracking-wider transition-colors',
                active ? 'text-accent' : 'text-muted hover:bg-surface-2 hover:text-text'
              )}
              title={tab.label}
            >
              <Icon size={12} className="hidden sm:block" />
              <span className="truncate">{tab.label}</span>
              {active && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" />}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'order' && <ManualOrderPanel />}
        {activeTab === 'book' && <OrderBookPanel />}
        {activeTab === 'trades' && <OrderHistoryPanel />}
        {activeTab === 'positions' && <PositionsPanel onSelectBot={selectBot} />}
        {activeTab === 'bots' && (
          <BotsPanel
            selected={selected}
            onSelect={selectBot}
            onCreate={() => setCreateOpen(true)}
          />
        )}
      </div>

      <CreateBotModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => selectBot(id)}
      />
    </div>
  );
}

function ManualOrderPanel(): JSX.Element {
  const symbol = useAppStore((s) => s.symbol);
  const [side, setSide] = useState<OrderSide>('BUY');
  const [orderType, setOrderType] = useState<ManualOrderType>('LIMIT');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('0.001');
  const [tpPrice, setTpPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const ticker = useQuery({
    queryKey: ['ticker', symbol],
    queryFn: () => marketApi.ticker(symbol),
    refetchInterval: 5_000,
  });

  const marketPrice = ticker.data ? Number(ticker.data.lastPrice) : 0;
  const effectivePrice = orderType === 'MARKET' || !Number(price) ? marketPrice : Number(price);
  const quantity = Number(amount);
  const notional = Number.isFinite(effectivePrice * quantity) ? effectivePrice * quantity : 0;
  const estimatedFee = notional * 0.001;
  const symbolBase = symbol.replace(/USDT$/, '') || symbol;

  const applyPercent = (pct: number): void => {
    if (!effectivePrice) return;
    const referenceUsdt = 1000;
    setAmount(((referenceUsdt * pct) / 100 / effectivePrice).toFixed(6));
  };

  const submit = (): void => {
    setMessage('Manuel emir servisi henuz baglanmadi. Bu panel emre hazir formu koruyor.');
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSide('BUY')}
          className={cn(
            'h-10 rounded border text-xs font-semibold uppercase tracking-wider transition-colors',
            side === 'BUY'
              ? 'border-bull bg-bull/15 text-bull'
              : 'border-border bg-surface/60 text-muted hover:text-text'
          )}
        >
          Alış
        </button>
        <button
          type="button"
          onClick={() => setSide('SELL')}
          className={cn(
            'h-10 rounded border text-xs font-semibold uppercase tracking-wider transition-colors',
            side === 'SELL'
              ? 'border-bear bg-bear/15 text-bear'
              : 'border-border bg-surface/60 text-muted hover:text-text'
          )}
        >
          Satış
        </button>
      </div>

      <div className="mt-3 grid grid-cols-5 gap-1">
        {ORDER_TYPES.map((type) => (
          <button
            key={type.id}
            type="button"
            onClick={() => setOrderType(type.id)}
            className={cn(
              'h-8 rounded border px-1 text-2xs uppercase tracking-wider transition-colors',
              orderType === type.id
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border bg-surface/50 text-muted hover:text-text'
            )}
          >
            {type.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between text-2xs uppercase tracking-wider text-muted">
        <span>Kullanılabilir USDT</span>
        <span className="font-mono text-amber-400">-</span>
      </div>

      <div className="mt-3 space-y-3">
        <PanelField label="Fiyat (USDT)" hint={marketPrice ? `MKT: ${formatPrice(marketPrice)}` : undefined}>
          <Input
            value={orderType === 'MARKET' ? formatPrice(marketPrice) : price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={orderType === 'MARKET'}
            inputMode="decimal"
            className="font-mono"
            placeholder="0.00"
          />
        </PanelField>

        <PanelField label={`Miktar (${symbolBase})`}>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="font-mono"
            placeholder="0.000000"
          />
        </PanelField>

        <div className="grid grid-cols-5 gap-1">
          {[10, 25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => applyPercent(pct)}
              className="h-8 rounded border border-border bg-surface/50 text-2xs font-mono text-muted hover:text-text"
            >
              {pct}%
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <PanelField label="TP fiyatı">
            <Input
              value={tpPrice}
              onChange={(e) => setTpPrice(e.target.value)}
              inputMode="decimal"
              className="font-mono"
              placeholder="Opsiyonel"
            />
          </PanelField>
          <PanelField label="SL fiyatı">
            <Input
              value={slPrice}
              onChange={(e) => setSlPrice(e.target.value)}
              inputMode="decimal"
              className="font-mono"
              placeholder="Opsiyonel"
            />
          </PanelField>
        </div>
      </div>

      <div className="mt-4 rounded border border-border bg-surface/70 p-3 text-xs">
        <SummaryLine label="İşlem tutarı" value={`$${formatPrice(notional)}`} />
        <SummaryLine label="Tahmini ücret (0.1%)" value={`$${formatPrice(estimatedFee)}`} />
        <SummaryLine label="Slippage" value="~$0.00" />
      </div>

      <Button
        type="button"
        variant={side === 'BUY' ? 'bull' : 'bear'}
        onClick={submit}
        className="mt-4 h-12 w-full text-sm uppercase tracking-[0.35em]"
      >
        {side === 'BUY' ? 'Alış emri ver' : 'Satış emri ver'}
      </Button>

      {message && (
        <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-text">
          {message}
        </div>
      )}

      <div className="mt-4 flex justify-between border-t border-border pt-3 text-xs text-muted">
        <span>Açık Emir: <span className="font-mono text-text">0</span></span>
        <span>Pozisyon: <span className="font-mono text-text">0</span></span>
      </div>
    </div>
  );
}

function OrderBookPanel(): JSX.Element {
  const symbol = useAppStore((s) => s.symbol);
  const book = useQuery({
    queryKey: ['orderbook', symbol],
    queryFn: () => marketApi.orderBook(symbol, 20),
    refetchInterval: 1_500,
  });

  if (book.isLoading) return <LoadingPanel label="Defter yukleniyor..." />;
  if (!book.data) return <EmptyPanel label="Defter alinamadi" />;

  const asks = book.data.asks.slice(0, 12).reverse();
  const bids = book.data.bids.slice(0, 12);
  const bestAsk = Number(book.data.asks[0]?.[0] ?? 0);
  const bestBid = Number(book.data.bids[0]?.[0] ?? 0);
  const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : 0;
  const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;
  const spreadPct = mid ? (spread / mid) * 100 : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <DepthHeader />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <DepthRows rows={asks} side="ask" book={book.data} />
        <div className="my-2 rounded border-y border-border bg-surface/80 px-1 py-2">
          <div className="flex items-end justify-between">
            <span className="font-mono text-lg font-semibold tabular-nums text-text">
              {formatPrice(mid || bestBid || bestAsk)}
            </span>
            <span className="pb-1 text-2xs text-muted">
              Spread: ${formatPrice(spread)} ({spreadPct.toFixed(4)}%)
            </span>
          </div>
        </div>
        <DepthRows rows={bids} side="bid" book={book.data} />
      </div>
    </div>
  );
}

function OrderHistoryPanel(): JSX.Element {
  const { data: bots = [] } = useBots();
  const tradeQueries = useQueries({
    queries: bots.map((bot) => ({
      queryKey: ['bots', bot.id, 'trades', 20],
      queryFn: () => botsApi.trades(bot.id, 20),
      refetchInterval: 5_000,
    })),
  });

  const trades = useMemo(() => {
    const botById = new Map(bots.map((bot) => [bot.id, bot]));
    return tradeQueries
      .flatMap((query) => query.data ?? [])
      .map((trade) => ({ trade, bot: botById.get(trade.botId) }))
      .sort((a, b) => b.trade.createdAt - a.trade.createdAt)
      .slice(0, 60);
  }, [bots, tradeQueries]);

  if (!bots.length) return <EmptyPanel label="Kayıtlı bot yok" />;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="grid grid-cols-[70px_1fr_80px] border-b border-border px-3 py-2 text-2xs uppercase tracking-wider text-muted">
        <span>Zaman</span>
        <span>Bot</span>
        <span className="text-right">PnL</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {trades.length === 0 ? (
          <EmptyPanel label="Emir kaydı yok" compact />
        ) : (
          trades.map(({ trade, bot }) => (
            <TradeHistoryRow key={trade.id} trade={trade} bot={bot} />
          ))
        )}
      </div>
    </div>
  );
}

function PositionsPanel({ onSelectBot }: { onSelectBot: (id: string) => void }): JSX.Element {
  const { data: bots = [], isLoading } = useBots();
  const snapshots = useBotSnapshots(bots);

  const positions = useMemo(() => {
    return snapshots
      .map((query, index) => ({
        snap: query.data,
        bot: bots[index],
        position: query.data?.state.position ?? null,
      }))
      .filter((row): row is { snap: BotSnapshot; bot: BotConfig; position: Position } =>
        Boolean(row.snap && row.bot && row.position)
      );
  }, [bots, snapshots]);

  if (isLoading) return <LoadingPanel label="Pozisyonlar yukleniyor..." />;
  if (!positions.length) return <EmptyPanel label="Açık pozisyon yok" />;

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      <div className="space-y-3">
        {positions.map(({ bot, snap, position }) => (
          <button
            key={bot.id}
            type="button"
            onClick={() => onSelectBot(bot.id)}
            className="w-full rounded border border-border bg-surface/70 p-3 text-left transition-colors hover:border-accent/50 hover:bg-surface"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-text">{position.symbol}</div>
                <div className="mt-0.5 font-mono text-2xs text-muted">
                  {position.quantity.toFixed(6)} · {bot.name}
                </div>
              </div>
              <span
                className={cn(
                  'rounded-full border px-3 py-0.5 text-2xs font-semibold uppercase tracking-wider',
                  position.side === 'BUY'
                    ? 'border-bull/40 bg-bull/10 text-bull'
                    : 'border-bear/40 bg-bear/10 text-bear'
                )}
              >
                {position.side === 'BUY' ? 'Long' : 'Short'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <PositionMetric label="Giriş" value={`$${formatPrice(position.entryPrice)}`} />
              <PositionMetric label="PnL" value={`${snap.state.realizedPnlUsd >= 0 ? '+' : ''}$${formatPrice(Math.abs(snap.state.realizedPnlUsd))}`} tone={snap.state.realizedPnlUsd >= 0 ? 'bull' : 'bear'} />
              <PositionMetric label="Stop" value={position.stopLossPrice ? `$${formatPrice(position.stopLossPrice)}` : '-'} tone="bear" />
              <PositionMetric label="TP" value={position.takeProfitPrice ? `$${formatPrice(position.takeProfitPrice)}` : '-'} tone="bull" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function BotsPanel({
  selected,
  onSelect,
  onCreate,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
}): JSX.Element {
  return selected ? (
    <BotDetail botId={selected} onBack={() => onSelect(null)} />
  ) : (
    <BotList selectedId={selected} onSelect={onSelect} onCreate={onCreate} />
  );
}

function useBotSnapshots(bots: BotConfig[]) {
  return useQueries({
    queries: bots.map((bot) => ({
      queryKey: ['bots', bot.id],
      queryFn: () => botsApi.get(bot.id),
      refetchInterval: 5_000,
    })),
  });
}

function DepthHeader(): JSX.Element {
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr] border-b border-border px-3 py-2 text-2xs uppercase tracking-wider text-muted">
      <span>Fiyat</span>
      <span className="text-right">Miktar</span>
      <span className="text-right">Toplam</span>
    </div>
  );
}

function DepthRows({
  rows,
  side,
  book,
}: {
  rows: [string, string][];
  side: 'ask' | 'bid';
  book: OrderBook;
}): JSX.Element {
  const allTotals = [...book.asks, ...book.bids].map(([price, qty]) => Number(price) * Number(qty));
  const maxTotal = Math.max(...allTotals, 1);

  return (
    <div>
      {rows.map(([priceRaw, qtyRaw]) => {
        const price = Number(priceRaw);
        const qty = Number(qtyRaw);
        const total = price * qty;
        const width = Math.max(3, Math.min(100, (total / maxTotal) * 100));
        return (
          <div
            key={`${side}-${priceRaw}-${qtyRaw}`}
            className="relative grid h-6 grid-cols-[1fr_1fr_1fr] items-center overflow-hidden rounded px-1 font-mono text-xs tabular-nums"
          >
            <span
              className={cn(
                'pointer-events-none absolute inset-y-0 right-0 opacity-10',
                side === 'ask' ? 'bg-bear' : 'bg-bull'
              )}
              style={{ width: `${width}%` }}
            />
            <span className={side === 'ask' ? 'text-bear' : 'text-bull'}>{formatPrice(price)}</span>
            <span className="text-right text-text">{qty.toFixed(4)}</span>
            <span className="text-right text-muted">{formatPrice(total)}</span>
          </div>
        );
      })}
    </div>
  );
}

function TradeHistoryRow({ trade, bot }: { trade: Trade; bot?: BotConfig }): JSX.Element {
  const pnl = trade.pnlUsd ?? 0;
  return (
    <div className="grid grid-cols-[70px_1fr_80px] items-center rounded px-2 py-1.5 text-xs hover:bg-surface-2">
      <span className="font-mono text-muted">{formatTimeShort(trade.createdAt)}</span>
      <span className="min-w-0">
        <span className={cn('font-semibold', trade.side === 'BUY' ? 'text-bull' : 'text-bear')}>
          {trade.side}
        </span>
        <span className="ml-1 text-text">{bot?.name ?? trade.symbol}</span>
        <span className="block truncate font-mono text-2xs text-muted">
          {trade.quantity.toFixed(6)} @ {formatPrice(trade.price)}
        </span>
      </span>
      <span className={cn('text-right font-mono tabular-nums', pnl > 0 ? 'text-bull' : pnl < 0 ? 'text-bear' : 'text-muted')}>
        {trade.pnlUsd === undefined ? '-' : `${pnl >= 0 ? '+' : ''}$${formatPrice(Math.abs(pnl))}`}
      </span>
    </div>
  );
}

function PositionMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'bull' | 'bear';
}): JSX.Element {
  return (
    <div className="rounded bg-bg/40 px-2 py-1.5">
      <div className="text-2xs uppercase tracking-wider text-muted">{label}</div>
      <div className={cn('font-mono text-sm tabular-nums text-text', tone === 'bull' && 'text-bull', tone === 'bear' && 'text-bear')}>
        {value}
      </div>
    </div>
  );
}

function PanelField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-2xs uppercase tracking-wider text-muted">
        <span>{label}</span>
        {hint && <span className="font-mono text-text">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-text">{value}</span>
    </div>
  );
}

function LoadingPanel({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
      <Loader2 size={14} className="animate-spin" />
      {label}
    </div>
  );
}

function EmptyPanel({ label, compact }: { label: string; compact?: boolean }): JSX.Element {
  return (
    <div className={cn('flex items-center justify-center text-center text-sm text-muted', compact ? 'py-10' : 'h-full')}>
      {label}
    </div>
  );
}
