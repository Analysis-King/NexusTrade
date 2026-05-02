/**
 * Sağda açılan side panel.
 *
 * Aktif tab'a göre içerik render eder. İlk versiyonda sadece İşlemler ve Portföy
 * gerçek; diğerleri "Yakında" placeholder.
 */

import { TradingPanel } from '@/components/bots/TradingPanel';
import { PortfolioPanel } from '@/components/bots/PortfolioPanel';
import type { TabId } from './TabRail';

const TAB_TITLES: Record<TabId, string> = {
  trading:   'İşlemler',
  portfolio: 'Portföy',
  alerts:    'Alarmlar',
  layers:    'Katmanlar',
  watcher:   'Takipçi',
};

export function SidePanel({ tab }: { tab: TabId }): JSX.Element {
  // Trading ve Portfolio kendi başlıklarını/header'larını yönetir
  if (tab === 'trading') return <TradingPanel />;
  if (tab === 'portfolio') {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="panel-header !text-sm !normal-case !tracking-normal">
          <span className="text-text font-medium">Portföy</span>
        </div>
        <div className="flex-1 overflow-hidden">
          <PortfolioPanel />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="panel-header !text-sm !normal-case !tracking-normal">
        <span className="text-text font-medium">{TAB_TITLES[tab]}</span>
      </div>
      <div className="panel-body p-3">
        <ComingSoon label={TAB_TITLES[tab]} />
      </div>
    </div>
  );
}

function ComingSoon({ label }: { label: string }): JSX.Element {
  return (
    <div className="text-sm text-muted text-center py-12">
      <div className="text-2xs uppercase tracking-wider mb-2">Yakında</div>
      <div className="text-text font-medium">{label}</div>
      <div className="mt-2 text-xs">Bu özellik geliştirme aşamasında.</div>
    </div>
  );
}
