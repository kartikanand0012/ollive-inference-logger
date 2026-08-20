'use client';
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String((children as { props?: { children?: unknown } })?.props?.children ?? '');
  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-carbon-700 bg-carbon-950">
      <button
        onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        className="absolute right-2 top-2 z-10 rounded-md border border-carbon-700 bg-carbon-800/80 p-1.5 text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
        aria-label="copy code"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-live" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-chat text-[14px] leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children }) =>
            className ? <code className={className}>{children}</code>
            : <code className="rounded bg-carbon-800 px-1.5 py-0.5 font-mono text-[13px] text-signal-glow">{children}</code>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-signal underline underline-offset-2 hover:text-signal-glow">{children}</a>,
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1">{children}</ol>,
          h1: ({ children }) => <h1 className="mb-2 mt-1 font-display text-lg font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-1 font-display text-base font-semibold">{children}</h2>,
          table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="w-full text-left text-xs">{children}</table></div>,
          th: ({ children }) => <th className="border-b border-carbon-700 px-2 py-1 font-medium text-ink-muted">{children}</th>,
          td: ({ children }) => <td className="border-b border-carbon-800 px-2 py-1">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
