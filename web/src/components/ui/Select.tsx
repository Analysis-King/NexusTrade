import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-9 w-full rounded border border-muted/60 bg-surface px-3 text-sm text-white',
        '[&>option]:bg-surface [&>option]:text-white',
        'focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent',
        'disabled:opacity-50',
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = 'Select';
