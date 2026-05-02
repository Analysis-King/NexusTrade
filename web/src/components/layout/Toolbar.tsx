/**
 * Sol toolbar — drawing araçları.
 *
 * Hepsi şimdilik placeholder. Drawing engine ileride.
 * TradingView estetiğini koruyalım, butonlar tıklanabilir ama bir şey yapmıyor.
 */

import { useState } from 'react';
import {
  MousePointer2,
  TrendingUp,
  Minus,
  Triangle,
  Type,
  Ruler,
  Smile,
  Magnet,
  Lock,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface Tool {
  id: string;
  icon: LucideIcon;
  label: string;
}

const TOOLS: Tool[] = [
  { id: 'cursor', icon: MousePointer2, label: 'İmleç' },
  { id: 'trendline', icon: TrendingUp, label: 'Trend çizgisi' },
  { id: 'horizontal', icon: Minus, label: 'Yatay çizgi' },
  { id: 'shape', icon: Triangle, label: 'Şekil' },
  { id: 'text', icon: Type, label: 'Metin' },
  { id: 'ruler', icon: Ruler, label: 'Cetvel' },
  { id: 'emoji', icon: Smile, label: 'Emoji' },
];

const BOTTOM_TOOLS: Tool[] = [
  { id: 'magnet', icon: Magnet, label: 'Mıknatıs' },
  { id: 'lock', icon: Lock, label: 'Kilitle' },
  { id: 'trash', icon: Trash2, label: 'Tümünü sil' },
];

export function Toolbar(): JSX.Element {
  const [active, setActive] = useState('cursor');

  return (
    <div className="h-full flex flex-col items-center py-1 gap-0.5">
      {TOOLS.map((tool) => (
        <ToolButton
          key={tool.id}
          tool={tool}
          active={active === tool.id}
          onClick={() => setActive(tool.id)}
        />
      ))}

      <div className="flex-1" />

      <div className="w-6 h-px bg-border my-1" />
      {BOTTOM_TOOLS.map((tool) => (
        <ToolButton
          key={tool.id}
          tool={tool}
          active={false}
          onClick={() => {
            // Placeholder
          }}
        />
      ))}
    </div>
  );
}

function ToolButton({
  tool,
  active,
  onClick,
}: {
  tool: Tool;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  const Icon = tool.icon;
  return (
    <button
      title={`${tool.label} (yakında)`}
      onClick={onClick}
      className={cn(
        'w-8 h-8 flex items-center justify-center rounded transition-colors',
        active
          ? 'bg-accent/20 text-accent'
          : 'text-muted hover:text-text hover:bg-surface-2'
      )}
    >
      <Icon size={15} />
    </button>
  );
}
