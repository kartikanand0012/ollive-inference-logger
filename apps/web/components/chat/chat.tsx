'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, ArrowUp, Copy, Check, Plus, Search, Square, User, Sparkles } from 'lucide-react';
import {
  cancelConversation, fetchConversations, fetchMessages, fetchMeta, getSessionId, streamChat,
  type Conversation,
} from '../../lib/api';
import { Markdown } from './markdown';
import { LiveDot } from '../ui';

interface Meta { latencyMs?: number; ttfbMs?: number; totalTokens?: number; }
interface UiMessage { role: 'user' | 'assistant' | 'system'; content: string; status?: 'complete' | 'cancelled' | 'error'; meta?: Meta; }

export default function Chat() {
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<UiMessage[]>([]);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [configured, setConfigured] = useState<string[]>([]);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [convSearch, setConvSearch] = useState('');
  const [atBottom, setAtBottom] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null); activeIdRef.current = activeId;
  const streamConvRef = useRef<string | null>(null);
  const loadSeqRef = useRef(0);
  const deepLinkApplied = useRef(false);
  const pickerSync = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // ── smooth streaming: buffer tokens in a ref, flush to state via rAF ──
  const bufferRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const flush = useCallback(() => {
    rafRef.current = null;
    if (activeIdRef.current !== streamConvRef.current) return;
    setMsgs((m) => {
      const last = m[m.length - 1];
      if (!last || last.role !== 'assistant') return m;
      if (last.content === bufferRef.current) return m;
      return [...m.slice(0, -1), { ...last, content: bufferRef.current }];
    });
  }, []);
  const schedule = useCallback(() => { if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush); }, [flush]);

  const refreshConversations = useCallback(() => {
    fetchConversations().then(setConversations).catch(() => setNotice('api unreachable'));
  }, []);

  useEffect(() => {
    refreshConversations();
    fetchMeta().then((meta) => {
      setModels(meta.models); setConfigured(meta.providers);
      const first = meta.providers[0] ?? 'anthropic';
      setProvider(first); setModel(meta.models[first]?.[0] ?? '');
    }).catch(() => setNotice('api unreachable'));
  }, [refreshConversations]);

  // deep link /?c=<id>
  useEffect(() => {
    const c = searchParams.get('c');
    if (!c || deepLinkApplied.current) return;
    deepLinkApplied.current = true; pickerSync.current = true;
    setActiveId(c);
    fetchMessages(c).then((rows) => setMsgs(rows.map((r) => ({ role: r.role, content: r.content, status: r.status })))).catch(() => setNotice('failed to load conversation'));
  }, [searchParams]);
  useEffect(() => {
    if (!pickerSync.current) return;
    const conv = conversations.find((x) => x.id === activeIdRef.current);
    if (conv) { pickerSync.current = false; setProvider(conv.provider); setModel(conv.model); }
  }, [conversations]);

  // scroll anchoring
  const onScroll = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, []);
  useEffect(() => { if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [msgs, atBottom]);

  // auto-grow textarea
  useEffect(() => {
    const ta = taRef.current; if (!ta) return;
    ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const openConversation = useCallback((c: Conversation) => {
    setActiveId(c.id); setProvider(c.provider); setModel(c.model); setNotice(null); setAtBottom(true);
    const seq = ++loadSeqRef.current;
    fetchMessages(c.id).then((rows) => { if (loadSeqRef.current === seq) setMsgs(rows.map((r) => ({ role: r.role, content: r.content, status: r.status }))); })
      .catch(() => { if (loadSeqRef.current === seq) setNotice('failed to load messages'); });
  }, []);

  const newConversation = useCallback(() => { setActiveId(null); setMsgs([]); setNotice(null); setAtBottom(true); taRef.current?.focus(); }, []);

  const send = useCallback(async () => {
    const text = input.trim(); if (!text || busy) return;
    setInput(''); setNotice(null); setBusy(true); setAtBottom(true);
    const origin = activeIdRef.current; streamConvRef.current = origin;
    bufferRef.current = '';
    setMsgs((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    const viewing = () => activeIdRef.current === streamConvRef.current;
    try {
      for await (const ev of streamChat({ conversationId: origin ?? undefined, message: text, provider, model, sessionId: getSessionId() })) {
        if (ev.type === 'start') { streamConvRef.current = ev.conversationId; if (activeIdRef.current === origin) setActiveId(ev.conversationId); }
        else if (ev.type === 'token') { bufferRef.current += ev.text; schedule(); }
        else if (ev.type === 'done') {
          flush();
          if (viewing()) setMsgs((m) => { const l = m[m.length-1]; if (l?.role!=='assistant') return m;
            return [...m.slice(0,-1), { ...l, status: ev.cancelled ? 'cancelled' : l.status, meta: { latencyMs: ev.latencyMs, ttfbMs: ev.ttfbMs, totalTokens: ev.totalTokens } }]; });
        }
        else if (ev.type === 'error') { flush(); if (viewing()) { setNotice(ev.message); setMsgs((m) => { const l = m[m.length-1]; return l?.role==='assistant' ? [...m.slice(0,-1), {...l, status:'error'}] : m; }); } }
      }
    } catch (err) {
      if (viewing()) { setNotice(err instanceof Error ? err.message : 'request failed'); setMsgs((m) => m.slice(0, -1)); }
    } finally { streamConvRef.current = null; setBusy(false); refreshConversations(); }
  }, [busy, input, model, provider, refreshConversations, schedule, flush]);

  const stop = useCallback(() => { const id = streamConvRef.current ?? activeIdRef.current; if (id) void cancelConversation(id); }, []);

  const filteredConvs = useMemo(() =>
    conversations.filter((c) => !convSearch || (c.title ?? '').toLowerCase().includes(convSearch.toLowerCase())),
  [conversations, convSearch]);

  return (
    <div className="flex h-full">
      {/* conversation rail */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-carbon-800 bg-carbon-900/40 md:flex">
        <div className="p-3">
          <button onClick={newConversation} className="btn-primary w-full"><Plus className="h-4 w-4" /> New conversation</button>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input value={convSearch} onChange={(e) => setConvSearch(e.target.value)} placeholder="Search conversations" className="input w-full pl-8 text-xs" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <AnimatePresence initial={false}>
            {filteredConvs.map((c) => (
              <motion.button key={c.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => openConversation(c)}
                className={`mb-1 block w-full rounded-lg px-3 py-2.5 text-left transition-colors ${c.id === activeId ? 'border border-signal/25 bg-signal/10' : 'border border-transparent hover:bg-carbon-800/70'}`}>
                <div className="truncate text-sm text-ink">{c.title ?? 'Untitled'}</div>
                <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10px] text-ink-faint">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.status === 'cancelled' ? '#e0a43a' : '#4d9bff' }} />
                  {c.provider} · {c.model}
                </div>
              </motion.button>
            ))}
          </AnimatePresence>
          {filteredConvs.length === 0 && <div className="px-3 py-6 text-center text-xs text-ink-faint">no conversations yet</div>}
        </div>
      </aside>

      {/* chat pane */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-carbon-800 px-4 py-2.5">
          <PickerSelect value={provider} onChange={(v) => { setProvider(v); setModel(models[v]?.[0] ?? ''); }}
            options={Object.keys(models).map((p) => ({ value: p, label: configured.includes(p) ? p : `${p} (no key)` }))} />
          <PickerSelect value={model} onChange={setModel} options={(models[provider] ?? []).map((m) => ({ value: m, label: m }))} />
          {notice && <span className="ml-1 truncate text-xs text-danger">{notice}</span>}
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-faint">
            {busy ? <><LiveDot color="#4d9bff" /> streaming</> : <>ready</>}
          </div>
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            {msgs.length === 0 && <Welcome onPick={(t) => setInput(t)} />}
            {msgs.map((m, i) => <Message key={i} m={m} streaming={busy && i === msgs.length - 1 && m.role === 'assistant'} />)}
          </div>
          <AnimatePresence>
            {!atBottom && (
              <motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
                onClick={() => { setAtBottom(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
                className="sticky bottom-4 left-1/2 z-10 mx-auto flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-carbon-700 bg-carbon-800 text-ink-muted shadow-elevate hover:text-ink">
                <ArrowDown className="h-4 w-4" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        <footer className="border-t border-carbon-800 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-carbon-700 bg-carbon-900/80 p-2 transition-colors focus-within:border-signal/40 focus-within:shadow-glow">
            <textarea ref={taRef} value={input} onChange={(e) => setInput(e.target.value)} rows={1}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Message the model…  (Enter to send, Shift+Enter for newline)"
              className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint" />
            {busy
              ? <button onClick={stop} className="grid h-9 w-9 place-items-center rounded-xl bg-danger text-carbon-950 transition-transform hover:scale-105"><Square className="h-4 w-4" fill="currentColor" /></button>
              : <button onClick={() => void send()} disabled={!input.trim()} className="grid h-9 w-9 place-items-center rounded-xl bg-signal text-carbon-950 transition-all hover:bg-signal-glow disabled:opacity-30"><ArrowUp className="h-4 w-4" strokeWidth={2.5} /></button>}
          </div>
        </footer>
      </section>
    </div>
  );
}

function PickerSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)} className="input cursor-pointer py-1.5 text-xs">{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}

function Welcome({ onPick }: { onPick: (t: string) => void }) {
  const prompts = ['Explain what an idempotent consumer is, briefly.', 'Write a haiku about observability.', 'Give me 3 Postgres indexing tips.'];
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-20 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-signal to-signal-dim shadow-glow"><Sparkles className="h-7 w-7 text-carbon-950" /></div>
      <h1 className="mt-5 font-display text-xl font-semibold tracking-tight text-ink">Start a conversation</h1>
      <p className="mt-1 text-sm text-ink-muted">Every message is auto-instrumented — watch it appear on the dashboard.</p>
      <div className="mx-auto mt-6 flex max-w-md flex-col gap-2">
        {prompts.map((p) => <button key={p} onClick={() => onPick(p)} className="card card-hover px-3 py-2.5 text-left text-sm text-ink-muted">{p}</button>)}
      </div>
    </motion.div>
  );
}

function Message({ m, streaming }: { m: UiMessage; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const isUser = m.role === 'user';
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className={`group mb-5 flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${isUser ? 'bg-carbon-700' : 'bg-gradient-to-br from-signal to-signal-dim'}`}>
        {isUser ? <User className="h-4 w-4 text-ink-muted" /> : <Sparkles className="h-4 w-4 text-carbon-950" />}
      </div>
      <div className={`min-w-0 max-w-[80%] ${isUser ? 'text-right' : ''}`}>
        <div className={`inline-block rounded-2xl px-3.5 py-2.5 text-left ${isUser ? 'bg-signal/15 text-ink' : 'bg-carbon-850 text-ink'}`}>
          {isUser ? <div className="whitespace-pre-wrap text-[14px] leading-relaxed">{m.content}</div>
            : <>
                {m.content ? <Markdown content={m.content} /> : streaming ? <span className="inline-flex gap-1"><Dot/><Dot d={0.15}/><Dot d={0.3}/></span> : null}
                {streaming && m.content && <span className="ml-0.5 inline-block h-4 w-[3px] animate-caret bg-signal align-middle" />}
              </>}
        </div>
        <div className={`mt-1 flex items-center gap-2 px-1 text-[11px] text-ink-faint ${isUser ? 'justify-end' : ''}`}>
          {m.status === 'cancelled' && <span className="text-warn">stopped</span>}
          {m.status === 'error' && <span className="text-danger">error</span>}
          {!isUser && m.meta && (m.meta.latencyMs != null) && (
            <span className="flex items-center gap-2 font-mono text-ink-faint">
              <span>{m.meta.latencyMs}ms</span>
              {m.meta.ttfbMs != null && <span>· ttft {m.meta.ttfbMs}ms</span>}
              {m.meta.totalTokens != null && <span>· {m.meta.totalTokens} tok</span>}
            </span>
          )}
          {!isUser && m.content && (
            <button onClick={() => { navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
              className="flex items-center gap-1 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100">
              {copied ? <><Check className="h-3 w-3 text-live" /> copied</> : <><Copy className="h-3 w-3" /> copy</>}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function Dot({ d = 0 }: { d?: number }) {
  return <motion.span className="h-1.5 w-1.5 rounded-full bg-ink-faint" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: d }} />;
}
