import { Alert02Icon, Archive02Icon, Cancel01Icon, CheckmarkCircle02Icon, Clock01Icon, FolderOpenIcon, Loading03Icon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { api, type Job, type JobStatus } from "@/api";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { InstallMenu } from "./InstallMenu";

// What builds look like everywhere: an icon, a colour for the tile's edge, a word.
export const STATUS: Record<JobStatus, { icon: IconSvgElement; className: string; edge: string; label: string }> = {
  queued: { icon: Clock01Icon, className: "text-muted-foreground", edge: "border-l-muted-foreground/40", label: "Queued" },
  running: { icon: Loading03Icon, className: "text-info animate-spin", edge: "border-l-info", label: "Building" },
  succeeded: { icon: CheckmarkCircle02Icon, className: "text-success", edge: "border-l-success", label: "Built" },
  failed: { icon: Alert02Icon, className: "text-destructive", edge: "border-l-destructive", label: "Failed" },
  cancelled: { icon: Cancel01Icon, className: "text-muted-foreground", edge: "border-l-muted-foreground/40", label: "Cancelled" },
};

export const INSTALLABLE = (j: Job) =>
  j.status === "succeeded" &&
  (j.artifact === "apk" || j.artifact === "app" || (j.artifact === "ipa" && !/--export-method=app-store/.test(j.command)));

export const ARM64_ONLY = (j: Job) => j.command.includes("--target-platform android-arm64");

export function shortPath(p: string) {
  const i = p.indexOf("/worktrees/");
  if (i >= 0) return p.slice(i + "/worktrees/".length);
  if (p.includes("/scratchpad/")) return p.split("/scratchpad/")[1];
  return p.split("/").pop() ?? p;
}

/** "installed on X" and friends, coloured like the build statuses. */
export function installText(j: Job): { text: string; className: string } | null {
  if (!j.install) return null;
  const d = j.install.device;
  if (j.install.state === "installed") return { text: `on ${d}`, className: "text-success" };
  if (j.install.state === "installing") return { text: `installing on ${d}`, className: "text-info" };
  return { text: j.install.state === "needs-replace" ? `needs replace on ${d}` : `install failed on ${d}`, className: "text-destructive" };
}

function IconAction({ label, icon, onClick, className }: { label: string; icon: IconSvgElement; onClick: () => void; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7", className)}
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          <HugeiconsIcon icon={icon} className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** What can be done with a build right now: cancel it, install it, open its archive, show it in Finder. */
export function BuildActions({ job }: { job: Job }) {
  return (
    <div className="flex items-center gap-0.5">
      {(job.status === "queued" || job.status === "running") && (
        <IconAction label="Cancel" icon={StopIcon} className="text-destructive hover:text-destructive" onClick={() => void api.cancel(job.id)} />
      )}
      {INSTALLABLE(job) && <InstallMenu job={job} />}
      {job.status === "succeeded" && job.xcarchive && (
        <IconAction label="Open the archive in Xcode Organizer to Distribute" icon={Archive02Icon} onClick={() => void api.organizer(job.id)} />
      )}
      {job.status === "succeeded" && <IconAction label="Show in Finder" icon={FolderOpenIcon} onClick={() => void api.reveal(job.id)} />}
    </div>
  );
}
