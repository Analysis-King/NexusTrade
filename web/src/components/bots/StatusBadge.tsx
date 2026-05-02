import { Badge } from '@/components/ui/Badge';
import type { BotStatus } from '@/types/api';

const map: Record<BotStatus, { variant: 'bull' | 'bear' | 'muted' | 'warning' | 'accent'; label: string }> = {
  idle:    { variant: 'muted',   label: 'Hazır' },
  running: { variant: 'bull',    label: 'Çalışıyor' },
  paused:  { variant: 'warning', label: 'Duraklatıldı' },
  stopped: { variant: 'muted',   label: 'Durdu' },
  error:   { variant: 'bear',    label: 'Hata' },
};

export function StatusBadge({ status }: { status: BotStatus }): JSX.Element {
  const { variant, label } = map[status];
  return <Badge variant={variant}>{label}</Badge>;
}
