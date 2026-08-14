'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { fetchLogs, fetchMeta, type LogListRow } from '../lib/api';

const STATUS_COLORS: Record<string, string> = {
  success: '#199e70',
  error: '#ec835a',
  cancelled: '#c98500',
};

const fmtUsd = (n: number | null) => (n == null ? '—' : `$${n.toFixed(4)}`);

export default function RequestsExplorer() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [windowMin, setWindowMin] = useState(Number(searchParams.get('window') ?? 1440));
  const [provider, setProvider] = useState(searchParams.get('provider') ?? '');
  const [model, setModel] = useState(searchParams.get('model') ?? '');
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [conversationId, setConversationId] = useState(searchParams.get('conversationId') ?? '');
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [rows, setRows] = useState<LogListRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchMeta()
      .then((m) => setModels(m.models))
      .catch(() => undefined);
  }, []);

  const load = useCallback(
    async (append: boolean, before?: string) => {
      setLoading(true);
      setNotice(null);
      try {
        const res = await fetchLogs({ window: windowMin, provider, model, status, conversationId, before });
        setRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
        setNextBefore(res.nextBefore);
      } catch {
        setNotice('failed to load requests — is the api up?');
      } finally {
        setLoading(false);
      }
    },
    [windowMin, provider, model, status, conversationId],
  );

  // Reload on filter change and mirror filters into the URL (shareable links).
  useEffect(() => {
    const qs = new URLSearchParams();
    qs.set('window', String(windowMin));
    if (provider) qs.set('provider', provider);
    if (model) qs.set('model', model);
    if (status) qs.set('status', status);
    if (conversationId) qs.set('conversationId', conversationId);
    router.replace(`/requests?${qs.toString()}`, { scroll: false });
    void load(false);
  }, [windowMin, provider, model, status, conversationId, load, router]);

  const select = 'rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm';

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-semibold">Requests</h1>
        <select value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))} className={select}>
          <option value={60}>last hour</option>
          <option value={360}>last 6 hours</option>
          <option value={1440}>last 24 hours</option>
          <option value={10080}>last 7 days</option>
        </select>
        <select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(''); }} className={select}>
          <option value="">all providers</option>
          {Object.keys(models).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)} className={select}>
          <option value="">all models</option>
          {(provider ? models[provider] ?? [] : Object.values(models).flat()).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={select}>
          <option value="">all statuses</option>
          <option value="success">success</option>
          <option value="error">error</option>
          <option value="cancelled">cancelled</option>
        </select>
        {conversationId && (
          <button
            onClick={() => setConversationId('')}
            className="rounded-full border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500"
            title="clear conversation filter"
          >
            conversation {conversationId.slice(0, 8)}… ✕
          </button>
        )}
        {notice && <span className="text-xs text-red-400">{notice}</span>}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-400">
              <tr>
                {['time', 'model', 'status', 'stream', 'latency ms', 'TTFT ms', 'tokens in/out', 'est. cost', 'input preview'].map((h) => (
                  <th key={h} className="px-3 py-2 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => router.push(`/requests/${r.id}`)}
                  className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/60"
                >
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-zinc-400">
                    {new Date(r.requestStartedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{r.provider}/{r.model}</td>
                  <td className="px-3 py-2">
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{ color: STATUS_COLORS[r.status], backgroundColor: `${STATUS_COLORS[r.status]}22` }}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{r.isStream ? 'yes' : 'no'}</td>
                  <td className="px-3 py-2 tabular-nums">{r.latencyMs ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{r.ttfbMs ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {r.promptTokens ?? '—'} / {r.completionTokens ?? '—'}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{fmtUsd(r.estCostUsd)}</td>
                  <td className="max-w-sm truncate px-3 py-2 text-zinc-300">
                    {r.flaggedInjection && (
                      <span title="prompt-injection heuristics flagged this input" className="mr-1 text-[#c98500]">⚠</span>
                    )}
                    {r.inputPreview ?? '—'}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-zinc-500">
                    no requests match these filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">
          <span>{rows.length} row(s){loading ? ' · loading…' : ''}</span>
          {nextBefore && (
            <button
              onClick={() => void load(true, nextBefore)}
              className="rounded-md border border-zinc-700 px-3 py-1 hover:border-zinc-500"
            >
              Load older
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
