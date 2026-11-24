/**
 * Ana layout — TradingView referansı.
 *
 *   Üst bar (44px)                     ← TopBar
 *   ┌────┬────────────────────┬─────┬────┐
 *   │ 44 │   Chart + sub      │ 320 │ 44 │
 *   │ Tb │                    │ Pn  │ Rl │
 *   │    │                    │     │    │
 *   └────┴────────────────────┴─────┴────┘
 *     ↑           ↑              ↑     ↑
 *     Tools      Center        Side   Rail
 *
 * - Sağ taraf 2 parça: dar TabRail (her zaman görünür) + geniş SidePanel (collapsible)
 * - SidePanel kapalıyken sadece TabRail kalır, chart genişler
 */

import { useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  toolbar: ReactNode;
  center: ReactNode;
  sidePanel: ReactNode | null;
  tabRail: ReactNode;
}

const SIDE_PANEL_WIDTH_KEY = 'nexustrade.sidePanelWidth';
const DEFAULT_SIDE_PANEL_WIDTH = 320;
const MIN_SIDE_PANEL_WIDTH = 260;
const MAX_SIDE_PANEL_WIDTH = 760;

function clampSidePanelWidth(width: number): number {
  const viewportLimit = typeof window === 'undefined'
    ? MAX_SIDE_PANEL_WIDTH
    : Math.max(MIN_SIDE_PANEL_WIDTH, window.innerWidth - 420);
  const maxWidth = Math.min(MAX_SIDE_PANEL_WIDTH, viewportLimit);
  const normalized = Number.isFinite(width) ? width : DEFAULT_SIDE_PANEL_WIDTH;
  return Math.min(maxWidth, Math.max(MIN_SIDE_PANEL_WIDTH, normalized));
}

function initialSidePanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDE_PANEL_WIDTH;
  return clampSidePanelWidth(Number(window.localStorage.getItem(SIDE_PANEL_WIDTH_KEY)));
}

export function AppShell({
  topBar,
  toolbar,
  center,
  sidePanel,
  tabRail,
}: AppShellProps): JSX.Element {
  const [sidePanelWidth, setSidePanelWidth] = useState(initialSidePanelWidth);

  useEffect(() => {
    window.localStorage.setItem(SIDE_PANEL_WIDTH_KEY, String(Math.round(sidePanelWidth)));
  }, [sidePanelWidth]);

  useEffect(() => {
    const onResize = () => setSidePanelWidth((width) => clampSidePanelWidth(width));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const resizeSidePanel = (nextWidth: number) => {
    setSidePanelWidth(clampSidePanelWidth(nextWidth));
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!sidePanel) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidePanelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onPointerMove = (moveEvent: globalThis.PointerEvent) => {
      resizeSidePanel(startWidth + startX - moveEvent.clientX);
    };
    const stopResize = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  };

  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      resizeSidePanel(sidePanelWidth + 24);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      resizeSidePanel(sidePanelWidth - 24);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resizeSidePanel(MIN_SIDE_PANEL_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      resizeSidePanel(MAX_SIDE_PANEL_WIDTH);
    }
  };

  return (
    <div className="h-screen w-screen overflow-hidden bg-bg text-text flex flex-col">
      {/* Üst bar */}
      <div className="h-11 flex-shrink-0 border-b border-border bg-surface flex items-center">
        {topBar}
      </div>

      {/* Alt: 4 sütun */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sol toolbar */}
        <div className="w-11 flex-shrink-0 border-r border-border bg-surface">
          {toolbar}
        </div>

        {/* Orta - chart + alt paneller */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {center}
        </main>

        {/* Sağ side panel (varsa) */}
        {sidePanel && (
          <>
            <div
              role="separator"
              aria-label="Sag panel genisligi"
              aria-orientation="vertical"
              aria-valuemin={MIN_SIDE_PANEL_WIDTH}
              aria-valuemax={MAX_SIDE_PANEL_WIDTH}
              aria-valuenow={Math.round(sidePanelWidth)}
              tabIndex={0}
              title="Paneli genislet veya daralt"
              className="group relative w-2 flex-shrink-0 cursor-col-resize touch-none bg-bg outline-none focus:bg-accent/10"
              onPointerDown={startResize}
              onKeyDown={onResizeKeyDown}
            >
              <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-accent group-focus:bg-accent" />
              <div className="pointer-events-none absolute inset-y-0 left-0 right-0 opacity-0 transition-opacity group-hover:bg-accent group-hover:opacity-10 group-focus:bg-accent group-focus:opacity-10" />
            </div>
            <div
              className="flex-shrink-0 border-l border-border bg-bg flex flex-col overflow-hidden"
              style={{ width: sidePanelWidth }}
            >
              {sidePanel}
            </div>
          </>
        )}

        {/* Sağ tab rail */}
        <div className="w-11 flex-shrink-0 border-l border-border bg-surface">
          {tabRail}
        </div>
      </div>
    </div>
  );
}
