'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Poll a fetcher on an interval with stale-while-revalidate (no flicker on refresh). */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  intervalMs = 10_000,
): { data: T | null; loading: boolean; stale: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const r = await fetcherRef.current();
        if (!alive) return;
        setData(r);
        setStale(false);
        setLoading(false);
      } catch {
        if (alive) setStale(true);
      }
    };
    setLoading((prev) => (data === null ? true : prev)); // keep old data visible
    void run();
    const t = setInterval(run, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, stale };
}

export type Filters = Record<string, string>;

/** Filter state mirrored to the URL (shareable, back-button friendly), debounced writes. */
export function useUrlFilters(defaults: Filters): {
  filters: Filters;
  set: (k: string, v: string) => void;
  reset: () => void;
  active: number;
} {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => {
    const f = { ...defaults };
    for (const k of Object.keys(defaults)) {
      const v = params.get(k);
      if (v !== null) f[k] = v;
    }
    return f;
  });
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = useCallback(
    (k: string, v: string) => {
      setFilters((prev) => {
        const next = { ...prev, [k]: v };
        if (writeTimer.current) clearTimeout(writeTimer.current);
        writeTimer.current = setTimeout(() => {
          const qs = new URLSearchParams();
          for (const [key, val] of Object.entries(next)) if (val && val !== defaults[key]) qs.set(key, val);
          router.replace(`${pathname}${qs.toString() ? `?${qs}` : ''}`, { scroll: false });
        }, 250);
        return next;
      });
    },
    [defaults, pathname, router],
  );

  const reset = useCallback(() => {
    setFilters({ ...defaults });
    router.replace(pathname, { scroll: false });
  }, [defaults, pathname, router]);

  const active = Object.keys(defaults).filter(
    (k) => filters[k] && filters[k] !== defaults[k] && k !== 'window',
  ).length;

  return { filters, set, reset, active };
}

/** Smoothly counts a number toward its target (stat-card count-up). */
export function useAnimatedNumber(target: number, ms = 600): number {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef(0);
  const rafRef = useRef<number>();

  useEffect(() => {
    fromRef.current = val;
    startRef.current = 0;
    const step = (t: number) => {
      if (!startRef.current) startRef.current = t;
      const p = Math.min(1, (t - startRef.current) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(fromRef.current + (target - fromRef.current) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return val;
}

/** Filters → query string for the stats/logs endpoints. */
export function filtersToQuery(filters: Filters, keys: string[]): string {
  const qs = new URLSearchParams();
  for (const k of keys) if (filters[k]) qs.set(k, filters[k]!);
  return qs.toString();
}
