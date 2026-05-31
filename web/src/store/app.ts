/**
 * App-wide UI state.
 *
 * Sadece global state — fetch'ten gelen veriler React Query'de.
 * Aktif sembol, timeframe, tema gibi UI tercihleri burada.
 */

import { create } from 'zustand';

export type Interval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

export type DrawingMode = 'hidden' | 'latest' | 'all';

interface AppState {
  symbol: string;
  interval: Interval;
  selectedBotId: string | null;
  drawingMode: DrawingMode;
  activeIndicatorIds: string[];
  setSymbol: (s: string) => void;
  setInterval: (i: Interval) => void;
  setSelectedBotId: (id: string | null) => void;
  setDrawingMode: (mode: DrawingMode) => void;
  toggleIndicator: (id: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  symbol: 'BTCUSDT',
  interval: '15m',
  selectedBotId: null,
  drawingMode: 'latest',
  activeIndicatorIds: [],
  setSymbol: (symbol) => set({ symbol: symbol.toUpperCase() }),
  setInterval: (interval) => set({ interval }),
  setSelectedBotId: (selectedBotId) => set({ selectedBotId }),
  setDrawingMode: (drawingMode) => set({ drawingMode }),
  toggleIndicator: (id) =>
    set((state) => ({
      activeIndicatorIds: state.activeIndicatorIds.includes(id)
        ? state.activeIndicatorIds.filter((item) => item !== id)
        : [...state.activeIndicatorIds, id],
    })),
}));
