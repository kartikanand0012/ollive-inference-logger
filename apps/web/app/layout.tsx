import type { Metadata } from 'next';
import { display, body, mono } from '../lib/fonts';
import { Shell } from '../components/shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ollive Observatory',
  description: 'LLM inference logging, ingestion & runtime observability',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="font-sans">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
