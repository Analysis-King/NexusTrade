/**
 * Bot ile ilgili React Query hook'ları.
 *
 * - Liste, detay sorguları
 * - Mutation'lar: create, delete, start, stop, pause, resume
 * - useBotEventSync: WS bot-event'lerini tek yerden dinler ve yalnizca
 *   ilgili botun cache'ini tazeler (App'te bir kez cagrilir)
 *
 * Istek butcesi: backend dakikada sinirli istek kabul eder (RATE_LIMIT_MAX).
 * Guncellemelerin asil kaynagi WS'tir; periyodik yoklama yalnizca WS'in
 * kacirdigi bir seyi yakalamak icin yavas bir yedektir. Her bot icin 5 sn'de
 * bir detay+islem cekmek 17 botta dakikada ~400 istege cikip 429'a yol
 * aciyordu.
 */

import { useEffect } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import {
  botsApi,
  type CreateBotInput,
} from '@/api/endpoints';
import { ws } from '@/api/ws';
import type { BotConfig, BotSnapshot, Trade } from '@/types/api';

const KEY = {
  list: ['bots'] as const,
  detail: (id: string) => ['bots', id] as const,
  trades: (id: string) => ['bots', id, 'trades'] as const,
};

/** Tum botlar icin tutulan detay/islem sorgularinin yedek yoklama araligi. */
export const BOT_FALLBACK_POLL_MS = 30_000;
/** Secili (ekranda acik) tek botun yedek yoklama araligi. */
const SELECTED_BOT_POLL_MS = 15_000;

/** Bot listesindeki durumu (calisiyor/durdu/...) degistiren olaylar. */
const STATUS_EVENTS = new Set(['started', 'stopped', 'paused', 'resumed', 'risk-limit']);
/** Islem gecmisini degistiren olaylar. */
const TRADE_EVENTS = new Set(['position-opened', 'position-closed']);

// Ayni anki birden cok olay calisan istegi iptal edip yenisini acmasin;
// zaten giden istek varsa ona katilinir.
const NO_CANCEL = { cancelRefetch: false } as const;

function statusChanged(qc: QueryClient, botId: string, payload: unknown): boolean {
  const status = (payload as { config?: { status?: unknown } } | null)?.config?.status;
  if (typeof status !== 'string') return false;
  const cached = qc.getQueryData<BotConfig[]>(KEY.list)?.find((bot) => bot.id === botId);
  return !cached || cached.status !== status;
}

/**
 * WS bot-event'lerini cache'e yansitir. Uygulamada bir kez (App) cagrilmali.
 * Her olay yalnizca o botun detayini; pozisyon acilip kapaninca islemlerini;
 * durum degisince de listeyi tazeler.
 */
export function useBotEventSync(): void {
  const qc = useQueryClient();

  useEffect(() => {
    return ws.onBotEvent((evt) => {
      if (!evt.botId) {
        void qc.invalidateQueries({ queryKey: KEY.list, exact: true }, NO_CANCEL);
        return;
      }
      void qc.invalidateQueries({ queryKey: KEY.detail(evt.botId), exact: true }, NO_CANCEL);
      if (TRADE_EVENTS.has(evt.event)) {
        void qc.invalidateQueries({ queryKey: KEY.trades(evt.botId) }, NO_CANCEL);
      }
      if (STATUS_EVENTS.has(evt.event) || statusChanged(qc, evt.botId, evt.payload)) {
        void qc.invalidateQueries({ queryKey: KEY.list, exact: true }, NO_CANCEL);
      }
    });
  }, [qc]);
}

/** Tüm bot'ların listesi. Guncellemeler useBotEventSync ile gelir. */
export function useBots() {
  return useQuery({
    queryKey: KEY.list,
    queryFn: () => botsApi.list(),
    refetchInterval: BOT_FALLBACK_POLL_MS, // ek güvenlik — WS kaçırırsa
  });
}

/** Tek bir bot detayı (snapshot — config + state + position). */
export function useBot(id: string | null) {
  return useQuery({
    queryKey: id ? KEY.detail(id) : ['bots', 'null'],
    queryFn: () => botsApi.get(id!),
    enabled: !!id,
    refetchInterval: SELECTED_BOT_POLL_MS,
  });
}

/** Bot trade history. */
export function useBotTrades(id: string | null, limit = 50) {
  return useQuery({
    queryKey: id ? [...KEY.trades(id), limit] : ['bots', 'null'],
    queryFn: () => botsApi.trades(id!, limit),
    enabled: !!id,
    refetchInterval: id ? SELECTED_BOT_POLL_MS : false,
  });
}

/* ─── Mutations ─────────────────────────────────────── */

export function useCreateBot(): UseMutationResult<BotConfig, Error, CreateBotInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBotInput) => botsApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY.list }),
  });
}

export function useDeleteBot(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => botsApi.delete(id),
    onSuccess: (_, id) => {
      // Silinen botun detay/islem sorgulari 404 almaya devam etmesin.
      qc.removeQueries({ queryKey: KEY.detail(id) });
      return qc.invalidateQueries({ queryKey: KEY.list, exact: true });
    },
  });
}

/** start/stop/pause/resume için ortak helper. */
function useBotAction(
  action: 'start' | 'stop' | 'pause' | 'resume'
): UseMutationResult<BotSnapshot, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => botsApi[action](id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: KEY.list });
      qc.invalidateQueries({ queryKey: KEY.detail(id) });
    },
  });
}

export const useStartBot = () => useBotAction('start');
export const useStopBot = () => useBotAction('stop');
export const usePauseBot = () => useBotAction('pause');
export const useResumeBot = () => useBotAction('resume');

/* Re-export için */
export type { Trade };
