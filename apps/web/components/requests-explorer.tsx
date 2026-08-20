'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ListTree, Search, ShieldAlert } from 'lucide-react';
import { fetchLogs, fetchStats, type Facets, type LogListRow } from '../lib/api';
import { filtersToQuery, useUrlFilters } from '../lib/hooks';
import { EmptyState, LiveDot, StatusBadge } from './ui';
import { FilterBar } from './filter-bar';

const DEFAULTS = { window: '1440', provider: '', model: '', status: '', stream: '', tenant: '', q: '', flagged: '', conversationId: '' };
const KEYS = Object.keys(DEFAULTS);
const fmtUsd = (n: number | null) => (n == null ? '—' : `$${n.toFixed(4)}`);

export default function RequestsExplorer() {
  const router = useRouter();
  const { filters, set, reset, active } = useUrlFilters(DEFAULTS);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [rows, setRows] = useState<LogListRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => { fetchStats.facets().then(setFacets).catch(() => undefined); }, []);

  const load = useCallback(async (append: boolean, before?: string) => {
    const seq = ++seqRef.current;
    setLoading(true); setNotice(null);
    try {
      const params: Record<string, string> = {};
      for (const k of KEYS) if (filters[k]) params[k] = filters[k]!;
      if (before) params.before = before;
      const res = await fetchLogs(params);
      if (seqRef.current !== seq) return;
      setRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
      setNextBefore(res.nextBefore);
    } catch { if (seqRef.current === seq) setNotice('failed to load — is the api up?'); }
    finally { if (seqRef.current === seq) setLoading(false); }
  }, [filters]);

  const qs = useMemo(() => filtersToQuery(filters, KEYS), [filters]);
  useEffect(() => { void load(false); /* eslint-disable-next-line */ }, [qs]);

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-20 border-b border-carbon-800 bg-carbon-950/70 px-5 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <ListTree className="h-5 w-5 text-signal" />
          <h1 className="font-display text-base font-semibold tracking-tight text-ink">Requests</h1>
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint"><LiveDot color="#4d9bff" /> {rows.length} shown{loading ? ' · loading' : ''}</span>
          {filters.conversationId && <button onClick={() => set('conversationId', '')} className="chip cursor-pointer border-signal/30 text-signal">conversation {filters.conversationId.slice(0, 8)}… ✕</button>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FilterBar filters={filters} set={set} reset={reset} active={active} facets={facets} extra={
            <button onClick={() => set('flagged', filters.flagged ? '' : 'true')}
              className={`chip cursor-pointer ${filters.flagged ? 'border-warn/40 text-warn' : ''}`}>
              <ShieldAlert className="h-3 w-3" /> flagged only
            </button>
          } />
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input value={filters.q ?? ''} onChange={(e) => set('q', e.target.value)} placeholder="Search input previews…" className="input w-64 pl-8" />
          </div>
        </div>
        {notice && <div className="mt-2 text-xs text-danger">{notice}</div>}
      </header>

      <div className="p-5">
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-ink-faint">
                <tr className="border-b border-carbon-800">
                  {['time', 'model', 'status', 'stream', 'latency', 'TTFT', 'tokens', 'cost', 'input'].map((h) => <th key={h} className="px-3 py-2.5 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {rows.map((r) => (
                    <motion.tr key={r.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      onClick={() => router.push(`/requests/${r.id}`)}
                      className="cursor-pointer border-b border-carbon-800/60 transition-colors hover:bg-carbon-800/50">
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-ink-faint">{new Date(r.requestStartedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">{r.provider}/{r.model}</td>
                      <td className="px-3 py-2.5"><StatusBadge status={r.status} /></td>
                      <td className="px-3 py-2.5 font-mono text-ink-faint">{r.isStream ? 'yes' : 'no'}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-ink-muted">{r.latencyMs ?? '—'}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-ink-muted">{r.ttfbMs ?? '—'}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-ink-muted">{r.promptTokens ?? '—'}/{r.completionTokens ?? '—'}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-live">{fmtUsd(r.estCostUsd)}</td>
                      <td className="max-w-sm truncate px-3 py-2.5 text-ink-muted">
                        {r.flaggedInjection && <ShieldAlert className="mr-1 inline h-3.5 w-3.5 text-warn" />}{r.inputPreview ?? '—'}
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
            {rows.length === 0 && !loading && <EmptyState label="no requests match these filters" />}
          </div>
          <div className="flex items-center justify-between border-t border-carbon-800 px-3 py-2 text-[11px] text-ink-faint">
            <span>{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
            {nextBefore && <button onClick={() => void load(true, nextBefore)} className="btn-ghost py-1 text-[11px]">Load older</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
