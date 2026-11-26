/** Fiyat formatla — büyüklüğe göre ondalık sayısı. */
export function formatPrice(n: number | string): string {
  const x = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(x)) return '–';
  if (Math.abs(x) >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(x) >= 1) return x.toFixed(2);
  if (Math.abs(x) >= 0.01) return x.toFixed(4);
  return x.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

/** Dolar tutarı — işaretli: +$12.40, -$165.12, $0.00. */
export function formatSignedUsd(n: number | string): string {
  const x = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(x)) return '–';
  const sign = x > 0 ? '+' : x < 0 ? '-' : '';
  return `${sign}$${formatPrice(Math.abs(x))}`;
}

/** % değişim — işaretli, 2 ondalık. */
export function formatPct(n: number | string): string {
  const x = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(x)) return '–';
  const s = x >= 0 ? '+' : '';
  return `${s}${x.toFixed(2)}%`;
}

/** Hacim/quote volume — k/m/b kısaltması. */
export function formatVolume(n: number | string): string {
  const x = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(2)}K`;
  return x.toFixed(2);
}

/** Unix ms → "12:34:56" */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour12: false });
}

/** Unix ms → "12:34" */
export function formatTimeShort(ts: number): string {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
