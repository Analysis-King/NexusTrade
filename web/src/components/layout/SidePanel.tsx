/**
 * Sağda açılan side panel.
 *
 * Aktif tab'a göre içerik render eder. İlk versiyonda sadece İşlemler ve Portföy
 * gerçek; diğerleri "Yakında" placeholder.
 *
 * Ad
 */

import type { TabId } from './TabRail';

const TAB_TITLES: Record<TabId, string> = {
  trading:   'İşlemler',
  portfolio: 'Portföy',
  alerts:    'Alarmlar',
  layers:    'Katmanlar',
  watcher:   'Takipçi',
};

export function SidePanel({ tab }: { tab: TabId }): JSX.Element {
  return (
    <div className="h-full flex flex-col">
      <div className="panel-header !text-sm !normal-case !tracking-normal">
        <span className="text-text font-medium">{TAB_TITLES[tab]}</span>
      </div>
      <div className="panel-body p-3">
        {tab === 'trading' && <TradingPlaceholder />}
        {tab === 'portfolio' && <PortfolioPlaceholder />}
        {(tab === 'alerts' || tab === 'layers' || tab === 'watcher') && (
          <ComingSoon label={TAB_TITLES[tab]} />
        )}
      </div>
    </div>
  );
}

function TradingPlaceholder(): JSX.Element {
  return (
    <div className="text-sm text-muted">
      <div className="rounded border border-dashed border-border p-4 text-center">
        Bot listesi ve yeni bot oluşturma sıradaki adımda gelecek.
      </div>
    </div>
  );
}

function PortfolioPlaceholder(): JSX.Element {
  return (
    <div className="text-sm text-muted">
      <div className="rounded border border-dashed border-border p-4 text-center">
        Bakiye ve açık pozisyonlar sıradaki adımda gelecek.
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
