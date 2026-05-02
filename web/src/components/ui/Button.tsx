import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'default' | 'primary' | 'ghost' | 'bull' | 'bear' | 'danger';
type Size = 'sm' | 'md' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  default: 'bg-surface-2 text-text hover:bg-border border border-border',
  primary: 'bg-accent text-white hover:bg-accent/90',
  ghost:   'bg-transparent text-muted hover:bg-surface-2 hover:text-text',
  bull:    'bg-bull text-white hover:bg-bull/90',
  bear:    'bg-bear text-white hover:bg-bear/90',
  danger:  'bg-bear/10 text-bear hover:bg-bear/20 border border-bear/30',
};

const sizeClasses: Record<Size, string> = {
  sm:   'h-7 px-2.5 text-xs',
  md:   'h-9 px-4 text-sm',
  icon: 'h-8 w-8 p-0',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'default', size = 'md', className, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded font-medium',
        'transition-colors disabled:opacity-50 disabled:pointer-events-none',
        'focus:outline-none focus:ring-1 focus:ring-accent focus:ring-offset-0',
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = 'Button';
