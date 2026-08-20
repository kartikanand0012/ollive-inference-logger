'use client';
import { memo } from 'react';
import { motion } from 'framer-motion';
import { SlidersHorizontal, X } from 'lucide-react';
import { Segmented, Select } from './ui';
import type { Facets } from '../lib/api';
import type { Filters } from '../lib/hooks';

const WINDOWS = [
  { value: '60', label: '1h' }, { value: '360', label: '6h' },
  { value: '1440', label: '24h' }, { value: '10080', label: '7d' },
];

export const FilterBar = memo(function FilterBar({
  filters, set, reset, active, facets, extra,
}: {
  filters: Filters; set: (k: string, v: string) => void; reset: () => void; active: number;
  facets: Facets | null; extra?: React.ReactNode;
}) {
  const opts = (arr: string[] | undefined) => (arr ?? []).map((v) => ({ value: v, label: v }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented value={filters.window ?? '1440'} options={WINDOWS} onChange={(v) => set('window', v)} />
      <div className="mx-1 h-5 w-px bg-carbon-700" />
      <Select value={filters.provider ?? ''} onChange={(v) => { set('provider', v); set('model', ''); }} options={opts(facets?.provider)} placeholder="all providers" />
      <Select value={filters.model ?? ''} onChange={(v) => set('model', v)} options={opts(facets?.model)} placeholder="all models" />
      <Select value={filters.status ?? ''} onChange={(v) => set('status', v)} options={[{ value: 'success', label: 'success' }, { value: 'error', label: 'error' }, { value: 'cancelled', label: 'cancelled' }]} placeholder="any status" />
      <Select value={filters.stream ?? ''} onChange={(v) => set('stream', v)} options={[{ value: 'true', label: 'streamed' }, { value: 'false', label: 'non-stream' }]} placeholder="stream?" />
      {(facets?.tenant?.length ?? 0) > 1 && <Select value={filters.tenant ?? ''} onChange={(v) => set('tenant', v)} options={opts(facets?.tenant)} placeholder="all tenants" />}
      {extra}
      {active > 0 && (
        <motion.button initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
          onClick={reset} className="chip cursor-pointer border-signal/30 text-signal hover:bg-signal/10">
          <SlidersHorizontal className="h-3 w-3" /> {active} filter{active > 1 ? 's' : ''} <X className="h-3 w-3" />
        </motion.button>
      )}
    </div>
  );
});
