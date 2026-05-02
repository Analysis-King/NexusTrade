import type { Config } from 'tailwindcss';

/**
 * TradingView'i referans alarak çıkardığım koyu palet.
 * Resmi marka renkleri değil — kendi tarzımız ama o estetiğe sadık.
 *
 * Tüm renkler CSS değişkenleri üzerinden, ileride tema switcher kolay olsun.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Yüzeyler
        bg:        'rgb(var(--bg) / <alpha-value>)',         // ana arka plan
        surface:   'rgb(var(--surface) / <alpha-value>)',    // panel
        surface2:  'rgb(var(--surface-2) / <alpha-value>)',  // hover, alt panel
        border:    'rgb(var(--border) / <alpha-value>)',
        // Metin
        text:      'rgb(var(--text) / <alpha-value>)',
        muted:     'rgb(var(--muted) / <alpha-value>)',
        // Vurgular
        accent:    'rgb(var(--accent) / <alpha-value>)',     // marka mavi
        // Trading semantik
        bull:      'rgb(var(--bull) / <alpha-value>)',       // yeşil
        bear:      'rgb(var(--bear) / <alpha-value>)',       // kırmızı
      },
      fontFamily: {
        sans: ['"Inter"', '"SF Pro Display"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px' }],
      },
      boxShadow: {
        panel: '0 1px 0 rgb(255 255 255 / 0.04) inset',
      },
    },
  },
  plugins: [],
} satisfies Config;
