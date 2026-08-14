'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  cancelConversation,
  fetchConversations,
  fetchMessages,
  fetchMeta,
  getSessionId,
  streamChat,
  type Conversation,
} from '../lib/api';

interface UiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  status?: 'complete' | 'cancelled' | 'error';
}

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
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const deepLinkApplied = useRef(false);
  const pickerNeedsSync = useRef(false);
  // Conversation the in-flight stream belongs to — UI updates are gated on it
  // so switching conversations mid-stream can't corrupt the visible pane.
  const streamConvRef = useRef<string | null>(null);
  // Monotonic fetch counter: a slow fetchMessages response for a conversation
  // the user already navigated away from must not clobber the current pane.
  const loadSeqRef = useRef(0);

  const refreshConversations = useCallback(() => {
    fetchConversations().then(setConversations).catch(() => setNotice('api unreachable'));
  }, []);

  useEffect(() => {
    refreshConversations();
    fetchMeta()
      .then((meta) => {
        setModels(meta.models);
        setConfigured(meta.providers);
        const first = meta.providers[0] ?? 'anthropic';
        setProvider(first);
        setModel(meta.models[first]?.[0] ?? '');
      })
      .catch(() => setNotice('api unreachable'));
  }, [refreshConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  // Deep link from the requests explorer: /?c=<conversationId> opens that
  // conversation directly (resume path), even if it's not in the sidebar yet.
  useEffect(() => {
    const c = searchParams.get('c');
    if (!c || deepLinkApplied.current) return;
    deepLinkApplied.current = true;
    pickerNeedsSync.current = true;
    setActiveId(c);
    fetchMessages(c)
      .then((rows) =>
        setMsgs(rows.map((r) => ({ role: r.role, content: r.content, status: r.status }))),
      )
      .catch(() => setNotice('failed to load conversation'));
  }, [searchParams]);

  // Once the sidebar list arrives, align the provider/model picker with the
  // deep-linked conversation (one-shot — never fights later manual changes).
  useEffect(() => {
    if (!pickerNeedsSync.current) return;
    const conv = conversations.find((x) => x.id === activeIdRef.current);
    if (conv) {
      pickerNeedsSync.current = false;
      setProvider(conv.provider);
      setModel(conv.model);
    }
  }, [conversations]);

  const openConversation = useCallback((c: Conversation) => {
    setActiveId(c.id);
    setProvider(c.provider);
    setModel(c.model);
    setNotice(null);
    const seq = ++loadSeqRef.current;
    fetchMessages(c.id)
      .then((rows) => {
        if (loadSeqRef.current !== seq) return; // stale response — user moved on
        setMsgs(rows.map((r) => ({ role: r.role, content: r.content, status: r.status })));
      })
      .catch(() => {
        if (loadSeqRef.current === seq) setNotice('failed to load messages');
      });
  }, []);

  const newConversation = useCallback(() => {
    setActiveId(null);
    setMsgs([]);
    setNotice(null);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setNotice(null);
    setBusy(true);
    const origin = activeIdRef.current; // conversation the user was viewing at send
    streamConvRef.current = origin;
    setMsgs((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);

    // Every UI mutation below is gated on still-viewing the stream's
    // conversation — switching or creating a conversation mid-stream must
    // never touch the newly visible pane (the server persists regardless).
    const viewing = () => activeIdRef.current === streamConvRef.current;
    const patchLastAssistant = (patch: (last: UiMessage) => UiMessage) => {
      setMsgs((m) => {
        const last = m[m.length - 1];
        if (!last || last.role !== 'assistant') return m;
        return [...m.slice(0, -1), patch(last)];
      });
    };

    try {
      for await (const ev of streamChat({
        conversationId: origin ?? undefined,
        message: text,
        provider,
        model,
        sessionId: getSessionId(),
      })) {
        if (ev.type === 'start') {
          streamConvRef.current = ev.conversationId;
          // Adopt the new conversation id only if the user hasn't navigated.
          if (activeIdRef.current === origin) setActiveId(ev.conversationId);
        } else if (ev.type === 'token') {
          if (viewing()) patchLastAssistant((last) => ({ ...last, content: last.content + ev.text }));
        } else if (ev.type === 'done') {
          if (ev.cancelled && viewing()) {
            patchLastAssistant((last) => ({ ...last, status: 'cancelled' }));
          }
        } else if (ev.type === 'error') {
          if (viewing()) {
            setNotice(ev.message);
            patchLastAssistant((last) => ({ ...last, status: 'error' }));
          }
        }
      }
    } catch (err) {
      if (viewing()) {
        setNotice(err instanceof Error ? err.message : 'request failed');
        setMsgs((m) => m.slice(0, -1));
      }
    } finally {
      streamConvRef.current = null;
      setBusy(false);
      refreshConversations();
    }
  }, [busy, input, model, provider, refreshConversations]);

  const stop = useCallback(() => {
    // Cancel the conversation that is actually streaming — not whichever one
    // the user happens to be looking at.
    const id = streamConvRef.current ?? activeIdRef.current;
    if (id) void cancelConversation(id);
  }, []);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800">
        <div className="p-3">
          <button
            onClick={newConversation}
            className="w-full rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white"
          >
            + New conversation
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => openConversation(c)}
              className={`mb-1 block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-zinc-800 ${
                c.id === activeId ? 'bg-zinc-800' : ''
              }`}
            >
              <div className="truncate">{c.title ?? 'Untitled'}</div>
              <div className="truncate text-xs text-zinc-500">
                {c.provider} · {c.model}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Main pane */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-sm">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(models[e.target.value]?.[0] ?? '');
            }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1"
          >
            {Object.keys(models).map((p) => (
              <option key={p} value={p}>
                {p}
                {configured.includes(p) ? '' : ' (no key)'}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1"
          >
            {(models[provider] ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {notice && <span className="ml-2 truncate text-xs text-red-400">{notice}</span>}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {msgs.length === 0 && (
            <p className="mt-16 text-center text-sm text-zinc-500">
              Send a message to start a conversation.
            </p>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : ''}`}>
              <div
                className={`max-w-[75%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-zinc-800'
                }`}
              >
                {m.content || (busy && i === msgs.length - 1 ? '…' : '')}
                {m.status === 'cancelled' && (
                  <span className="ml-2 text-xs italic text-amber-400">[stopped]</span>
                )}
                {m.status === 'error' && (
                  <span className="ml-2 text-xs italic text-red-400">[error]</span>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <footer className="border-t border-zinc-800 p-3">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder="Message… (Enter to send)"
              className="min-w-0 flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            />
            {busy ? (
              <button
                onClick={stop}
                className="rounded-md bg-red-600 px-4 text-sm font-medium hover:bg-red-500"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => void send()}
                className="rounded-md bg-blue-600 px-4 text-sm font-medium hover:bg-blue-500"
              >
                Send
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
