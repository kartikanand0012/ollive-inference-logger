import { Suspense } from 'react';
import Chat from '../components/chat/chat';

export default function Home() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-faint">loading…</div>}>
      <Chat />
    </Suspense>
  );
}
