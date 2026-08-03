import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain,
  ChevronDown,
  Check,
  Copy,
  Database,
  Loader2,
  Wrench,
} from "lucide-react";
import { AgentSegment, parseAgentStream } from "./agentParser";

interface Props {
  content: string;
  streaming: boolean;
}

// Replaces <cite source="x">label</cite> in markdown with a custom token,
// then renders a clickable chip via remark-react custom components.
// Simpler: pre-process text to ` [label](#cite:source) ` so react-markdown renders a link, we restyle in components.
function preprocessCitations(md: string) {
  return md.replace(
    /<cite\s+source="([^"]+)">([^<]+)<\/cite>/gi,
    (_m, src, label) => `[${label}](#cite:${encodeURIComponent(src)})`,
  );
}

export default function MessageRenderer({ content, streaming }: Props) {
  const segs = parseAgentStream(content);
  return (
    <div className="space-y-3">
      {segs.map((s, i) => {
        if (s.kind === "think")
          return <ThinkBlock key={i} text={s.text} closed={s.closed} streaming={streaming} />;
        if (s.kind === "step")
          return (
            <StepBlock
              key={i}
              title={s.title}
              source={s.source}
              text={s.text}
              closed={s.closed}
            />
          );
        return <TextBlock key={i} text={s.text} />;
      })}
    </div>
  );
}

function ThinkBlock({
  text,
  closed,
  streaming,
}: {
  text: string;
  closed: boolean;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = streaming && !closed;
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {active ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Brain className="h-3 w-3" />
        )}
        <span>{active ? "思考中…" : "思考过程"}</span>
        <ChevronDown
          className={`ml-auto h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <p className="whitespace-pre-wrap px-3 pb-2.5 pt-0.5 text-xs leading-relaxed text-muted-foreground">
              {text.trim()}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StepBlock({
  title,
  source,
  text,
  closed,
}: {
  title: string;
  source?: string;
  text: string;
  closed: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2"
    >
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {closed ? <Wrench className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-xs font-semibold text-foreground">{title}</p>
          {source && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              <Database className="h-2.5 w-2.5" />
              {source}
            </span>
          )}
        </div>
        {text.trim() && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {text.trim()}
          </p>
        )}
      </div>
    </motion.div>
  );
}

function TextBlock({ text }: { text: string }) {
  const md = preprocessCitations(text);
  return (
    <div className="prose prose-sm max-w-none break-words text-foreground prose-headings:font-semibold prose-headings:text-foreground prose-p:my-2 prose-p:leading-relaxed prose-strong:text-foreground prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-table:text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (href?.startsWith("#cite:")) {
              const source = decodeURIComponent(href.slice(6));
              return <CitationChip source={source}>{children}</CitationChip>;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                {children}
              </a>
            );
          },
          pre({ children }) {
            return <CodeBlock>{children}</CodeBlock>;
          },
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}

function CitationChip({ source, children }: { source: string; children: ReactNode }) {
  return (
    <span
      title={`来源: ${source}`}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-1.5 py-0 align-baseline text-[11px] font-medium text-primary no-underline hover:bg-primary/10"
    >
      <Database className="h-2.5 w-2.5" />
      {children}
    </span>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeText =
    (isValidElement<{ children?: ReactNode }>(children) && typeof children.props.children === "string"
      ? children.props.children
      : "") ||
    (typeof children === "string" ? children : "");
  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-border bg-[hsl(220_15%_15%)]">
      <button
        onClick={() => {
          navigator.clipboard.writeText(String(codeText));
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
        className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-white/5 text-white/70 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
        title="复制代码"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre className="!my-0 !bg-transparent overflow-x-auto p-4 text-[12.5px] leading-relaxed text-white/90">
        {children}
      </pre>
    </div>
  );
}
