'use client';
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, KeyRound, Loader2, Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import { activateProvider, fetchSettings, saveProviderKey, type SettingsInfo } from '../../lib/api';
import { Card } from '../../components/ui';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', hint: 'sk-ant-…', doc: 'console.anthropic.com' },
  { id: 'openai', label: 'OpenAI', hint: 'sk-…', doc: 'platform.openai.com' },
];

export default function SettingsPage() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const refresh = useCallback(() => { fetchSettings().then(setInfo).catch(() => undefined); }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-carbon-800 bg-carbon-950/70 px-5 py-3 backdrop-blur-md">
        <SettingsIcon className="h-5 w-5 text-signal" />
        <h1 className="font-display text-base font-semibold tracking-tight text-ink">Settings</h1>
      </header>

      <div className="mx-auto max-w-2xl space-y-4 p-5">
        <Card>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-signal/15"><KeyRound className="h-4.5 w-4.5 text-signal" /></div>
            <div>
              <h2 className="font-display text-sm font-medium text-ink">Provider API keys</h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                Add your own key to enable a provider. Keys are held <span className="text-ink">in memory only</span> — never written to disk or returned by the API.
                A production deployment would store them in a secrets manager / vault.
              </p>
            </div>
          </div>
        </Card>

        {info && info.configured.length > 1 && (
          <Card>
            <h2 className="font-display text-sm font-medium text-ink">Active provider</h2>
            <p className="mt-1 mb-3 text-xs text-ink-muted">Both providers are configured. Choose which one new chats use by default — activate one at a time.</p>
            <div className="flex gap-2">
              {info.configured.map((p) => (
                <button key={p} onClick={async () => { await activateProvider(p); refresh(); }}
                  className={`btn px-4 ${info.active === p ? 'bg-signal text-carbon-950' : 'border border-carbon-700 text-ink-muted hover:text-ink'}`}>
                  {info.active === p && <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-carbon-950" />}{p}
                </button>
              ))}
            </div>
          </Card>
        )}
        {PROVIDERS.map((p) => (
          <ProviderKeyCard key={p.id} p={p} status={info?.providers[p.id]} models={info?.models[p.id] ?? []} onSaved={refresh} />
        ))}
      </div>
    </div>
  );
}

function ProviderKeyCard({ p, status, models, onSaved }: {
  p: { id: string; label: string; hint: string; doc: string };
  status?: { configured: boolean; source: 'env' | 'runtime' | null }; models: string[]; onSaved: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    if (!key.trim()) return;
    setBusy(true); setMsg(null);
    const r = await saveProviderKey(p.id, key.trim());
    setBusy(false);
    if (r.ok) { setMsg({ ok: true, text: 'Key saved — provider enabled' }); setKey(''); onSaved(); }
    else setMsg({ ok: false, text: r.message ?? r.error ?? 'failed' });
  };

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-display text-sm font-medium text-ink">{p.label}</span>
          {status?.configured && (
            <span className="inline-flex items-center gap-1 rounded-full bg-live/15 px-2 py-0.5 text-[11px] font-medium text-live">
              <ShieldCheck className="h-3 w-3" /> {status.source === 'env' ? 'configured (env)' : 'configured'}
            </span>
          )}
        </div>
        <span className="font-mono text-[11px] text-ink-faint">{models.length} models</span>
      </div>
      <div className="flex gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`${p.hint}  (from ${p.doc})`}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} className="input flex-1 font-mono" />
        <button onClick={() => void save()} disabled={busy || !key.trim()} className="btn-primary disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </button>
      </div>
      {msg && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          className={`mt-2 flex items-center gap-1.5 text-xs ${msg.ok ? 'text-live' : 'text-danger'}`}>
          {msg.ok && <Check className="h-3.5 w-3.5" />} {msg.text}
        </motion.div>
      )}
      {models.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{models.map((m) => <span key={m} className="chip font-mono text-[10px]">{m}</span>)}</div>}
    </Card>
  );
}
