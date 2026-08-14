import { Suspense } from 'react';
import RequestsExplorer from '../../components/requests-explorer';

export default function RequestsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-zinc-500">loading…</div>}>
      <RequestsExplorer />
    </Suspense>
  );
}
