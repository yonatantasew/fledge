import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  FolderTreeIcon,
  GridViewIcon,
  LayoutThreeColumnIcon,
  ListViewIcon,
  PackageIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { api, duration, useNow, type Job, type JobStatus } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { groupBuilds, versionOf, type GroupBy } from "@/build-groups";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useFlavorLabel } from "@/project";
import { MODE_LABEL, PLATFORM_ICON } from "./BuildForm";
import { ARM64_ONLY, BuildActions, installText, shortPath, STATUS } from "./build-status";
import { BuildFolder } from "./BuildFiles";

const ORDER: JobStatus[] = ["running", "queued", "succeeded", "failed", "cancelled"];

const GROUP_LABEL: Record<GroupBy, string> = { none: "No grouping", version: "Version", date: "Day", branch: "Branch", env: "Environment", status: "Status" };

type Layout = "grid" | "list" | "columns" | "files";
const LAYOUTS: { id: Layout; label: string; icon: IconSvgElement }[] = [
  { id: "grid", label: "Grid", icon: GridViewIcon },
  { id: "list", label: "List", icon: ListViewIcon },
  { id: "columns", label: "Columns: one per group (statuses when not grouped)", icon: LayoutThreeColumnIcon },
  { id: "files", label: "Files: each build's folder, with its subfolders and files", icon: FolderTreeIcon },
];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function ago(t: number, now: number) {
  const m = Math.round((now - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
}

/**
 * The builds, Argo CD style, in four layouts: a grid of tiles (facts in rows,
 * actions along the bottom), a dense list, a board of columns (one per group),
 * or their folders, opening into subfolders and files.
 * Each has the status as a coloured edge; filter, grouping and layout persist.
 */
export function BuildTiles({ jobs, onSelect, showProject = false }: { jobs: Job[]; onSelect: (id: string) => void; showProject?: boolean }) {
  const flavorLabel = useFlavorLabel();
  const [filter, setFilter] = useState<JobStatus | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>(() => stored("fledge:group-builds", Object.keys(GROUP_LABEL) as GroupBy[], "none"));
  const [layout, setLayout] = useState<Layout>(() => stored("fledge:builds-layout", LAYOUTS.map((l) => l.id), "grid"));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    store("fledge:group-builds", groupBy);
    setCollapsed(new Set());
  }, [groupBy]);
  useEffect(() => store("fledge:builds-layout", layout), [layout]);
  const now = useNow(jobs.some((j) => j.status === "running"));
  const count = (s: JobStatus) => jobs.filter((j) => j.status === s).length;
  const pending = count("running") + count("queued");
  const finished = jobs.length - pending;
  const busyLanes = new Set(jobs.filter((j) => j.status === "running").map((j) => j.platform));
  const waitingFor = (j: Job) =>
    j.status === "queued" ? (busyLanes.has(j.platform) ? `waiting for the ${j.platform === "ios" ? "iOS" : "Android"} build ahead` : "starting…") : null;
  const item = { now, flavorLabel, showProject, onSelect, waitingFor };
  const shown = [...jobs]
    .filter((j) => !filter || j.status === filter)
    .sort((a, b) => {
      const rank = (j: Job) => (j.status === "running" ? 0 : j.status === "queued" ? 1 : 2);
      return rank(a) - rank(b) || (rank(a) === 1 ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
    });
  // Columns need something to split by: statuses when the builds aren't grouped.
  const groups = groupBuilds(shown, layout === "columns" && groupBy === "none" ? "status" : groupBy, flavorLabel);

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
        <div className="flex flex-wrap items-center gap-1.5 px-6">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            <FilterChip active={!filter} onClick={() => setFilter(null)} label="All" count={jobs.length} />
            {ORDER.filter((s) => count(s) > 0).map((s) => (
              <FilterChip key={s} active={filter === s} onClick={() => setFilter(filter === s ? null : s)} label={STATUS[s].label} count={count(s)} status={s} />
            ))}
          </div>
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
            <SelectTrigger size="sm" className="ml-auto h-7 gap-1 text-xs" aria-label="Group builds by">
              <span className="text-muted-foreground">Group:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
                <SelectItem key={g} value={g} className="text-xs">
                  {GROUP_LABEL[g]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <Tooltip key={l.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={l.label}
                    aria-pressed={layout === l.id}
                    onClick={() => setLayout(l.id)}
                    className={cn("rounded-sm p-1 text-muted-foreground hover:text-foreground", layout === l.id && "bg-muted text-foreground")}
                  >
                    <HugeiconsIcon icon={l.icon} className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{l.label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      {layout === "columns" ? (
        // A board: the groups side by side, each a column of compact cards.
        <CardContent className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3 pb-1">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label} className="flex w-72 shrink-0 flex-col rounded-lg bg-muted/40 p-2">
              <GroupHeader label={g.label} code={groupBy === "version" || groupBy === "branch"} builds={g.builds} />
              <ul className="min-h-0 space-y-2 overflow-y-auto p-0.5">
                {g.builds.map((j) => (
                  <li key={j.id}>
                    <BuildCard job={j} {...item} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </CardContent>
      ) : (
        <CardContent className="min-h-0 space-y-4 overflow-y-auto px-3 pb-1">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label || undefined}>
              {groupBy !== "none" && (
                <GroupHeader
                  label={g.label}
                  code={groupBy === "version" || groupBy === "branch"}
                  builds={g.builds}
                  open={!collapsed.has(g.key)}
                  onToggle={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (!next.delete(g.key)) next.add(g.key);
                      return next;
                    })
                  }
                />
              )}
              {!collapsed.has(g.key) &&
                (layout === "files" ? (
                  <ul className="divide-y overflow-hidden rounded-lg border">
                    {g.builds.map((j) => (
                      <li key={j.id}>
                        <BuildFolder job={j} flavorLabel={flavorLabel} onSelect={onSelect} />
                      </li>
                    ))}
                  </ul>
                ) : layout === "list" ? (
                  <ul className="divide-y rounded-lg border">
                    {g.builds.map((j) => (
                      <li key={j.id}>
                        <BuildRow job={j} {...item} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,290px),1fr))] gap-3 p-0.5">
                    {g.builds.map((j) => (
                      <li key={j.id}>
                        <BuildTile job={j} {...item} />
                      </li>
                    ))}
                  </ul>
                ))}
            </section>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

interface ItemProps {
  job: Job;
  now: number;
  flavorLabel: (flavor: string) => string;
  showProject: boolean;
  onSelect: (id: string) => void;
  waitingFor: (j: Job) => string | null;
}

/** Opens a build's details on click, Enter or Space. */
function opener(j: Job, onSelect: (id: string) => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: () => onSelect(j.id),
    onKeyDown: (e: React.KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(j.id)),
  };
}

const elapsed = (j: Job, now: number) => {
  const end = j.endedAt ?? (j.status === "running" ? now : undefined);
  return j.startedAt && end ? duration(end - j.startedAt) : "";
};

function Title({ job: j, flavorLabel }: { job: Job; flavorLabel: (f: string) => string }) {
  return (
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
  );
}

function StatusText({ job: j, waiting }: { job: Job; waiting: string | null }) {
  const s = STATUS[j.status];
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <HugeiconsIcon icon={s.icon} className={cn("size-3.5 shrink-0", s.className)} />
      <span className="truncate" title={j.error}>
        {s.label}
        {(j.attempt ?? 1) > 1 && <span className="text-muted-foreground"> · attempt {j.attempt}</span>}
        {waiting && <span className="text-muted-foreground"> · {waiting}</span>}
        {j.status === "failed" && j.error && <span className="text-muted-foreground"> · {j.error}</span>}
      </span>
    </span>
  );
}

/** Grid: the Argo CD tile, with the facts in rows. */
function BuildTile({ job: j, now, flavorLabel, showProject, onSelect, waitingFor }: ItemProps) {
  const installed = installText(j);
  return (
    <div
      {...opener(j, onSelect)}
      className={cn(
        "group flex h-full cursor-pointer flex-col rounded-lg border border-l-4 bg-card text-left shadow-xs outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
        STATUS[j.status].edge,
      )}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <HugeiconsIcon icon={PLATFORM_ICON[j.platform]} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <Title job={j} flavorLabel={flavorLabel} />
          {showProject && j.projectName && <div className="truncate text-xs text-muted-foreground">{j.projectName}</div>}
        </div>
        <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{elapsed(j, now)}</span>
      </div>

      <dl className="grid flex-1 grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 py-2.5 text-xs">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="min-w-0">
          <StatusText job={j} waiting={waitingFor(j)} />
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
  );
}

/** List: one dense row, the facts on a second line that truncates on narrow screens. */
function BuildRow({ job: j, now, flavorLabel, showProject, onSelect, waitingFor }: ItemProps) {
  const installed = installText(j);
  const version = versionOf(j);
  return (
    <div
      {...opener(j, onSelect)}
      className={cn(
        "flex cursor-pointer items-center gap-3 border-l-4 px-3 py-2 outline-none hover:bg-muted/60 focus-visible:bg-muted",
        STATUS[j.status].edge,
      )}
    >
      <HugeiconsIcon icon={PLATFORM_ICON[j.platform]} className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <Title job={j} flavorLabel={flavorLabel} />
          <span className="min-w-0 text-xs">
            <StatusText job={j} waiting={waitingFor(j)} />
          </span>
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {[showProject && j.projectName, version, `${j.branch} @ ${j.sha.slice(0, 8)}`, installed?.text, ago(j.createdAt, Date.now())].filter(Boolean).join(" · ")}
        </div>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed(j, now)}</span>
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <BuildActions job={j} />
      </div>
    </div>
  );
}

/** Columns: a compact card for the board. */
function BuildCard({ job: j, now, flavorLabel, showProject, onSelect, waitingFor }: ItemProps) {
  const installed = installText(j);
  const version = versionOf(j);
  return (
    <div
      {...opener(j, onSelect)}
      className={cn(
        "cursor-pointer rounded-md border border-l-4 bg-card px-2.5 pt-2 pb-1 text-left shadow-xs outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
        STATUS[j.status].edge,
      )}
    >
      <div className="flex items-start gap-1.5">
        <HugeiconsIcon icon={PLATFORM_ICON[j.platform]} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <Title job={j} flavorLabel={flavorLabel} />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{elapsed(j, now)}</span>
      </div>
      <div className="mt-1 space-y-0.5 text-xs">
        <StatusText job={j} waiting={waitingFor(j)} />
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {[showProject && j.projectName, version, `${j.branch} @ ${j.sha.slice(0, 8)}`].filter(Boolean).join(" · ")}
        </div>
        {installed && <div className={cn("truncate", installed.className)}>{installed.text}</div>}
      </div>
      <div className="mt-1 flex items-center border-t pt-0.5">
        <BuildActions job={j} />
        <span className="ml-auto text-[11px] text-muted-foreground">{ago(j.createdAt, Date.now())}</span>
      </div>
    </div>
  );
}

/** A group's title, its size and statuses at a glance; clicking it folds the group. */
function GroupHeader({ label, code, builds, open, onToggle }: { label: string; code: boolean; builds: Job[]; open?: boolean; onToggle?: () => void }) {
  const counts = ORDER.map((s) => [s, builds.filter((b) => b.status === s).length] as const).filter(([, n]) => n > 0);
  // In columns there's nothing to fold: the header is plain text.
  const Tag = onToggle ? "button" : "div";
  return (
    <Tag
      {...(onToggle ? { type: "button" as const, "aria-expanded": open, onClick: onToggle } : {})}
      className={cn("mb-2 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm", onToggle && "hover:bg-muted")}
    >
      {onToggle && <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="size-3.5 text-muted-foreground" />}
      <span className={cn("font-semibold", code && "font-mono")}>{label}</span>
      <span className="text-xs text-muted-foreground">
        {builds.length} build{builds.length === 1 ? "" : "s"}
      </span>
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {counts.map(([s, n]) => (
          <span key={s} className="flex items-center gap-0.5" title={STATUS[s].label}>
            <HugeiconsIcon icon={STATUS[s].icon} className={cn("size-3.5", STATUS[s].className, "animate-none")} />
            {n}
          </span>
        ))}
      </span>
    </Tag>
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
