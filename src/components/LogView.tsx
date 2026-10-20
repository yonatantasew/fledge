import { CommandLineIcon, Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Job } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useFlavorLabel } from "@/project";
import { MODE_LABEL } from "./BuildForm";
import { CommandLine } from "./CommandLine";

const TAIL = 3000;

/** A slice of the log: one step's output. */
export type LogRange = { start: number; end?: number; label: string };

function lineClass(line: string) {
  if (/(^|\s)(error|ERROR|FAILURE|Error:|Exception|BUILD FAILED)/.test(line)) return "text-red-400";
  if (/(^|\s)(warning|WARNING|Warning:)/.test(line)) return "text-amber-300";
  if (/^(✓|Built |Archived |Verified:)/.test(line.trim())) return "text-emerald-400";
  if (line.startsWith("$ ")) return "text-sky-300";
  return "";
}

export function LogView({ job, log, range = null, onShowAll }: { job: Job | undefined; log: string | undefined; range?: LogRange | null; onShowAll?: () => void }) {
  const flavorLabel = useFlavorLabel();
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [all, setAll] = useState(false);

  useEffect(() => {
    setStick(true);
    setAll(false);
  }, [job?.id, range?.start]);

  const lines = useMemo(() => (range ? (log ?? "").slice(range.start, range.end) : (log ?? "")).split("\n"), [log, range?.start, range?.end]);
  const hidden = all ? 0 : Math.max(0, lines.length - TAIL);
  const shown = hidden ? lines.slice(hidden) : lines;

  useLayoutEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [shown, stick]);

  return (
    <Card className="min-h-0 gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HugeiconsIcon icon={CommandLineIcon} className="size-5" />
          Log
        </CardTitle>
        <CardDescription className="truncate">
          {range ? (
            <>
              {range.label} only ·{" "}
              <button className="underline-offset-2 hover:underline" onClick={onShowAll}>
                show the whole log
              </button>
            </>
          ) : job
            ? `${job.platform === "ios" ? "iOS" : "Android"} · ${flavorLabel(job.flavor)} · ${MODE_LABEL[job.mode]}${
                job.artifactFile ? ` → ${job.artifactFile.split("/").slice(-2).join("/")}` : ""
              }`
            : "Select a build to see its output."}
        </CardDescription>
        {job && (
          <CardAction>
            <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(log ?? "")}>
              <HugeiconsIcon icon={Copy01Icon} className="size-4" />
              Copy
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {job && (
        <div className="px-3">
          <CommandLine text={job.command} />
        </div>
      )}
      <CardContent className="min-h-0 flex-1 px-3">
        <div
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget;
            setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
          className="h-full min-h-64 overflow-auto rounded-lg bg-log p-3 font-mono text-[11.5px] leading-relaxed text-log-foreground"
        >
          {!job && <p className="text-muted-foreground">No build selected.</p>}
          {job && log === undefined && <p className="text-muted-foreground">Loading…</p>}
          {hidden > 0 && (
            <button className="mb-2 text-sky-300 underline-offset-2 hover:underline" onClick={() => setAll(true)}>
              {hidden.toLocaleString()} earlier lines hidden — show all
            </button>
          )}
          {shown.map((l, i) => (
            <div key={hidden + i} className={cn("whitespace-pre-wrap break-all", lineClass(l))}>
              {l || " "}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
