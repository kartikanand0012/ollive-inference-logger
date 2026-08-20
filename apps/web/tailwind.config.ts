import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm-carbon surfaces (not cold slate) — a distinctive, layered dark.
        carbon: {
          950: '#0c0c0b',
          900: '#111110',
          850: '#161615',
          800: '#1c1b19',
          750: '#242320',
          700: '#2d2b28',
          600: '#3a3835',
        },
        ink: { DEFAULT: '#ece9e3', muted: '#a8a49b', faint: '#6f6b62' },
        // Signal accent (electric blue) + a live/health green.
        signal: { DEFAULT: '#4d9bff', dim: '#2f6fd0', glow: '#7db4ff' },
        live: '#43c493',
        warn: '#e0a43a',
        danger: '#ef7a63',
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        elevate: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.7)',
        glow: '0 0 0 1px rgba(77,155,255,0.25), 0 0 24px -6px rgba(77,155,255,0.35)',
      },
      keyframes: {
        'pulse-dot': {
          '0%,100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.4', transform: 'scale(0.85)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'caret-blink': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0' } },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        caret: 'caret-blink 1s step-end infinite',
      },
    },
  },
  plugins: [],
};
export default config;
