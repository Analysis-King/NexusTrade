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

import type { ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  toolbar: ReactNode;
  center: ReactNode;
  sidePanel: ReactNode | null;
  tabRail: ReactNode;
}

export function AppShell({
  topBar,
  toolbar,
  center,
  sidePanel,
  tabRail,
}: AppShellProps): JSX.Element {
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
          <div className="w-80 flex-shrink-0 border-l border-border bg-bg flex flex-col overflow-hidden">
            {sidePanel}
          </div>
        )}

        {/* Sağ tab rail */}
        <div className="w-11 flex-shrink-0 border-l border-border bg-surface">
          {tabRail}
        </div>
      </div>
    </div>
  );
}
