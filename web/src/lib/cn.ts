import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind className'leri merge eder (çakışan utility'leri sonuncu kazansın). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
