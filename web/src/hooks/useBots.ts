/**
 * Bot ile ilgili React Query hook'ları.
 *
 * - Liste, detay sorguları
 * - Mutation'lar: create, delete, start, stop, pause, resume
 * - WS bot-event'lerini dinleyip cache'i otomatik invalidate eder
 *   (bot state değişince UI anında günceller)
 */

import { useEffect } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
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

/** Tüm bot'ların listesi. WS event'lerinde otomatik refetch. */
export function useBots() {
  const qc = useQueryClient();

  // WS bot-event geldiğinde liste ve ilgili detayı invalidate et
  useEffect(() => {
    const unsub = ws.onBotEvent((evt) => {
      qc.invalidateQueries({ queryKey: KEY.list });
      if (evt.botId) {
        qc.invalidateQueries({ queryKey: KEY.detail(evt.botId) });
        qc.invalidateQueries({ queryKey: KEY.trades(evt.botId) });
      }
    });
    return unsub;
  }, [qc]);

  return useQuery({
    queryKey: KEY.list,
    queryFn: () => botsApi.list(),
    refetchInterval: 30_000, // ek güvenlik — WS kaçırırsa
  });
}

/** Tek bir bot detayı (snapshot — config + state + position). */
export function useBot(id: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!id) return undefined;
    const unsub = ws.onBotEvent((evt) => {
      if (evt.botId !== id) return;
      qc.invalidateQueries({ queryKey: KEY.list });
      qc.invalidateQueries({ queryKey: KEY.detail(id) });
      qc.invalidateQueries({ queryKey: KEY.trades(id) });
    });
    return unsub;
  }, [id, qc]);

  return useQuery({
    queryKey: id ? KEY.detail(id) : ['bots', 'null'],
    queryFn: () => botsApi.get(id!),
    enabled: !!id,
    refetchInterval: 5_000,
  });
}

/** Bot trade history. */
export function useBotTrades(id: string | null, limit = 50) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!id) return undefined;
    const unsub = ws.onBotEvent((evt) => {
      if (evt.botId !== id) return;
      qc.invalidateQueries({ queryKey: KEY.trades(id) });
      qc.invalidateQueries({ queryKey: KEY.detail(id) });
    });
    return unsub;
  }, [id, qc]);

  return useQuery({
    queryKey: id ? [...KEY.trades(id), limit] : ['bots', 'null'],
    queryFn: () => botsApi.trades(id!, limit),
    enabled: !!id,
    refetchInterval: id ? 5_000 : false,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY.list }),
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
