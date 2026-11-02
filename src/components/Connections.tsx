import {
  Alert02Icon,
  AppleIcon,
  Bug01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Fire03Icon,
  GithubIcon,
  Loading03Icon,
  MinusSignCircleIcon,
  PlugSocketIcon,
  RotateClockwiseIcon,
  SlackIcon,
  Ticket01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { projectsApi, type Connection } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BuildVariables, VariableRows } from "./BuildVariables";
import { cn } from "@/lib/utils";

const ICON: Record<Connection["id"], typeof GithubIcon> = {
  github: GithubIcon,
  jira: Ticket01Icon,
  slack: SlackIcon,
  firebase: Fire03Icon,
  sentry: Bug01Icon,
  signing: AppleIcon,
};

const HEALTH = {
  ok: { icon: CheckmarkCircle02Icon, className: "text-success", label: "Working" },
  warn: { icon: Alert02Icon, className: "text-warning", label: "Needs attention" },
  error: { icon: CancelCircleIcon, className: "text-destructive", label: "Not working" },
  off: { icon: MinusSignCircleIcon, className: "text-muted-foreground", label: "Not used" },
} as const;

const RANK = { error: 0, warn: 1, ok: 2, off: 3 } as const;

/** The app's connection checks, refetched when asked. */
function useConnections(appId: string) {
  const [data, setData] = useState<{ checkedAt: number; connections: Connection[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(
    (fresh: boolean) => {
      setChecking(true);
      setError(null);
      projectsApi
        .connections(appId, fresh)
        .then(setData, (e: Error) => setError(e.message))
        .finally(() => setChecking(false));
    },
    [appId],
  );
  useEffect(() => {
    setData(null);
    check(false);
  }, [check]);
  return { data, checking, error, check };
}

/** Header button: a plug with a dot for the worst connection, opening the checks. */
export function ConnectionsButton({ appId, appName, openNow, onOpened }: { appId: string; appName: string; openNow?: boolean; onOpened?: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!openNow) return;
    setOpen(true);
    onOpened?.();
  }, [openNow]);
  const { data, checking, error, check } = useConnections(appId);
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (open) void projectsApi.envNames(appId).then((r) => setNames(r.names), () => {});
  }, [open, appId]);
  // A variable changed: the checks that read it are stale.
  const changed = (n: string[]) => {
    setNames(n);
    check(true);
  };
  const problems = data?.connections.filter((c) => c.health === "error" || c.health === "warn") ?? [];
  const worst = problems.some((c) => c.health === "error") ? "error" : problems.length ? "warn" : data ? "ok" : null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="relative" onClick={() => setOpen(true)} aria-label="Connections">
            <HugeiconsIcon icon={PlugSocketIcon} className="size-4" />
            {worst && worst !== "ok" && (
              <span className={cn("absolute top-1.5 right-1.5 size-2 rounded-full", worst === "error" ? "bg-destructive" : "bg-warning")} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {problems.length ? `Connections: ${problems.map((c) => c.name).join(", ")} need${problems.length === 1 ? "s" : ""} attention` : "Connections"}
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connections</DialogTitle>
            <DialogDescription>
              What {appName}'s builds and releases sign in to, checked for real from this Mac. The checks only read; values you set are kept in this Mac's Keychain.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{data ? `Checked ${new Date(data.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : checking ? "Checking…" : ""}</span>
            <Button variant="outline" size="sm" disabled={checking} onClick={() => check(true)}>
              <HugeiconsIcon icon={checking ? Loading03Icon : RotateClockwiseIcon} className={cn("size-4", checking && "animate-spin")} />
              {checking ? "Checking…" : "Check again"}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="grid gap-3">
            {[...(data?.connections ?? [])]
              .sort((a, b) => RANK[a.health] - RANK[b.health])
              .map((c) => (
                <ConnectionCard key={c.id} c={c} appId={appId} onVariables={changed} />
              ))}
            <BuildVariables appId={appId} names={names} onChange={changed} shownAbove={(data?.connections ?? []).flatMap((c) => c.variables ?? [])} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectionCard({ c, appId, onVariables }: { c: Connection; appId: string; onVariables: (names: string[]) => void }) {
  const h = HEALTH[c.health];
  const vars = [...new Set([...(c.needs ?? []), ...(c.variables ?? []), ...(c.stored ?? [])])];
  const [editing, setEditing] = useState(false);
  const showVars = vars.length > 0 && (!!c.needs?.length || editing);
  return (
    <div className={cn("rounded-lg border p-3", c.health === "off" && "opacity-70", c.health === "error" && "border-destructive/40", c.health === "warn" && "border-warning/40")}>
      <div className="flex items-start gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
          <HugeiconsIcon icon={ICON[c.id]} className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium">{c.name}</span>
            <span className={cn("flex items-center gap-1 text-xs", h.className)}>
              <HugeiconsIcon icon={h.icon} className="size-3.5" />
              {h.label}
            </span>
          </div>
          <p className="text-sm break-words">{c.summary}</p>
          {c.details.length > 0 && (
            <ul className="space-y-0.5 text-xs break-words text-muted-foreground">
              {c.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {c.fix && c.health !== "ok" && (
            <p className={cn("rounded-md px-2 py-1.5 text-xs", c.health === "off" ? "bg-muted/60 text-muted-foreground" : "bg-muted text-foreground")}>
              {c.health === "off" ? c.fix : `To fix: ${c.fix}`}
            </p>
          )}
          {showVars && (
            <div className="pt-1">
              <VariableRows appId={appId} names={vars} stored={c.stored ?? []} onChange={onVariables} />
            </div>
          )}
          {vars.length > 0 && !c.needs?.length && (
            <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setEditing((e) => !e)}>
              {editing ? "Hide its variables" : "Change its variables"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
