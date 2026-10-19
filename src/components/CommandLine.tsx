import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface Part {
  args: string[];
  from: string;
}

/**
 * The exact command a build runs, as text you can copy. When `parts` say where
 * each flag came from, hovering a flag shows its setting, so an auto-detected
 * value that looks wrong can be traced to the config field to fix.
 */
export function CommandLine({ parts, text, className }: { parts?: Part[]; text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("group/cmd relative rounded-md bg-log px-2.5 py-2 pr-9 font-mono text-[11px] leading-relaxed text-log-foreground", className)}>
      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {parts
          ? parts.map((p, i) => (
              <span key={i}>
                {i > 0 && " "}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help rounded-sm underline decoration-dotted decoration-log-foreground/30 underline-offset-[3px] hover:bg-white/10">
                      {p.args.join(" ")}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-80 font-sans text-xs">{p.from}</TooltipContent>
                </Tooltip>
              </span>
            ))
          : text}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1 right-1 size-6 text-log-foreground/70 hover:bg-white/10 hover:text-log-foreground"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} className="size-3.5" />
      </Button>
    </div>
  );
}
