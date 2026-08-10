import { useEffect, useRef } from "react";
import { SLASH_COMMANDS, type SlashCommand } from "./slashCommands";

interface Props {
  query: string;
  onPick: (cmd: SlashCommand) => void;
  onClose: () => void;
}

export default function SlashMenu({ query, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const filtered = SLASH_COMMANDS.filter((c) =>
    (c.label + c.hint).toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[280px] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl"
    >
      <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Slash 命令
      </p>
      {filtered.map((c) => (
        <button
          key={c.id}
          onClick={() => onPick(c)}
          className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
        >
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <c.icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{c.label}</p>
            <p className="truncate text-xs text-muted-foreground">{c.hint}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
