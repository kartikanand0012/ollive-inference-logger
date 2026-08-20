'use client';
import { motion } from 'framer-motion';
import { useAnimatedNumber } from '../lib/hooks';
import type { ReactNode } from 'react';

export const STATUS = {
  success: { color: '#43c493', label: 'success' },
  error: { color: '#ef7a63', label: 'error' },
  cancelled: { color: '#e0a43a', label: 'cancelled' },
} as const;

export function LiveDot({ color = '#43c493' }: { color?: string }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-pulse-dot rounded-full" style={{ background: color }} />
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

export function StatusBadge({ status }: { status: keyof typeof STATUS }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color: s.color, background: `${s.color}1a` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

export function Card({ title, right, children, className = '' }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={`card p-4 ${className}`}
    >
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          {title && <h2 className="font-display text-sm font-medium tracking-tight text-ink">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </motion.div>
  );
}

const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? Number(n.toFixed(0)).toLocaleString() : n % 1 === 0 ? String(n) : n.toFixed(1);

export function StatCard({
  label, value, unit, accent, suffix, prefix, onClick, delay = 0,
}: {
  label: string; value: number | null; unit?: string; accent?: string; suffix?: string; prefix?: string;
  onClick?: () => void; delay?: number;
}) {
  const animated = useAnimatedNumber(value ?? 0);
  const display = value == null ? '—' : `${prefix ?? ''}${fmt(animated)}${suffix ?? ''}`;
  return (
    <motion.button
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      onClick={onClick}
      disabled={!onClick}
      className={`card ${onClick ? 'card-hover cursor-pointer' : ''} group relative overflow-hidden px-4 py-3 text-left`}
    >
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-semibold tabular-nums text-ink" style={accent ? { color: accent } : undefined}>{display}</span>
        {unit && <span className="text-xs text-ink-muted">{unit}</span>}
      </div>
      {accent && <div className="absolute inset-x-0 bottom-0 h-0.5" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />}
    </motion.button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-carbon-700 bg-carbon-900 p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`relative rounded-md px-3 py-1 text-xs font-medium transition-colors ${value === o.value ? 'text-carbon-950' : 'text-ink-muted hover:text-ink'}`}>
          {value === o.value && <motion.span layoutId="seg" className="absolute inset-0 rounded-md bg-signal" transition={{ type: 'spring', stiffness: 400, damping: 32 }} />}
          <span className="relative z-10">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Select({ value, onChange, options, placeholder }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input cursor-pointer appearance-none pr-8 [background-image:url('data:image/svg+xml;utf8,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2212%22%20height=%2212%22%20fill=%22none%22%20stroke=%22%23a8a49b%22%20stroke-width=%222%22%3E%3Cpath%20d=%22M2%204l4%204%204-4%22/%3E%3C/svg%3E')] bg-[right_0.6rem_center] bg-no-repeat">
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function EmptyState({ label = 'no data in this window' }: { label?: string }) {
  return <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-xs text-ink-faint">
    <div className="h-8 w-8 rounded-full border border-dashed border-carbon-600" />
    {label}
  </div>;
}

export const CHART = {
  categorical: ['#4d9bff', '#e0a43a', '#43c493', '#d98a5c', '#b98be0'],
  seq: { p50: '#8fc0ff', p95: '#4d9bff', p99: '#2f6fd0' },
  danger: '#ef7a63',
  grid: '#242320',
  tick: { fill: '#6f6b62', fontSize: 11, fontFamily: 'var(--font-mono)' },
  tooltip: { backgroundColor: '#161615', border: '1px solid #3a3835', borderRadius: 10, fontSize: 12, boxShadow: '0 8px 24px -12px rgba(0,0,0,0.8)' },
};
