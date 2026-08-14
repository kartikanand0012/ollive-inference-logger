import { Suspense } from 'react';
import Chat from '../components/chat';

export default function Home() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-zinc-500">loading…</div>}>
      <Chat />
    </Suspense>
  );
}
