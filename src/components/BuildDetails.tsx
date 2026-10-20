import {
  Alert02Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CodeIcon,
  GitBranchIcon,
  Loading03Icon,
  MinusSignCircleIcon,
  PackageDeliveredIcon,
  PackageIcon,
  SmartPhone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Fragment, useEffect, useState } from "react";
import { duration, useNow, type BuildStep, type Job } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useFlavorLabel } from "@/project";
import { MODE_LABEL, PLATFORM_ICON } from "./BuildForm";
import { BuildActions, installText, shortPath, STATUS } from "./build-status";
import { LogView, type LogRange } from "./LogView";

type NodeState = BuildStep["state"] | "pending";

interface TreeNode {
  key: string;
  kind: string; // the small caption under the icon, like Argo's resource kinds
  icon: IconSvgElement;
  title: string;
  detail?: string;
  state: NodeState;
  seconds?: number;
  range: LogRange | null; // null: the whole log
}

const STATE: Record<NodeState, { icon: IconSvgElement; className: string; label: string }> = {
  pending: { icon: MinusSignCircleIcon, className: "text-muted-foreground/50", label: "Not started" },
  running: { icon: Loading03Icon, className: "text-info animate-spin", label: "Running" },
  succeeded: { icon: CheckmarkCircle02Icon, className: "text-success", label: "Done" },
  failed: { icon: Alert02Icon, className: "text-destructive", label: "Failed" },
  skipped: { icon: MinusSignCircleIcon, className: "text-muted-foreground", label: "Skipped" },
  cancelled: { icon: Cancel01Icon, className: "text-muted-foreground", label: "Cancelled" },
};

/** Builds recorded before steps were: the stages, guessed from how the build ended. */
function legacySteps(job: Job): Partial<Record<"pub" | "build" | "collect", NodeState>> {
  if (job.status === "queued") return {};
  if (job.status === "running") return { pub: "running" };
  if (job.status === "succeeded") return { pub: "succeeded", build: "succeeded", collect: "succeeded" };
  const at = job.error?.startsWith("pub get") ? "pub" : job.error?.startsWith("built, but") ? "collect" : "build";
  const end: NodeState = job.status === "cancelled" ? "cancelled" : "failed";
  return at === "pub" ? { pub: end } : at === "build" ? { pub: "succeeded", build: end } : { pub: "succeeded", build: "succeeded", collect: end };
}

function nodes(job: Job, now: number): { main: TreeNode[]; installs: TreeNode[] } {
  const steps = job.steps;
  const legacy = steps ? null : legacySteps(job);
  const step = (id: string) => steps?.find((s) => s.id === id);
  const node = (id: "pub" | "build" | "collect", base: Omit<TreeNode, "state" | "range" | "key">): TreeNode => {
    const s = step(id);
    return {
      key: id,
      ...base,
      // The artifact is named by its file once there is one; the other steps by what ran.
      title: id === "collect" && job.artifactFile ? base.title : (s?.label ?? base.title),
      detail: s?.detail ?? base.detail,
      state: s?.state ?? legacy?.[id] ?? "pending",
      seconds: s ? Math.round(((s.endedAt ?? now) - s.startedAt) / 1000) : undefined,
      range: s ? { start: s.logStart, end: s.logEnd, label: s.label } : null,
    };
  };
  const file = job.artifactFile?.split("/").pop();
  const main: TreeNode[] = [
    {
      key: "source",
      kind: "source",
      icon: GitBranchIcon,
      title: job.branch,
      detail: `${job.sha.slice(0, 8)} · ${shortPath(job.checkout)}`,
      state: job.status === "queued" ? "pending" : "succeeded",
      range: null,
    },
    node("pub", { kind: "packages", icon: PackageIcon, title: "pub get" }),
    node("build", { kind: "build", icon: CodeIcon, title: `flutter build ${job.artifact}` }),
    node("collect", {
      kind: job.artifact === "xcode" ? "xcode" : "artifact",
      icon: PackageDeliveredIcon,
      title: file ?? (job.artifact === "xcode" ? "Open Xcode" : `.${job.artifact}`),
      detail: job.verified?.version,
    }),
  ];
  const installs: TreeNode[] = (steps ?? [])
    .filter((s) => s.id.startsWith("install-"))
    .map((s) => ({
      key: s.id,
      kind: "device",
      icon: SmartPhone01Icon,
      title: s.label.replace(/^Install on /, ""),
      detail: s.detail,
      state: s.state,
      seconds: Math.round(((s.endedAt ?? now) - s.startedAt) / 1000),
      range: { start: s.logStart, end: s.logEnd, label: s.label },
    }));
  // A build recorded before steps were, installed since: show the device anyway.
  if (!steps && job.install) {
    const t = installText(job);
    installs.push({ key: "install", kind: "device", icon: SmartPhone01Icon, title: job.install.device, detail: t?.text, state: job.install.state === "installed" ? "succeeded" : job.install.state === "installing" ? "running" : "failed", range: null });
  }
  return { main, installs };
}

function Node({ n, selected, onSelect }: { n: TreeNode; selected: boolean; onSelect: () => void }) {
  const st = STATE[n.state];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={`${STATE[n.state].label}${n.detail ? ` · ${n.detail}` : ""}`}
      className={cn(
        "flex w-56 shrink-0 items-center gap-2 rounded-lg border bg-card p-2 text-left shadow-xs outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
        n.state === "pending" && "border-dashed opacity-70 shadow-none",
        selected && "ring-2 ring-foreground/40",
      )}
    >
      <span className="flex w-16 shrink-0 flex-col items-center gap-0.5">
        <span className="flex size-8 items-center justify-center rounded-md bg-muted">
          <HugeiconsIcon icon={n.icon} className="size-4.5" />
        </span>
        <span className="text-[9px] tracking-wide text-muted-foreground uppercase">{n.kind}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{n.title}</span>
        <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{n.detail ?? st.label}</span>
        {n.seconds !== undefined && <span className="block text-[10.5px] tabular-nums text-muted-foreground">{duration(n.seconds * 1000)}</span>}
      </span>
      <HugeiconsIcon icon={st.icon} className={cn("size-4 shrink-0 self-start", st.className)} />
    </button>
  );
}

const Edge = () => <span className="h-px w-6 shrink-0 bg-border" aria-hidden="true" />;

/** One build, Argo CD style: a summary, its steps as a tree from the source to the phones it went to, and the log of the step you pick. */
export function BuildDetails({ job, log, onBack }: { job: Job; log: string | undefined; onBack: () => void }) {
  const flavorLabel = useFlavorLabel();
  const now = useNow(job.status === "running" || !!job.steps?.some((s) => s.state === "running"));
  const [picked, setPicked] = useState<string>("source");
  useEffect(() => setPicked("source"), [job.id]);
  const { main, installs } = nodes(job, now);
  const all = [...main, ...installs];
  const current = all.find((n) => n.key === picked) ?? main[0];
  const s = STATUS[job.status];
  const end = job.endedAt ?? (job.status === "running" ? now : undefined);

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-4">
      <Card className={cn("gap-3 border-l-4 py-4", s.edge)}>
        <div className="flex flex-wrap items-center gap-2 px-4">
          <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
            <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
            Builds
          </Button>
          <HugeiconsIcon icon={PLATFORM_ICON[job.platform]} className="size-4 text-muted-foreground" />
          <span className="font-semibold">{flavorLabel(job.flavor)}</span>
          <span className="text-muted-foreground">{MODE_LABEL[job.mode]}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {job.artifact}
          </Badge>
          <span className={cn("flex items-center gap-1 text-sm", job.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
            <HugeiconsIcon icon={s.icon} className={cn("size-4", s.className)} />
            {s.label}
            {job.startedAt && end ? ` · ${duration(end - job.startedAt)}` : ""}
          </span>
          <div className="ml-auto">
            <BuildActions job={job} />
          </div>
        </div>
        {job.error && <p className="px-4 text-xs text-destructive">{job.error}</p>}
        <div className="overflow-x-auto px-3">
          <div className="flex w-max items-start p-1">
            {main.map((n, i) => (
              <Fragment key={n.key}>
                {i > 0 && (
                  <span className="flex h-[3.75rem] items-center">
                    <Edge />
                  </span>
                )}
                <Node n={n} selected={current.key === n.key} onSelect={() => setPicked(n.key)} />
              </Fragment>
            ))}
            {installs.length > 0 && (
              <div className="flex">
                {/* One branch per phone, from the artifact. */}
                <span className="flex h-[3.75rem] items-center">
                  <Edge />
                </span>
                <div className="relative flex flex-col gap-2 border-l pl-3 before:absolute before:top-0 before:-left-px before:h-[1.875rem] before:w-px before:bg-card">
                  {installs.map((n) => (
                    <div key={n.key} className="flex items-center">
                      <span className="-ml-3 h-px w-3 bg-border" aria-hidden="true" />
                      <Node n={n} selected={current.key === n.key} onSelect={() => setPicked(n.key)} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
      <LogView job={job} log={log} range={current.range} onShowAll={() => setPicked("source")} />
    </div>
  );
}
