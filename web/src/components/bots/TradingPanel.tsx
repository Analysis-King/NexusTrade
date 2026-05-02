/**
 * Trading paneli (sağda "İşlemler" tab içeriği).
 *
 * İki görünüm: liste / detay. Bir botu seçince detaya geçer.
 */

import { useState } from 'react';
import { BotList } from './BotList';
import { BotDetail } from './BotDetail';
import { CreateBotModal } from './CreateBotModal';

export function TradingPanel(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      {selected ? (
        <BotDetail botId={selected} onBack={() => setSelected(null)} />
      ) : (
        <BotList
          selectedId={null}
          onSelect={setSelected}
          onCreate={() => setCreateOpen(true)}
        />
      )}

      <CreateBotModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => setSelected(id)}
      />
    </>
  );
}
