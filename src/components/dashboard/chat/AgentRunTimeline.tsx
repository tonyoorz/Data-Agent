import { CheckCircle2, CircleAlert, Clock3, Database, Wrench } from "lucide-react";

type AgentEvent = {
  type: string;
  payload?: Record<string, any>;
};

interface Props {
  events: AgentEvent[];
}

const SECRET_KEYS = /credential|secret|token|cookie|access.?code|authorization|password/i;

function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEYS.test(key))
        .map(([key, item]) => [key, redact(item)]),
    );
  }
  return value;
}

function compact(value: any) {
  const text = typeof value === "string" ? value : JSON.stringify(redact(value));
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function timelineItem(event: AgentEvent) {
  switch (event.type) {
    case "run.started":
      return { icon: Clock3, label: "Run started", detail: `${event.payload?.runtimeMode || "runtime"} · ${event.payload?.actualModelId || "model"}` };
    case "ontology.resolved":
      return { icon: Database, label: "Semantics", detail: `${event.payload?.mode || "unknown"} · ${event.payload?.semanticFrameRef?.ontologyVersion || "legacy-provisional"}` };
    case "plan.validated":
      return { icon: CheckCircle2, label: "Plan validated", detail: (event.payload?.toolNames || []).join(", ") || "no tools" };
    case "tool.started":
      return { icon: Wrench, label: "Tool started", detail: `${event.payload?.toolName || "tool"} ${compact(event.payload?.redactedCanonicalArgs || {})}` };
    case "tool.completed":
      return { icon: CheckCircle2, label: "Tool completed", detail: `${event.payload?.status || "succeeded"} · ${(event.payload?.evidenceIds || []).join(", ")}` };
    case "tool.failed":
      return { icon: CircleAlert, label: "Tool failed", detail: event.payload?.safeMessage || event.payload?.code || "failed" };
    case "evidence.added":
      return { icon: Database, label: "Evidence", detail: `${event.payload?.groundingStatus || "legacy_equivalence"} · ${(event.payload?.evidenceIds || []).join(", ")}` };
    case "claims.validated":
      return { icon: CheckCircle2, label: "Claims validated", detail: `${(event.payload?.acceptedClaimIds || []).length} accepted · ${(event.payload?.rejectedClaimIds || []).length} rejected` };
    case "clarification.required":
      return { icon: CircleAlert, label: "Clarification required", detail: event.payload?.question || "waiting for input" };
    case "run.completed":
      return { icon: CheckCircle2, label: "Run completed", detail: `${event.payload?.durationMs ?? 0} ms` };
    case "run.failed":
      return { icon: CircleAlert, label: "Run failed", detail: event.payload?.safeMessage || event.payload?.code || "failed" };
    case "run.cancelled":
      return { icon: CircleAlert, label: "Run cancelled", detail: event.payload?.reasonCode || "cancelled" };
    default:
      if (event.type === "answer.delta") return null;
      return { icon: CircleAlert, label: "Protocol event", detail: "Unsupported public event" };
  }
}

export default function AgentRunTimeline({ events }: Props) {
  const items = events.map(timelineItem).filter(Boolean) as Array<{ icon: typeof Clock3; label: string; detail: string }>;
  if (!items.length) return null;

  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/30 p-2" aria-label="Agent run timeline">
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <div key={`${item.label}-${index}`} className="flex items-start gap-2 text-xs text-muted-foreground">
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <span className="font-medium text-foreground">{item.label}</span>
              {item.detail && <span className="ml-1 break-words">{item.detail}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}