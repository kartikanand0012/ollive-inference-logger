'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  fetchStats,
  type ModelRow,
  type RecentErrorRow,
  type StatsSummary,
  type TimeseriesRow,
} from '../../lib/api';

// Palette validated with the six-checks validator against the dark surface:
// categorical (fixed order, assigned per entity, never cycled) + a
// lightness-monotonic sequential blue ramp for ordered series (p50<p95<p99).
const CATEGORICAL = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const SEQ = { p50: '#86b6ef', p95: '#3987e5', p99: '#184f95' };
const SERIOUS = '#ec835a'; // status color, reserved for errors
const GRID = '#27272a';
const TICK = { fill: '#a1a1aa', fontSize: 11 };
const TOOLTIP_STYLE = {
  backgroundColor: '#18181b',
  border: '1px solid #3f3f46',
  borderRadius: 6,
  fontSize: 12,
};

const POLL_MS = 10_000;

function useStats(windowMin: number) {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [series, setSeries] = useState<TimeseriesRow[]>([]);
  const [recentErrors, setRecentErrors] = useState<RecentErrorRow[]>([]);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, m, t, e] = await Promise.all([
          fetchStats.summary(windowMin),
          fetchStats.models(windowMin),
          fetchStats.timeseries(windowMin),
          fetchStats.errors(windowMin),
        ]);
        if (!alive) return;
        setSummary(s);
        setModels(m.rows);
        setSeries(t.rows);
        setRecentErrors(e.recent);
        setStale(false);
      } catch {
        if (alive) setStale(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [windowMin]);

  return { summary, models, series, recentErrors, stale };
}

function StatCard({
  label,
  value,
  accent,
  onClick,
}: {
  label: string;
  value: string;
  accent?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-left ${
        onClick ? 'transition-colors hover:border-zinc-600' : 'cursor-default'
      }`}
    >
      <div className="text-xs text-zinc-400">{label}</div>
      <div
        className="mt-1 text-2xl font-semibold tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
    </button>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-sm font-medium text-zinc-300">{title}</h2>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="py-10 text-center text-xs text-zinc-500">no data in this window</p>;
}

const fmtBucket = (v: string) =>
  new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtNum = (n: number | string | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString();
const fmtMs = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toLocaleString()}`);
const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toFixed(n < 0.1 ? 4 : 2)}`;

export default function Dashboard() {
  const router = useRouter();
  const [windowMin, setWindowMin] = useState(1440);
  const { summary, models, series, recentErrors, stale } = useStats(windowMin);

  const seriesData = series.map((r) => ({ ...r, label: fmtBucket(r.bucket) }));
  const modelData = models.map((r) => ({ ...r, label: `${r.provider}/${r.model}` }));

  const errRate =
    summary && summary.requests > 0
      ? ((100 * summary.errors) / summary.requests).toFixed(1)
      : '0.0';

  const toRequests = (params: Record<string, string | number>) => {
    const qs = new URLSearchParams({ window: String(windowMin), ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ) });
    router.push(`/requests?${qs.toString()}`);
  };

  const barClick = (entry: unknown) => {
    const row = ((entry as { payload?: ModelRow }).payload ?? entry) as ModelRow;
    if (row?.model) toRequests({ provider: row.provider, model: row.model });
  };

  const tokenSplit = useMemo(
    () =>
      modelData.map((r) => ({
        label: r.label,
        provider: r.provider,
        model: r.model,
        prompt: Number(r.prompt_tokens),
        completion: Number(r.completion_tokens),
      })),
    [modelData],
  );

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <select
          value={windowMin}
          onChange={(e) => setWindowMin(Number(e.target.value))}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        >
          <option value={60}>last hour</option>
          <option value={360}>last 6 hours</option>
          <option value={1440}>last 24 hours</option>
          <option value={10080}>last 7 days</option>
        </select>
        <span className="text-xs text-zinc-500">refreshes every 10s · click anything to drill down</span>
        {stale && <span className="text-xs text-amber-400">api unreachable — showing last data</span>}
      </div>

      {/* Stat cards — each links into the requests explorer */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-7">
        <StatCard label="Requests" value={summary ? fmtNum(summary.requests) : '–'} onClick={() => toRequests({})} />
        <StatCard
          label="Error rate"
          value={`${errRate}%`}
          accent={Number(errRate) > 0 ? SERIOUS : undefined}
          onClick={() => toRequests({ status: 'error' })}
        />
        <StatCard label="Cancelled" value={summary ? fmtNum(summary.cancelled) : '–'} onClick={() => toRequests({ status: 'cancelled' })} />
        <StatCard label="p95 latency" value={summary?.p95_latency_ms != null ? `${fmtNum(summary.p95_latency_ms)} ms` : '–'} />
        <StatCard label="Tokens" value={summary ? fmtNum(summary.total_tokens) : '–'} />
        <StatCard label="Est. cost" value={summary ? fmtUsd(summary.est_cost_usd) : '–'} />
        <StatCard
          label="Flagged inputs"
          value={summary ? fmtNum(summary.flagged_injection) : '–'}
          accent={summary && summary.flagged_injection > 0 ? '#c98500' : undefined}
        />
      </div>

      {/* Model economics table — the densest view; rows drill into requests */}
      <div className="mb-4">
        <Card title="Models — traffic, latency, tokens, speed, cost (click a row to see its requests)">
          {modelData.length === 0 ? (
            <Empty />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-zinc-400">
                  <tr>
                    {['model', 'requests', 'errors', 'p50 ms', 'p95 ms', 'p99 ms', 'TTFT p50', 'tokens in', 'tokens out', 'tok/s', 'est. cost'].map((h) => (
                      <th key={h} className="py-1 pr-4 font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modelData.map((r) => (
                    <tr
                      key={r.label}
                      onClick={() => toRequests({ provider: r.provider, model: r.model })}
                      className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/60"
                    >
                      <td className="py-1.5 pr-4">
                        <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: CATEGORICAL[modelData.indexOf(r) % CATEGORICAL.length] }} />
                        {r.label}
                      </td>
                      <td className="py-1.5 pr-4 tabular-nums">{fmtNum(r.requests)}</td>
                      <td className="py-1.5 pr-4 tabular-nums" style={r.errors > 0 ? { color: SERIOUS } : undefined}>{fmtNum(r.errors)}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{fmtMs(r.p50)}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{fmtMs(r.p95)}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{fmtMs(r.p99)}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{fmtMs(r.ttfb_p50)}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{fmtNum(r.prompt_tokens)}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{fmtNum(r.completion_tokens)}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{r.tokens_per_sec ?? '—'}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{fmtUsd(r.est_cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Volume over time (requests · errors · cancelled)">
          {seriesData.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={seriesData}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="requests" stroke={CATEGORICAL[0]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="errors" stroke={SERIOUS} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="cancelled" stroke={CATEGORICAL[3]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Latency over time (ms, successful requests)">
          {seriesData.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={seriesData}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={52} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="p50" stroke={SEQ.p50} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="p95" stroke={SEQ.p95} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Estimated cost over time (USD)">
          {seriesData.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={seriesData}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: '#27272a55' }} formatter={(v: number) => [`$${Number(v).toFixed(4)}`, 'est. cost']} />
                <Bar dataKey="est_cost_usd" name="est. cost" fill={CATEGORICAL[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Latency percentiles by model (click a bar for its requests)">
          {modelData.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={modelData} barGap={2}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={52} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: '#27272a55' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="p50" fill={SEQ.p50} radius={[4, 4, 0, 0]} maxBarSize={24} onClick={barClick} className="cursor-pointer" />
                <Bar dataKey="p95" fill={SEQ.p95} radius={[4, 4, 0, 0]} maxBarSize={24} onClick={barClick} className="cursor-pointer" />
                <Bar dataKey="p99" fill={SEQ.p99} radius={[4, 4, 0, 0]} maxBarSize={24} onClick={barClick} className="cursor-pointer" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Token split by model (prompt vs completion)">
          {tokenSplit.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={tokenSplit} barGap={2}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={56} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: '#27272a55' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="prompt" stackId="t" fill={CATEGORICAL[0]} stroke="#18181b" strokeWidth={1.5} maxBarSize={36} onClick={barClick} className="cursor-pointer" />
                <Bar dataKey="completion" stackId="t" fill={CATEGORICAL[2]} stroke="#18181b" strokeWidth={1.5} radius={[4, 4, 0, 0]} maxBarSize={36} onClick={barClick} className="cursor-pointer" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Recent errors (redacted — click a row for full detail)">
          {recentErrors.length === 0 ? (
            <Empty />
          ) : (
            <div className="max-h-[220px] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-zinc-400">
                  <tr>
                    <th className="py-1 pr-4 font-normal">time</th>
                    <th className="py-1 pr-4 font-normal">model</th>
                    <th className="py-1 pr-4 font-normal">type</th>
                    <th className="py-1 font-normal">message</th>
                  </tr>
                </thead>
                <tbody>
                  {recentErrors.map((e) => (
                    <tr
                      key={e.id}
                      onClick={() => router.push(`/requests/${e.id}`)}
                      className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/60"
                    >
                      <td className="py-1.5 pr-4 tabular-nums text-zinc-400">
                        {new Date(e.request_started_at).toLocaleTimeString()}
                      </td>
                      <td className="py-1.5 pr-4">{e.provider}/{e.model}</td>
                      <td className="py-1.5 pr-4" style={{ color: SERIOUS }}>{e.error_type ?? '—'}</td>
                      <td className="max-w-xs truncate py-1.5 text-zinc-300">{e.error_message ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
