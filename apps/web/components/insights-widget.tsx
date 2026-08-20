'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, Sparkles, Loader2, X, MessageSquarePlus } from 'lucide-react';
import { fetchAssistantHistory, getSessionId, streamAssistant, type AssistantMessage } from '../lib/api';
import { Markdown } from './chat/markdown';
import { LiveDot } from './ui';

const SUGGESTIONS = [
  'What do these numbers mean overall?',
  'Which model is most cost-efficient right now?',
  'Is my p95 latency healthy?',
  'Explain TTFT and why it matters.',
];

const THREAD_KEY = 'ollive-insights-thread';

/** A fresh random thread id (works over plain HTTP where crypto.randomUUID is absent). */
function newThreadId(): string {
  return `insights-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Floating "Insights copilot" chat, mounted only on the dashboard. A toggle
 * button opens a hovering window that reasons over a live snapshot of the
 * dashboard, persists its history (thread id in localStorage so it survives
 * reloads), and supports starting a new chat.
 */
export default function InsightsWidget() {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bufRef = useRef('');
  const rafRef = useRef<number | null>(null);

  // Resolve (or create) the active thread id once, client-side. Default keeps
  // continuity with any existing per-session history; "new chat" mints a fresh one.
  useEffect(() => {
    let id = window.localStorage.getItem(THREAD_KEY);
    if (!id) { id = `insights-${getSessionId()}`; window.localStorage.setItem(THREAD_KEY, id); }
    setThreadId(id);
  }, []);

  // Load persisted history whenever the thread changes.
  useEffect(() => {
    if (!threadId) return;
    fetchAssistantHistory(threadId)
      .then((h: AssistantMessage[]) => setMsgs(h.map((m) => ({ role: m.role, content: m.content }))))
      .catch(() => undefined);
  }, [threadId]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [msgs, open]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 250); }, [open]);

  const flush = useCallback(() => {
    rafRef.current = null;
    setMsgs((m) => { const l = m[m.length - 1]; return l?.role === 'assistant' ? [...m.slice(0, -1), { ...l, content: bufRef.current }] : m; });
  }, []);

  const ask = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || busy || !threadId) return;
    setInput(''); setBusy(true); setNotice(null); bufRef.current = '';
    setMsgs((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    try {
      for await (const ev of streamAssistant(threadId, text)) {
        if (ev.type === 'token' && ev.text) { bufRef.current += ev.text; if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush); }
        else if (ev.type === 'error') { setNotice(ev.message ?? 'failed'); }
      }
      flush();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'failed');
      setMsgs((m) => m.slice(0, -1));
    } finally { setBusy(false); }
  }, [busy, threadId, flush]);

  const newChat = useCallback(() => {
    if (busy) return;
    const id = newThreadId();
    window.localStorage.setItem(THREAD_KEY, id);
    setMsgs([]); setNotice(null); setInput('');
    setThreadId(id);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [busy]);

  return (
    <>
      {/* Toggle button — floats above the dashboard, bottom-right. */}
      <motion.button
        onClick={() => setOpen((o) => !o)}
        whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
        className="fixed bottom-5 right-5 z-40 flex h-12 items-center gap-2 rounded-full bg-gradient-to-br from-signal to-signal-dim px-4 text-carbon-950 shadow-glow"
        aria-label={open ? 'Close copilot' : 'Open insights copilot'}
      >
        {open ? <X className="h-5 w-5" strokeWidth={2.5} /> : <Sparkles className="h-5 w-5" strokeWidth={2.3} />}
        {!open && <span className="hidden text-sm font-semibold sm:inline">Ask Insights</span>}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
            className="fixed bottom-20 right-5 z-40 flex h-[min(560px,calc(100vh-7rem))] w-[min(400px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-carbon-700 bg-carbon-900/95 shadow-elevate backdrop-blur-xl"
          >
            {/* Header */}
            <header className="flex items-center gap-2.5 border-b border-carbon-800 px-3.5 py-2.5">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-signal to-signal-dim">
                <Sparkles className="h-4 w-4 text-carbon-950" />
              </div>
              <div className="min-w-0">
                <h2 className="font-display text-sm font-semibold leading-tight tracking-tight text-ink">Insights copilot</h2>
                <p className="flex items-center gap-1.5 text-[10px] text-ink-faint">
                  {busy ? <><LiveDot color="#4d9bff" /> thinking…</> : 'reads your live 24h metrics'}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={newChat} disabled={busy} title="New chat"
                  className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-carbon-800 hover:text-ink disabled:opacity-30">
                  <MessageSquarePlus className="h-4 w-4" />
                </button>
                <button onClick={() => setOpen(false)} title="Close"
                  className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-carbon-800 hover:text-ink">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </header>

            {/* Messages */}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
              {msgs.length === 0 ? (
                <div className="mt-6 text-center">
                  <div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-signal to-signal-dim shadow-glow">
                    <Sparkles className="h-5 w-5 text-carbon-950" />
                  </div>
                  <h3 className="mt-3 font-display text-sm font-semibold text-ink">Understand your numbers</h3>
                  <p className="mx-auto mt-1 max-w-[15rem] text-xs text-ink-muted">Ask about latency, cost, errors or tokens — the copilot sees your live dashboard.</p>
                  <div className="mt-4 grid gap-1.5">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} onClick={() => void ask(s)}
                        className="card card-hover px-3 py-2 text-left text-xs text-ink-muted">{s}</button>
                    ))}
                  </div>
                </div>
              ) : (
                msgs.map((m, i) => (
                  <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    className={`mb-3 flex gap-2 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    <div className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] ${m.role === 'user' ? 'bg-carbon-700 text-ink-muted' : 'bg-gradient-to-br from-signal to-signal-dim text-carbon-950'}`}>
                      {m.role === 'user' ? 'you' : <Sparkles className="h-3.5 w-3.5" />}
                    </div>
                    <div className={`max-w-[82%] rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-signal/15 text-ink' : 'bg-carbon-850 text-ink'}`}>
                      {m.role === 'user'
                        ? <div className="whitespace-pre-wrap">{m.content}</div>
                        : m.content ? <div className="text-[13px] leading-relaxed"><Markdown content={m.content} /></div>
                          : <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />}
                    </div>
                  </motion.div>
                ))
              )}
              {notice && <div className="mt-1 text-center text-[11px] text-danger">{notice}</div>}
            </div>

            {/* Input */}
            <footer className="border-t border-carbon-800 p-2.5">
              <div className="flex items-center gap-1.5 rounded-xl border border-carbon-700 bg-carbon-900/80 p-1.5 focus-within:border-signal/40 focus-within:shadow-glow">
                <input
                  ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
                  placeholder="Ask about your metrics…"
                  className="flex-1 bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-faint" />
                <button onClick={() => void ask(input)} disabled={busy || !input.trim()}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-signal text-carbon-950 hover:bg-signal-glow disabled:opacity-30">
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                </button>
              </div>
            </footer>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
