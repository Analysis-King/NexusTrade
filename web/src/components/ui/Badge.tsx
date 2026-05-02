import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'default' | 'bull' | 'bear' | 'muted' | 'accent' | 'warning';

const classes: Record<Variant, string> = {
  default: 'bg-surface-2 text-text border-border',
  bull:    'bg-bull/10 text-bull border-bull/30',
  bear:    'bg-bear/10 text-bear border-bear/30',
  muted:   'bg-surface-2 text-muted border-border',
  accent:  'bg-accent/10 text-accent border-accent/30',
  warning: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
};

export function Badge({
  variant = 'default',
  children,
  className,
}: {
  variant?: Variant;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-2xs uppercase tracking-wide font-medium border',
        classes[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
