/**
 * Sağ tab rail — TradingView'deki dar ikon sütunu.
 *
 * Her ikon bir tab. Tıklanınca aktif tab değişir, side panel açılır.
 * Aynı ikona tekrar tıklanınca panel kapanır.
 */

import {
  Briefcase,
  Wallet,
  Bell,
  Layers,
  Eye,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';

export type TabId = 'trading' | 'portfolio' | 'alerts' | 'layers' | 'watcher';

interface Tab {
  id: TabId;
  icon: LucideIcon;
  label: string;
  enabled: boolean;
}

const TABS: Tab[] = [
  { id: 'trading',   icon: Briefcase, label: 'İşlemler',  enabled: true },
  { id: 'portfolio', icon: Wallet,    label: 'Portföy',   enabled: true },
  { id: 'alerts',    icon: Bell,      label: 'Alarmlar',  enabled: false },
  { id: 'layers',    icon: Layers,    label: 'Katmanlar', enabled: false },
  { id: 'watcher',   icon: Eye,       label: 'Takipçi',   enabled: false },
];

export function TabRail({
  activeTab,
  onSelect,
}: {
  activeTab: TabId | null;
  onSelect: (id: TabId | null) => void;
}): JSX.Element {
  return (
    <div className="h-full flex flex-col items-center py-1 gap-0.5">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            title={tab.enabled ? tab.label : `${tab.label} (yakında)`}
            disabled={!tab.enabled}
            onClick={() => {
              // Aynısına tıklayınca toggle (kapat)
              onSelect(isActive ? null : tab.id);
            }}
            className={cn(
              'w-8 h-8 flex items-center justify-center rounded transition-colors',
              !tab.enabled && 'opacity-40 cursor-not-allowed',
              isActive
                ? 'bg-accent/20 text-accent'
                : 'text-muted hover:text-text hover:bg-surface-2 disabled:hover:bg-transparent disabled:hover:text-muted'
            )}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
