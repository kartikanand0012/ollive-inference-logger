'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { MessageSquare, LayoutDashboard, ListTree, Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { API_URL } from '../lib/api';
import { LiveDot } from './ui';

const NAV = [
  { href: '/', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/requests', label: 'Requests', icon: ListTree },
];

function useApiHealth() {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const ping = () =>
      fetch(`${API_URL}/healthz`, { cache: 'no-store' })
        .then((r) => alive && setOk(r.ok))
        .catch(() => alive && setOk(false));
    ping();
    const t = setInterval(ping, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return ok;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const health = useApiHealth();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <div className="grain flex h-screen">
      <nav className="relative z-10 flex w-16 flex-col items-center border-r border-carbon-800 bg-carbon-900/60 py-4 backdrop-blur-md md:w-56 md:items-stretch md:px-3">
        <Link href="/" className="mb-6 flex items-center gap-2.5 md:px-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-signal to-signal-dim shadow-glow">
            <Activity className="h-5 w-5 text-carbon-950" strokeWidth={2.5} />
          </div>
          <div className="hidden md:block">
            <div className="font-display text-sm font-semibold leading-none tracking-tight text-ink">ollive</div>
            <div className="mt-1 text-[10px] uppercase tracking-widest text-ink-faint">observatory</div>
          </div>
        </Link>

        <div className="flex flex-1 flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link key={href} href={href}
                className={`group relative flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm transition-colors md:px-3 ${active ? 'text-ink' : 'text-ink-faint hover:text-ink-muted'}`}>
                {active && <motion.span layoutId="navactive" className="absolute inset-0 rounded-lg border border-signal/25 bg-signal/10" transition={{ type: 'spring', stiffness: 380, damping: 30 }} />}
                <Icon className="relative z-10 h-5 w-5 shrink-0" strokeWidth={active ? 2.3 : 1.9} />
                <span className="relative z-10 hidden font-medium md:inline">{label}</span>
              </Link>
            );
          })}
        </div>

        <div className="mt-auto flex items-center gap-2 rounded-lg px-2.5 py-2 md:border md:border-carbon-800 md:px-3">
          <LiveDot color={health === false ? '#ef7a63' : '#43c493'} />
          <span className="hidden text-[11px] font-medium text-ink-muted md:inline">
            {health === false ? 'api offline' : health === null ? 'connecting…' : 'live'}
          </span>
        </div>
      </nav>

      <main className="relative z-10 min-h-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
