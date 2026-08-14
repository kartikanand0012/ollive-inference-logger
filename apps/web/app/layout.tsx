import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ollive Inference Logger',
  description: 'Chat + LLM observability demo',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-screen bg-zinc-950 text-zinc-100 antialiased">
        <div className="flex h-full flex-col">
          <nav className="flex items-center gap-6 border-b border-zinc-800 px-4 py-2 text-sm">
            <span className="font-semibold tracking-tight">ollive</span>
            <Link href="/" className="text-zinc-400 hover:text-zinc-100">
              Chat
            </Link>
            <Link href="/dashboard" className="text-zinc-400 hover:text-zinc-100">
              Dashboard
            </Link>
            <Link href="/requests" className="text-zinc-400 hover:text-zinc-100">
              Requests
            </Link>
          </nav>
          <main className="min-h-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
