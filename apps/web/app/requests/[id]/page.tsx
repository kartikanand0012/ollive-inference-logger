'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { fetchLogDetail, type LogDetail } from '../../../lib/api';

const STATUS_COLORS: Record<string, string> = {
  success: '#199e70',
  error: '#ec835a',
  cancelled: '#c98500',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

export default function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<LogDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLogDetail(id)
      .then(setData)
      .catch(() => setError('request not found (or api unreachable)'));
  }, [id]);

  if (error) return <div className="p-6 text-sm text-red-400">{error}</div>;
  if (!data) return <div className="p-6 text-sm text-zinc-500">loading…</div>;

  const { log, conversation, estCostUsd } = data;
  const started = new Date(log.requestStartedAt);
  const completed = log.requestCompletedAt ? new Date(log.requestCompletedAt) : null;
  const ttfbPct =
    log.latencyMs && log.ttfbMs ? Math.min(100, Math.round((100 * log.ttfbMs) / log.latencyMs)) : null;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex items-center gap-3">
        <button onClick={() => router.back()} className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:border-zinc-500">
          ← back
        </button>
        <h1 className="text-lg font-semibold">Request</h1>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ color: STATUS_COLORS[log.status], backgroundColor: `${STATUS_COLORS[log.status]}22` }}
        >
          {log.status}
        </span>
        <span className="text-xs text-zinc-500">{log.provider}/{log.model}{log.isStream ? ' · streamed' : ''}</span>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 xl:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-zinc-300">Timing</h2>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="started">{started.toLocaleString()}</Field>
            <Field label="completed">{completed ? completed.toLocaleTimeString() : '—'}</Field>
            <Field label="latency">{log.latencyMs != null ? `${log.latencyMs} ms` : '—'}</Field>
            <Field label="time to first token">{log.ttfbMs != null ? `${log.ttfbMs} ms` : '—'}</Field>
          </div>
          {ttfbPct != null && (
            <div>
              <div className="flex h-3 w-full overflow-hidden rounded bg-zinc-800">
                <div className="bg-[#86b6ef]" style={{ width: `${ttfbPct}%` }} title={`TTFT ${log.ttfbMs}ms`} />
                <div className="bg-[#3987e5]" style={{ width: `${100 - ttfbPct}%` }} title="generation" />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
                <span>waiting for first token · {log.ttfbMs} ms</span>
                <span>generating · {log.latencyMs! - log.ttfbMs!} ms</span>
              </div>
            </div>
          )}

          <h2 className="mb-2 mt-5 text-sm font-medium text-zinc-300">Previews (redacted at ingestion)</h2>
          <div className="space-y-2 text-sm">
            <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
              <div className="mb-1 text-xs text-zinc-500">input</div>
              <div className="whitespace-pre-wrap break-words">{log.inputPreview || '—'}</div>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
              <div className="mb-1 text-xs text-zinc-500">output</div>
              <div className="whitespace-pre-wrap break-words">{log.outputPreview || '—'}</div>
            </div>
            {log.errorMessage && (
              <div className="rounded-md border border-red-900/60 bg-red-950/30 p-3">
                <div className="mb-1 text-xs" style={{ color: STATUS_COLORS.error }}>
                  {log.errorType ?? 'error'}
                </div>
                <div className="whitespace-pre-wrap break-words text-red-200">{log.errorMessage}</div>
              </div>
            )}
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">
              raw event (full redacted payload)
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-relaxed">
              {JSON.stringify(log.raw, null, 2)}
            </pre>
          </details>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-3 text-sm font-medium text-zinc-300">Tokens & cost</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="prompt tokens">{log.promptTokens ?? '—'}</Field>
              <Field label="completion tokens">{log.completionTokens ?? '—'}</Field>
              <Field label="total tokens">{log.totalTokens ?? '—'}</Field>
              <Field label="est. cost">{estCostUsd != null ? `$${estCostUsd.toFixed(6)}` : '—'}</Field>
              <Field label="guardrails">
                {(data.log as unknown as { flaggedInjection?: boolean }).flaggedInjection ? (
                  <span className="text-[#c98500]">⚠ injection heuristics flagged</span>
                ) : (
                  <span className="text-zinc-500">clean</span>
                )}
              </Field>
              <Field label="tokens / sec">
                {log.completionTokens && log.latencyMs
                  ? (log.completionTokens / (log.latencyMs / 1000)).toFixed(1)
                  : '—'}
              </Field>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-3 text-sm font-medium text-zinc-300">Correlation</h2>
            <div className="space-y-3">
              <Field label="request id (idempotency key)">
                <code className="text-xs">{log.requestId}</code>
              </Field>
              <Field label="conversation">
                {conversation ? (
                  <div className="space-y-1">
                    <Link href={`/?c=${conversation.id}`} className="block text-[#86b6ef] hover:underline">
                      {conversation.title ?? conversation.id} →
                    </Link>
                    <Link
                      href={`/requests?conversationId=${conversation.id}&window=10080`}
                      className="block text-xs text-zinc-400 hover:text-zinc-200 hover:underline"
                    >
                      all requests in this conversation →
                    </Link>
                  </div>
                ) : (
                  <span className="text-zinc-500">none (external producer)</span>
                )}
              </Field>
              <Field label="message id">
                <code className="text-xs">{log.messageId ?? '—'}</code>
              </Field>
              <Field label="ingested at">{new Date(log.ingestedAt).toLocaleString()}</Field>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
