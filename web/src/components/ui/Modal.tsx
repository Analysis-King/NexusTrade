import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps): JSX.Element | null {
  // ESC ile kapat
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          'panel w-full max-w-lg max-h-[85vh] flex flex-col',
          'shadow-2xl',
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="panel-header !text-sm !normal-case !tracking-normal">
            <span className="text-text font-medium">{title}</span>
            <button
              onClick={onClose}
              className="text-muted hover:text-text transition-colors"
              aria-label="Kapat"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="panel-body p-4">{children}</div>
      </div>
    </div>
  );
}
