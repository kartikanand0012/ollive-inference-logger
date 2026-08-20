'use client';

import { Suspense, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Activity, Coins, Gauge, ShieldAlert, Zap, AlertTriangle } from 'lucide-react';
import { fetchStats, type Facets, type ModelRow, type RecentErrorRow, type StatsSummary, type TimeseriesRow } from '../../lib/api';
import { filtersToQuery, usePoll, useUrlFilters } from '../../lib/hooks';
import { Card, CHART, EmptyState, LiveDot, StatCard } from '../../components/ui';
import { FilterBar } from '../../components/filter-bar';

const DEFAULTS = { window: '1440', provider: '', model: '', status: '', stream: '', tenant: '' };
const KEYS = Object.keys(DEFAULTS);
const fmtBucket = (v: string) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : `$${n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`);

// Recharts identifies axis/grid/tooltip by static child type — they MUST be
// inlined as direct children of the chart, never wrapped in a component.
const gridEl = <CartesianGrid stroke={CHART.grid} vertical={false} />;
const xAxis = <XAxis dataKey="label" tick={CHART.tick} tickLine={false} axisLine={{ stroke: CHART.grid }} minTickGap={28} />;
const tooltipStyle = { contentStyle: CHART.tooltip, labelStyle: { color: '#a8a49b' }, itemStyle: { color: '#ece9e3' } };

function DashboardInner() {
  const router = useRouter();
  const { filters, set, reset, active } = useUrlFilters(DEFAULTS);
  const qs = useMemo(() => filtersToQuery(filters, KEYS), [filters]);

  const { data: facets } = usePoll<Facets>(() => fetchStats.facets(), [], 60_000);
  const { data: summary } = usePoll<StatsSummary>(() => fetchStats.summary(qs), [qs]);
  const { data: modelsRes } = usePoll<{ rows: ModelRow[] }>(() => fetchStats.models(qs), [qs]);
  const { data: seriesRes } = usePoll<{ rows: TimeseriesRow[] }>(() => fetchStats.timeseries(qs), [qs]);
  const { data: errRes } = usePoll<{ recent: RecentErrorRow[] }>(() => fetchStats.errors(qs), [qs]);

  const models = modelsRes?.rows ?? [];
  const recentErrors = errRes?.recent ?? [];
  const series = useMemo(() => (seriesRes?.rows ?? []).map((r) => ({ ...r, label: fmtBucket(r.bucket) })), [seriesRes]);
  const modelData = useMemo(() => models.map((r, i) => ({ ...r, label: `${r.provider}/${r.model}`, color: CHART.categorical[i % CHART.categorical.length] })), [models]);
  const tokenSplit = useMemo(() => modelData.map((r) => ({ label: r.label, prompt: Number(r.prompt_tokens), completion: Number(r.completion_tokens), provider: r.provider, model: r.model })), [modelData]);

  const toReq = (p: Record<string, string>) => {
    const q = new URLSearchParams(); for (const [k, v] of Object.entries({ ...filters, ...p })) if (v) q.set(k, v);
    router.push(`/requests?${q}`);
  };
  const errRate = summary && summary.requests > 0 ? (100 * summary.errors) / summary.requests : 0;
  const successRate = summary && summary.requests > 0 ? (100 * summary.success) / summary.requests : 0;
  const avgCost = summary && summary.success > 0 && summary.est_cost_usd != null ? summary.est_cost_usd / summary.success : null;
  const streamPct = summary && summary.requests > 0 ? (100 * summary.streamed) / summary.requests : 0;

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-20 border-b border-carbon-800 bg-carbon-950/70 px-5 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <Gauge className="h-5 w-5 text-signal" />
          <h1 className="font-display text-base font-semibold tracking-tight text-ink">Dashboard</h1>
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint"><LiveDot /> live · 10s</span>
        </div>
        <div className="mt-3"><FilterBar filters={filters} set={set} reset={reset} active={active} facets={facets} /></div>
      </header>

      <div className="space-y-4 p-5">
        {/* headline cost band */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Total cost" value={summary?.est_cost_usd ?? null} prefix="$" accent="#43c493" delay={0} />
          <StatCard label="Avg cost / req" value={avgCost != null ? Number(avgCost.toFixed(5)) : null} prefix="$" delay={0.03} />
          <StatCard label="Total tokens" value={summary ? Number(summary.total_tokens) : null} delay={0.06} />
          <StatCard label="Requests" value={summary?.requests ?? null} onClick={() => toReq({})} delay={0.09} />
        </div>
        {/* ops metrics */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
          <StatCard label="Success rate" value={summary ? Number(successRate.toFixed(1)) : null} suffix="%" accent={successRate >= 99 ? '#43c493' : undefined} onClick={() => toReq({ status: 'success' })} delay={0} />
          <StatCard label="Error rate" value={summary ? Number(errRate.toFixed(1)) : null} suffix="%" accent={errRate > 0 ? '#ef7a63' : undefined} onClick={() => toReq({ status: 'error' })} delay={0.02} />
          <StatCard label="Cancelled" value={summary?.cancelled ?? null} onClick={() => toReq({ status: 'cancelled' })} delay={0.04} />
          <StatCard label="Avg latency" value={summary?.avg_latency_ms ?? null} unit="ms" delay={0.06} />
          <StatCard label="p95 latency" value={summary?.p95_latency_ms ?? null} unit="ms" delay={0.08} />
          <StatCard label="TTFT p50" value={summary?.ttfb_p50 ?? null} unit="ms" delay={0.1} />
          <StatCard label="Conversations" value={summary?.conversations ?? null} delay={0.12} />
          <StatCard label="Flagged" value={summary?.flagged_injection ?? null} accent={(summary?.flagged_injection ?? 0) > 0 ? '#e0a43a' : undefined} onClick={() => toReq({ flagged: 'true' })} delay={0.14} />
        </div>

        <Card title="Models" right={<span className="text-[11px] text-ink-faint">click a row → its requests</span>}>
          {modelData.length === 0 ? <EmptyState /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-ink-faint"><tr>{['model','requests','errors','p50','p95','p99','TTFT','in','out','tok/s','cost'].map((h) => <th key={h} className="pb-2 pr-4 font-medium">{h}</th>)}</tr></thead>
                <tbody className="font-mono">
                  {modelData.map((r) => (
                    <tr key={r.label} onClick={() => toReq({ provider: r.provider, model: r.model })} className="cursor-pointer border-t border-carbon-800 transition-colors hover:bg-carbon-800/50">
                      <td className="py-2 pr-4 font-sans"><span className="mr-2 inline-block h-2 w-2 rounded-full align-middle" style={{ background: r.color }} />{r.label}</td>
                      <td className="py-2 pr-4 tabular-nums text-ink">{Number(r.requests).toLocaleString()}</td>
                      <td className="py-2 pr-4 tabular-nums" style={r.errors > 0 ? { color: '#ef7a63' } : undefined}>{r.errors}</td>
                      <td className="py-2 pr-4 tabular-nums">{r.p50 ?? '—'}</td><td className="py-2 pr-4 tabular-nums">{r.p95 ?? '—'}</td><td className="py-2 pr-4 tabular-nums">{r.p99 ?? '—'}</td>
                      <td className="py-2 pr-4 tabular-nums">{r.ttfb_p50 ?? '—'}</td>
                      <td className="py-2 pr-4 tabular-nums text-ink-muted">{Number(r.prompt_tokens).toLocaleString()}</td><td className="py-2 pr-4 tabular-nums text-ink-muted">{Number(r.completion_tokens).toLocaleString()}</td>
                      <td className="py-2 pr-4 tabular-nums">{r.tokens_per_sec ?? '—'}</td><td className="py-2 pr-4 tabular-nums text-live">{fmtUsd(r.est_cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Volume over time" right={<Activity className="h-4 w-4 text-ink-faint" />}>
            {series.length === 0 ? <EmptyState /> : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  {gridEl}{xAxis}<YAxis tick={CHART.tick} tickLine={false} axisLine={false} width={40} allowDecimals={false} /><Tooltip {...tooltipStyle} />
                  <Line type="monotone" dataKey="requests" stroke={CHART.categorical[0]} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="errors" stroke={CHART.danger} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="cancelled" stroke={CHART.categorical[1]} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>
          <Card title="Latency over time (ms)" right={<Gauge className="h-4 w-4 text-ink-faint" />}>
            {series.length === 0 ? <EmptyState /> : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <defs>
                    <linearGradient id="l50" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={CHART.seq.p50} stopOpacity={0.25} /><stop offset="100%" stopColor={CHART.seq.p50} stopOpacity={0} /></linearGradient>
                    <linearGradient id="l95" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={CHART.seq.p95} stopOpacity={0.25} /><stop offset="100%" stopColor={CHART.seq.p95} stopOpacity={0} /></linearGradient>
                  </defs>
                  {gridEl}{xAxis}<YAxis tick={CHART.tick} tickLine={false} axisLine={false} width={48} /><Tooltip {...tooltipStyle} />
                  <Area type="monotone" dataKey="p95" stroke={CHART.seq.p95} strokeWidth={2} fill="url(#l95)" />
                  <Area type="monotone" dataKey="p50" stroke={CHART.seq.p50} strokeWidth={2} fill="url(#l50)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Card>
          <Card title="Estimated cost over time" right={<Coins className="h-4 w-4 text-ink-faint" />}>
            {series.length === 0 ? <EmptyState /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -4 }}>
                  {gridEl}{xAxis}<YAxis tick={CHART.tick} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => `$${v}`} /><Tooltip {...tooltipStyle} formatter={(v: number) => [`$${Number(v).toFixed(4)}`, 'cost']} />
                  <Bar dataKey="est_cost_usd" fill={CHART.categorical[0]} radius={[3, 3, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
          <Card title="Token split (prompt vs completion)" right={<Zap className="h-4 w-4 text-ink-faint" />}>
            {tokenSplit.length === 0 ? <EmptyState /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={tokenSplit} margin={{ top: 4, right: 8, bottom: 0, left: -4 }}>
                  {gridEl}<XAxis dataKey="label" tick={CHART.tick} tickLine={false} axisLine={{ stroke: CHART.grid }} minTickGap={4} /><YAxis tick={CHART.tick} tickLine={false} axisLine={false} width={52} /><Tooltip {...tooltipStyle} />
                  <Bar dataKey="prompt" stackId="t" fill={CHART.categorical[0]} maxBarSize={44} stroke="#161615" strokeWidth={1.5} />
                  <Bar dataKey="completion" stackId="t" fill={CHART.categorical[2]} radius={[3, 3, 0, 0]} maxBarSize={44} stroke="#161615" strokeWidth={1.5} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>

        <Card title="Recent errors" right={<span className="flex items-center gap-1.5 text-[11px] text-ink-faint"><ShieldAlert className="h-3.5 w-3.5" /> redacted</span>}>
          {recentErrors.length === 0 ? <EmptyState label="no errors — nice" /> : (
            <div className="max-h-64 overflow-auto">
              <table className="w-full text-left text-xs"><tbody>
                {recentErrors.map((e) => (
                  <tr key={e.id} onClick={() => router.push(`/requests/${e.id}`)} className="cursor-pointer border-b border-carbon-800 transition-colors hover:bg-carbon-800/50">
                    <td className="py-2 pr-3 font-mono text-[11px] text-ink-faint">{new Date(e.request_started_at).toLocaleTimeString()}</td>
                    <td className="py-2 pr-3 text-ink-muted">{e.provider}/{e.model}</td>
                    <td className="py-2 pr-3"><span className="chip border-danger/30 text-danger"><AlertTriangle className="h-3 w-3" />{e.error_type ?? 'error'}</span></td>
                    <td className="max-w-md truncate py-2 text-ink-muted">{e.error_message ?? '—'}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function Dashboard() {
  return <Suspense fallback={<div className="p-6 text-sm text-ink-faint">loading…</div>}><DashboardInner /></Suspense>;
}
