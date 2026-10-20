import { cn } from "@/lib/utils";
import { useAssistantActivity } from "@/api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Fledge, the fledgling: the assistant's face. Static unless it sits inside `.mascot`. */
export function MascotBird({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <ellipse cx="32" cy="61" rx="14" ry="2.2" fill="currentColor" opacity="0.15" />
      <g className="mascot-bird">
        <g className="mascot-tilt">
          <path d="M31 13c-2-4 0-8 4-9-1 3 0 6 2 7-2 0-4 1-6 2z" fill="var(--mascot-wing)" />
          <path d="M28 14c-3-2-3-6-1-8 0 3 2 5 4 6z" fill="var(--mascot-wing)" />
          <path className="mascot-wing-left" d="M15 31c-7 2-9 10-5 15 4-1 8-6 8-12z" fill="var(--mascot-wing)" />
          <path className="mascot-wing-right" d="M49 31c7 2 9 10 5 15-4-1-8-6-8-12z" fill="var(--mascot-wing)" />
          <ellipse cx="32" cy="36" rx="18.5" ry="21" fill="var(--mascot-body)" />
          <ellipse cx="32" cy="44" rx="12" ry="10.5" fill="var(--mascot-belly)" />
          <ellipse cx="21.5" cy="38" rx="3" ry="1.8" fill="var(--mascot-cheek)" opacity="0.55" />
          <ellipse cx="42.5" cy="38" rx="3" ry="1.8" fill="var(--mascot-cheek)" opacity="0.55" />
          <g className="mascot-eyes">
            <circle cx="25.5" cy="31.5" r="3.2" fill="var(--mascot-ink)" />
            <circle cx="38.5" cy="31.5" r="3.2" fill="var(--mascot-ink)" />
            <circle cx="26.6" cy="30.4" r="1.05" fill="white" />
            <circle cx="39.6" cy="30.4" r="1.05" fill="white" />
          </g>
          <path d="M28.6 35.6h6.8L32 40.2z" fill="var(--mascot-beak)" stroke="var(--mascot-beak)" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M27 56.5v3m-2 0h4m10-3v3m-2 0h4" stroke="var(--mascot-beak)" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}

/** The assistant's launcher in the bottom-right corner. It shows when the assistant is working, and hops when an action waits for an answer. */
export function Mascot({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { working, waiting } = useAssistantActivity();
  const state = waiting ? "waiting" : working ? "working" : "idle";
  const label = waiting
    ? `${waiting} action${waiting > 1 ? "s" : ""} waiting for your answer`
    : working
      ? "The assistant is working"
      : open
        ? "Close the assistant"
        : "Ask the assistant";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="mascot fixed right-4 bottom-4 z-40 size-16 rounded-full text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-state={state}
          aria-label={label}
          aria-expanded={open}
          onClick={onToggle}
        >
          <MascotBird className="size-16 drop-shadow-md" />
          {working && !waiting && (
            <span className="absolute -top-1 -left-2 flex gap-0.5 rounded-full border bg-background px-1.5 py-1 shadow-sm">
              {[0, 1, 2].map((i) => (
                <span key={i} className="mascot-dot size-1 rounded-full bg-foreground" />
              ))}
            </span>
          )}
          {waiting > 0 && (
            <span className={cn("absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-warning text-[11px] font-semibold text-background shadow-sm")}>
              {waiting}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
