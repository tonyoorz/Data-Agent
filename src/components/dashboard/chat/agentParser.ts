// Parses the streaming assistant text into structured segments.
// The model emits:
//   <think>...</think>           reasoning
//   <step title="x" source="y">summary</step>   tool/analysis steps
//   <cite source="x">label</cite> inline citations (kept inside text segments)
// Anything else is treated as final markdown body text.

export type AgentSegment =
  | { kind: "think"; text: string; closed: boolean }
  | {
      kind: "step";
      title: string;
      source?: string;
      text: string;
      closed: boolean;
    }
  | { kind: "text"; text: string };

const TAG_RE = /<(think|step)(\s[^>]*)?>|<\/(think|step)>/i;

function getAttr(attrs: string | undefined, name: string): string | undefined {
  if (!attrs) return undefined;
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m?.[1];
}

export function parseAgentStream(raw: string): AgentSegment[] {
  const out: AgentSegment[] = [];
  let rest = raw;

  while (rest.length) {
    const m = rest.match(TAG_RE);
    if (!m) {
      pushText(out, rest);
      break;
    }
    const before = rest.slice(0, m.index!);
    if (before) pushText(out, before);
    const tag = m[0];
    const openName = m[1]?.toLowerCase();
    const closeName = m[3]?.toLowerCase();
    rest = rest.slice(m.index! + tag.length);

    if (openName) {
      // opening tag — find matching close in remaining text
      const closeRe = new RegExp(`</${openName}>`, "i");
      const cm = rest.match(closeRe);
      const inner = cm ? rest.slice(0, cm.index!) : rest;
      const closed = !!cm;
      if (openName === "think") {
        out.push({ kind: "think", text: inner, closed });
      } else {
        const attrs = m[2];
        out.push({
          kind: "step",
          title: getAttr(attrs, "title") || "分析步骤",
          source: getAttr(attrs, "source"),
          text: inner,
          closed,
        });
      }
      rest = cm ? rest.slice(cm.index! + cm[0].length) : "";
    } else if (closeName) {
      // stray close — ignore
    }
  }

  return out;
}

function pushText(out: AgentSegment[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

// Convert segments back to plain text (used for copy-to-clipboard).
export function segmentsToPlainText(segs: AgentSegment[]): string {
  return segs
    .filter((s) => s.kind === "text")
    .map((s) => (s as { text: string }).text.replace(/<\/?cite[^>]*>/gi, ""))
    .join("")
    .trim();
}
