import { ArrowRight01Icon, Delete02Icon, PackageIcon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { api, duration, useNow, type Job, type JobStatus } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useFlavorLabel } from "@/project";
import { MODE_LABEL, PLATFORM_ICON } from "./BuildForm";
import { ARM64_ONLY, BuildActions, installText, shortPath, STATUS } from "./build-status";

const ORDER: JobStatus[] = ["running", "queued", "succeeded", "failed", "cancelled"];

function ago(t: number, now: number) {
  const m = Math.round((now - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
}

/** The builds as tiles, Argo CD style: a coloured edge for the status, the facts in rows, the actions along the bottom. */
export function BuildTiles({ jobs, onSelect, showProject = false }: { jobs: Job[]; onSelect: (id: string) => void; showProject?: boolean }) {
  const flavorLabel = useFlavorLabel();
  const [filter, setFilter] = useState<JobStatus | null>(null);
  const now = useNow(jobs.some((j) => j.status === "running"));
  const count = (s: JobStatus) => jobs.filter((j) => j.status === s).length;
  const pending = count("running") + count("queued");
  const finished = jobs.length - pending;
  const busyLanes = new Set(jobs.filter((j) => j.status === "running").map((j) => j.platform));
  const shown = [...jobs]
    .filter((j) => !filter || j.status === filter)
    .sort((a, b) => {
      const rank = (j: Job) => (j.status === "running" ? 0 : j.status === "queued" ? 1 : 2);
      return rank(a) - rank(b) || (rank(a) === 1 ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
    });

  return (
    <Card className="min-h-0 gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HugeiconsIcon icon={PackageIcon} className="size-5" />
          Builds
        </CardTitle>
        <CardDescription>{jobs.length === 0 ? "Nothing yet. Queued builds appear here." : "Pick a build to see its steps and log."}</CardDescription>
        {jobs.length > 0 && (
          <CardAction className="flex gap-1">
            {pending > 0 && (
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void api.stopAll()}>
                <HugeiconsIcon icon={StopIcon} className="size-4" />
                Stop all
              </Button>
            )}
            {finished > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void api.clear()}>
                <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                Clear finished
              </Button>
            )}
          </CardAction>
        )}
      </CardHeader>

      {jobs.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-6" role="group" aria-label="Filter by status">
          <FilterChip active={!filter} onClick={() => setFilter(null)} label="All" count={jobs.length} />
          {ORDER.filter((s) => count(s) > 0).map((s) => (
            <FilterChip key={s} active={filter === s} onClick={() => setFilter(filter === s ? null : s)} label={STATUS[s].label} count={count(s)} status={s} />
          ))}
        </div>
      )}

      <CardContent className="min-h-0 overflow-y-auto px-3 pb-1">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,290px),1fr))] gap-3 p-0.5">
          {shown.map((j) => {
            const s = STATUS[j.status];
            const end = j.endedAt ?? (j.status === "running" ? now : undefined);
            const installed = installText(j);
            const waiting =
              j.status === "queued" ? (busyLanes.has(j.platform) ? `waiting for the ${j.platform === "ios" ? "iOS" : "Android"} build ahead` : "starting…") : null;
            return (
              <li key={j.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(j.id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(j.id))}
                  className={cn(
                    "group flex h-full cursor-pointer flex-col rounded-lg border border-l-4 bg-card text-left shadow-xs outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
                    s.edge,
                  )}
                >
                  <div className="flex items-start gap-2 px-3 pt-2.5">
                    <HugeiconsIcon icon={PLATFORM_ICON[j.platform]} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
                        <span className="font-semibold">{flavorLabel(j.flavor)}</span>
                        <span className="text-muted-foreground">{MODE_LABEL[j.mode]}</span>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {j.artifact}
                        </Badge>
                        {ARM64_ONLY(j) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="border-warning/50 font-mono text-[10px] text-warning">
                                arm64 only
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-64">Built for 64-bit ARM phones only. Not for testers or upload.</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      {showProject && j.projectName && <div className="truncate text-xs text-muted-foreground">{j.projectName}</div>}
                    </div>
                    <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{j.startedAt && end ? duration(end - j.startedAt) : ""}</span>
                  </div>

                  <dl className="grid flex-1 grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 py-2.5 text-xs">
                    <dt className="text-muted-foreground">Status</dt>
                    <dd className="flex min-w-0 items-center gap-1.5">
                      <HugeiconsIcon icon={s.icon} className={cn("size-3.5 shrink-0", s.className)} />
                      <span className="truncate" title={j.error}>
                        {s.label}
                        {(j.attempt ?? 1) > 1 && <span className="text-muted-foreground"> · attempt {j.attempt}</span>}
                        {waiting && <span className="text-muted-foreground"> · {waiting}</span>}
                        {j.status === "failed" && j.error && <span className="text-muted-foreground"> · {j.error}</span>}
                      </span>
                    </dd>
                    <dt className="text-muted-foreground">Device</dt>
                    <dd className={cn("truncate", installed?.className ?? "text-muted-foreground")}>{installed?.text ?? "not installed"}</dd>
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="truncate font-mono text-[11px]">
                      {j.branch} @ {j.sha.slice(0, 8)}
                    </dd>
                    <dt className="text-muted-foreground">Checkout</dt>
                    <dd className="truncate font-mono text-[11px]">{shortPath(j.checkout)}</dd>
                    <dt className="text-muted-foreground">Version</dt>
                    <dd className="truncate font-mono text-[11px]" title={j.verified?.bundleId}>
                      {j.verified?.version ?? "—"}
                    </dd>
                    <dt className="text-muted-foreground">Created</dt>
                    <dd className="truncate">{ago(j.createdAt, Date.now())}</dd>
                  </dl>

                  <div className="flex items-center gap-1 border-t px-1.5 py-1">
                    <BuildActions job={j} />
                    <span className="ml-auto flex items-center gap-0.5 pr-1.5 text-xs text-muted-foreground group-hover:text-foreground">
                      Details
                      <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" />
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function FilterChip({ active, onClick, label, count, status }: { active: boolean; onClick: () => void; label: string; count: number; status?: JobStatus }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-muted",
        active && "border-foreground/30 bg-muted font-medium",
      )}
    >
      {status && <HugeiconsIcon icon={STATUS[status].icon} className={cn("size-3", STATUS[status].className, status === "running" && "animate-none")} />}
      {label}
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}
