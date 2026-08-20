'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUp, Sparkles, Loader2 } from 'lucide-react';
import { fetchAssistantHistory, getSessionId, streamAssistant, type AssistantMessage } from '../lib/api';
import { Markdown } from './chat/markdown';
import { LiveDot } from './ui';

const SUGGESTIONS = [
  'What do these numbers mean overall?',
  'Which model is most cost-efficient right now?',
  'Is my p95 latency healthy?',
  'Explain TTFT and why it matters.',
];

export default function Insights() {
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bufRef = useRef(''); const rafRef = useRef<number | null>(null);
  const threadId = typeof window !== 'undefined' ? `insights-${getSessionId()}` : 'insights';

  useEffect(() => {
    fetchAssistantHistory(threadId).then((h: AssistantMessage[]) => setMsgs(h.map((m) => ({ role: m.role, content: m.content })))).catch(() => undefined);
  }, [threadId]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [msgs]);

  const flush = useCallback(() => { rafRef.current = null; setMsgs((m) => { const l = m[m.length - 1]; return l?.role === 'assistant' ? [...m.slice(0, -1), { ...l, content: bufRef.current }] : m; }); }, []);

  const ask = useCallback(async (q: string) => {
    const text = q.trim(); if (!text || busy) return;
    setInput(''); setBusy(true); setNotice(null); bufRef.current = '';
    setMsgs((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    try {
      for await (const ev of streamAssistant(threadId, text)) {
        if (ev.type === 'token' && ev.text) { bufRef.current += ev.text; if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush); }
        else if (ev.type === 'error') { setNotice(ev.message ?? 'failed'); }
      }
      flush();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'failed'); setMsgs((m) => m.slice(0, -1)); }
    finally { setBusy(false); }
  }, [busy, threadId, flush]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-carbon-800 px-5 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-signal to-signal-dim"><Sparkles className="h-4 w-4 text-carbon-950" /></div>
        <div>
          <h1 className="font-display text-base font-semibold tracking-tight text-ink">Insights copilot</h1>
          <p className="text-[11px] text-ink-faint">Ask about your telemetry — it reads a live snapshot of your dashboard. History is saved.</p>
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-faint">{busy ? <><LiveDot color="#4d9bff" /> thinking</> : 'ready'}</span>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {msgs.length === 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-16 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-signal to-signal-dim shadow-glow"><Sparkles className="h-7 w-7 text-carbon-950" /></div>
              <h2 className="mt-5 font-display text-lg font-semibold text-ink">Understand your numbers</h2>
              <p className="mt-1 text-sm text-ink-muted">The copilot sees your live 24h metrics and explains them in plain language.</p>
              <div className="mx-auto mt-6 grid max-w-lg gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => <button key={s} onClick={() => void ask(s)} className="card card-hover px-3 py-2.5 text-left text-sm text-ink-muted">{s}</button>)}
              </div>
            </motion.div>
          )}
          {msgs.map((m, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`mb-4 flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${m.role === 'user' ? 'bg-carbon-700 text-ink-muted' : 'bg-gradient-to-br from-signal to-signal-dim text-carbon-950'}`}>{m.role === 'user' ? 'you' : <Sparkles className="h-4 w-4" />}</div>
              <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${m.role === 'user' ? 'bg-signal/15' : 'bg-carbon-850'}`}>
                {m.role === 'user' ? <div className="whitespace-pre-wrap text-sm text-ink">{m.content}</div>
                  : m.content ? <Markdown content={m.content} /> : <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />}
              </div>
            </motion.div>
          ))}
          {notice && <div className="text-center text-xs text-danger">{notice}</div>}
        </div>
      </div>

      <footer className="border-t border-carbon-800 px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-2xl border border-carbon-700 bg-carbon-900/80 p-2 focus-within:border-signal/40 focus-within:shadow-glow">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void ask(input); }}
            placeholder="Ask about your metrics…" className="flex-1 bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-faint" />
          <button onClick={() => void ask(input)} disabled={busy || !input.trim()} className="grid h-9 w-9 place-items-center rounded-xl bg-signal text-carbon-950 hover:bg-signal-glow disabled:opacity-30"><ArrowUp className="h-4 w-4" strokeWidth={2.5} /></button>
        </div>
      </footer>
    </div>
  );
}
