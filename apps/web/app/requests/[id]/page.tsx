'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowLeft, MessageSquare, ShieldAlert, ShieldCheck } from 'lucide-react';
import { fetchLogDetail, type LogDetail } from '../../../lib/api';
import { Card, StatusBadge } from '../../../components/ui';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</div><div className="mt-1 text-sm text-ink">{children}</div></div>;
}
function Pre({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="rounded-lg border border-carbon-700 bg-carbon-950 p-3"><div className="mb-1 text-[11px] uppercase tracking-wider text-ink-faint">{label}</div><div className="whitespace-pre-wrap break-words text-sm text-ink">{children}</div></div>;
}

export default function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<LogDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetchLogDetail(id).then(setData).catch(() => setError('request not found')); }, [id]);

  if (error) return <div className="p-6 text-sm text-danger">{error}</div>;
  if (!data) return <div className="p-6 text-sm text-ink-faint">loading…</div>;

  const { log, conversation, estCostUsd } = data;
  const started = new Date(log.requestStartedAt);
  const ttfbPct = log.latencyMs && log.ttfbMs ? Math.min(100, Math.round((100 * log.ttfbMs) / log.latencyMs)) : null;
  const flagged = (log as unknown as { flaggedInjection?: boolean }).flaggedInjection;

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-carbon-800 bg-carbon-950/70 px-5 py-3 backdrop-blur-md">
        <button onClick={() => router.back()} className="btn-ghost px-2 py-1.5"><ArrowLeft className="h-4 w-4" /></button>
        <h1 className="font-display text-base font-semibold tracking-tight text-ink">Request</h1>
        <StatusBadge status={log.status} />
        <span className="font-mono text-xs text-ink-faint">{log.provider}/{log.model}{log.isStream ? ' · streamed' : ''}</span>
      </header>

      <div className="grid gap-4 p-5 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card title="Timing">
            <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="started">{started.toLocaleString()}</Field>
              <Field label="latency"><span className="font-mono">{log.latencyMs != null ? `${log.latencyMs} ms` : '—'}</span></Field>
              <Field label="time to first token"><span className="font-mono">{log.ttfbMs != null ? `${log.ttfbMs} ms` : '—'}</span></Field>
              <Field label="ingest lag"><span className="font-mono">{(log as unknown as { ingestLagMs?: number }).ingestLagMs ?? '—'} ms</span></Field>
            </div>
            {ttfbPct != null && (
              <div>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-carbon-800">
                  <motion.div initial={{ width: 0 }} animate={{ width: `${ttfbPct}%` }} transition={{ duration: 0.6 }} className="bg-signal/50" />
                  <motion.div initial={{ width: 0 }} animate={{ width: `${100 - ttfbPct}%` }} transition={{ duration: 0.6, delay: 0.1 }} className="bg-signal" />
                </div>
                <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-faint">
                  <span>waiting · {log.ttfbMs} ms</span><span>generating · {(log.latencyMs ?? 0) - (log.ttfbMs ?? 0)} ms</span>
                </div>
              </div>
            )}
          </Card>

          <Card title="Previews" right={<span className="text-[11px] text-ink-faint">redacted at ingestion</span>}>
            <div className="space-y-2">
              <Pre label="input">{log.inputPreview || '—'}</Pre>
              <Pre label="output">{log.outputPreview || '—'}</Pre>
              {log.errorMessage && <div className="rounded-lg border border-danger/40 bg-danger/10 p-3"><div className="mb-1 text-[11px] text-danger">{log.errorType ?? 'error'}</div><div className="whitespace-pre-wrap break-words text-sm text-danger">{log.errorMessage}</div></div>}
            </div>
            <details className="mt-3 group">
              <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-muted">raw event (full redacted payload)</summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-carbon-700 bg-carbon-950 p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(log.raw, null, 2)}</pre>
            </details>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Guardrails">
            {flagged
              ? <div className="flex items-center gap-2 text-sm text-warn"><ShieldAlert className="h-5 w-5" /> injection heuristics flagged this input</div>
              : <div className="flex items-center gap-2 text-sm text-live"><ShieldCheck className="h-5 w-5" /> clean — no injection signature</div>}
          </Card>
          <Card title="Tokens & cost">
            <div className="grid grid-cols-2 gap-4">
              <Field label="prompt"><span className="font-mono">{log.promptTokens ?? '—'}</span></Field>
              <Field label="completion"><span className="font-mono">{log.completionTokens ?? '—'}</span></Field>
              <Field label="total"><span className="font-mono">{log.totalTokens ?? '—'}</span></Field>
              <Field label="est. cost"><span className="font-mono text-live">{estCostUsd != null ? `$${estCostUsd.toFixed(6)}` : '—'}</span></Field>
              <Field label="tok/sec"><span className="font-mono">{(log as unknown as { tokensPerSec?: number }).tokensPerSec ?? '—'}</span></Field>
            </div>
          </Card>
          <Card title="Correlation">
            <div className="space-y-3">
              <Field label="request id"><code className="font-mono text-xs text-ink-muted">{log.requestId}</code></Field>
              <Field label="conversation">
                {conversation ? (
                  <div className="space-y-1.5">
                    <Link href={`/?c=${conversation.id}`} className="flex items-center gap-1.5 text-signal hover:text-signal-glow"><MessageSquare className="h-3.5 w-3.5" />{conversation.title ?? conversation.id}</Link>
                    <Link href={`/requests?conversationId=${conversation.id}&window=10080`} className="block text-xs text-ink-faint hover:text-ink-muted">all requests in this conversation →</Link>
                  </div>
                ) : <span className="text-ink-faint">none (external producer)</span>}
              </Field>
              <Field label="tenant"><span className="font-mono text-xs">{(log as unknown as { tenantId?: string }).tenantId ?? 'default'}</span></Field>
              <Field label="ingested"><span className="font-mono text-xs">{new Date(log.ingestedAt).toLocaleString()}</span></Field>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
