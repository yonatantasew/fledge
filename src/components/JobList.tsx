import {
  Alert02Icon,
  Archive02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Delete02Icon,
  FolderOpenIcon,
  Loading03Icon,
  PackageIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { api, duration, useNow, type Job, type JobStatus } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useFlavorLabel } from "@/project";
import { MODE_LABEL, PLATFORM_ICON } from "./BuildForm";
import { InstallMenu } from "./InstallMenu";

const INSTALLABLE = (j: Job) =>
  j.status === "succeeded" &&
  (j.artifact === "apk" || j.artifact === "app" || (j.artifact === "ipa" && !/--export-method=app-store/.test(j.command)));

const STATUS: Record<JobStatus, { icon: IconSvgElement; className: string; label: string }> = {
  queued: { icon: Clock01Icon, className: "text-muted-foreground", label: "Queued" },
  running: { icon: Loading03Icon, className: "text-info animate-spin", label: "Building" },
  succeeded: { icon: CheckmarkCircle02Icon, className: "text-success", label: "Built" },
  failed: { icon: Alert02Icon, className: "text-destructive", label: "Failed" },
  cancelled: { icon: Cancel01Icon, className: "text-muted-foreground", label: "Cancelled" },
};

function shortPath(p: string) {
  const i = p.indexOf("/worktrees/");
  if (i >= 0) return p.slice(i + "/worktrees/".length);
  if (p.includes("/scratchpad/")) return p.split("/scratchpad/")[1];
  return p.split("/").pop() ?? p;
}

export function JobList({
  jobs,
  selected,
  onSelect,
}: {
  jobs: Job[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const flavorLabel = useFlavorLabel();
  const active = jobs.some((j) => j.status === "running");
  const now = useNow(active);
  const ordered = [...jobs].sort((a, b) => {
    const rank = (j: Job) => (j.status === "running" ? 0 : j.status === "queued" ? 1 : 2);
    return rank(a) - rank(b) || (rank(a) === 1 ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
  });
  const finished = jobs.filter((j) => j.status !== "queued" && j.status !== "running").length;
  const running = jobs.filter((j) => j.status === "running").length;
  const pending = running + jobs.filter((j) => j.status === "queued").length;
  const busyLanes = new Set(jobs.filter((j) => j.status === "running").map((j) => j.platform));

  return (
    <Card className="min-h-0 gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HugeiconsIcon icon={PackageIcon} className="size-5" />
          Builds
        </CardTitle>
        <CardDescription>
          {jobs.length === 0
            ? "Nothing yet. Queued builds appear here."
            : [
                running > 0 && `${running} building`,
                `${jobs.filter((j) => j.status === "queued").length} queued`,
                `${finished} finished`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </CardDescription>
        {(finished > 0 || pending > 0) && (
          <CardAction className="flex gap-1">
            {pending > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => void api.stopAll()}
              >
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
      <CardContent className="min-h-0 overflow-y-auto px-3">
        <ul className="space-y-1">
          {ordered.map((j) => {
            const s = STATUS[j.status];
            const end = j.endedAt ?? (j.status === "running" ? now : undefined);
            return (
              <li key={j.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(j.id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(j.id)}
                  className={cn(
                    "group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                    selected === j.id && "border-border bg-muted",
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HugeiconsIcon icon={s.icon} className={cn("size-5 shrink-0", s.className)} />
                    </TooltipTrigger>
                    <TooltipContent>
                      {j.error ??
                        (j.status === "queued"
                          ? busyLanes.has(j.platform)
                            ? `Waiting for the ${j.platform === "ios" ? "iOS" : "Android"} build ahead of it`
                            : "Starting…"
                          : s.label)}
                    </TooltipContent>
                  </Tooltip>
                  <HugeiconsIcon icon={PLATFORM_ICON[j.platform]} className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      <span className="font-medium">{flavorLabel(j.flavor)}</span>
                      <span className="text-muted-foreground">{MODE_LABEL[j.mode]}</span>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {j.artifact}
                      </Badge>
                      {j.command.includes("--target-platform android-arm64") && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="border-warning/50 font-mono text-[10px] text-warning">
                              arm64 only
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-64">
                            Built for 64-bit ARM phones only. Not for testers or upload.
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {j.verified?.version && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="secondary" className="font-mono text-[10px]">
                              {j.verified.version}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>Read back from the built artifact · {j.verified.bundleId}</TooltipContent>
                        </Tooltip>
                      )}
                      {j.install && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px]",
                                j.install.state === "installed" && "border-success/40 text-success",
                                j.install.state === "installing" && "border-info/40 text-info",
                                (j.install.state === "failed" || j.install.state === "needs-replace") && "border-destructive/40 text-destructive",
                              )}
                            >
                              {j.install.state === "installed"
                                ? `on ${j.install.device}`
                                : j.install.state === "installing"
                                  ? `installing on ${j.install.device}`
                                  : j.install.state === "needs-replace"
                                    ? "needs replace"
                                    : "install failed"}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-72">
                            {j.install.message ?? `${j.install.state} · ${new Date(j.install.at).toLocaleTimeString()}`}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {j.branch} @ {j.sha} · {shortPath(j.checkout)}
                    </div>
                  </div>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {j.startedAt && end ? duration(end - j.startedAt) : ""}
                  </span>
                  {(j.status === "queued" || j.status === "running") && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Cancel build"
                          onClick={(e) => {
                            e.stopPropagation();
                            void api.cancel(j.id);
                          }}
                        >
                          <HugeiconsIcon icon={StopIcon} className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Cancel</TooltipContent>
                    </Tooltip>
                  )}
                  {INSTALLABLE(j) && <InstallMenu job={j} />}
                  {j.status === "succeeded" && j.xcarchive && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Open in Xcode Organizer"
                          onClick={(e) => {
                            e.stopPropagation();
                            void api.organizer(j.id);
                          }}
                        >
                          <HugeiconsIcon icon={Archive02Icon} className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Open the archive in Xcode Organizer to Distribute</TooltipContent>
                    </Tooltip>
                  )}
                  {j.status === "succeeded" && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Show in Finder"
                          onClick={(e) => {
                            e.stopPropagation();
                            void api.reveal(j.id);
                          }}
                        >
                          <HugeiconsIcon icon={FolderOpenIcon} className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Show in Finder</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
