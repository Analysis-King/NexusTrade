/**
 * NexusTrade — kök uygulama.
 *
 * Layout'u kurar ve aktif tab/symbol picker state'ini tutar.
 * Daha karmaşık UI state Zustand'a alınacak; şimdilik bunlar yerel.
 */

import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { TopBar } from '@/components/layout/TopBar';
import { Toolbar } from '@/components/layout/Toolbar';
import { TabRail, type TabId } from '@/components/layout/TabRail';
import { SidePanel } from '@/components/layout/SidePanel';
import { SymbolPicker } from '@/components/layout/SymbolPicker';
import { Chart } from '@/components/chart/Chart';
import { useBotEventSync } from '@/hooks/useBots';

export default function App(): JSX.Element {
  // Bot olaylarini (WS) tek noktadan React Query cache'ine yansit.
  useBotEventSync();
  const [activeTab, setActiveTab] = useState<TabId | null>('trading');
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
      <AppShell
        topBar={<TopBar onOpenSymbolPicker={() => setPickerOpen(true)} />}
        toolbar={<Toolbar />}
        center={<Chart />}
        sidePanel={activeTab ? <SidePanel tab={activeTab} /> : null}
        tabRail={<TabRail activeTab={activeTab} onSelect={setActiveTab} />}
      />
      <SymbolPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </>
  );
}
