import { Alert02Icon, GitBranchIcon, Moon02Icon, PackageIcon, Refresh01Icon, Rocket01Icon, Sun03Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, useJobs, type Info } from "@/api";
import { BuildForm } from "@/components/BuildForm";
import { FirebaseLogin } from "@/components/FirebaseLogin";
import { ReleasePanel } from "@/components/ReleasePanel";
import { ProjectContext } from "@/project";
import { JobList } from "@/components/JobList";
import { LogView } from "@/components/LogView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function label(p: string, main: string | undefined) {
  if (p === main) return "main checkout";
  const i = p.indexOf("/worktrees/");
  if (i >= 0) return p.slice(i + "/worktrees/".length);
  return p.split("/").slice(-1)[0];
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("fledge:theme", dark ? "dark" : "light");
    } catch {}
  }, [dark]);
  return [dark, setDark] as const;
}

export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [checkoutPath, setCheckoutPath] = useState<string | null>(() => {
    try {
      return localStorage.getItem("fledge:checkout");
    } catch {
      return null;
    }
  });
  const { jobs, logs, loadLog, connected } = useJobs();
  const [selected, setSelected] = useState<string | null>(null);
  const [dark, setDark] = useTheme();
  const [view, setView] = useState<"build" | "release">(() => {
    try {
      return localStorage.getItem("fledge:view") === "release" ? "release" : "build";
    } catch {
      return "build";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("fledge:view", view);
    } catch {}
  }, [view]);

  const refresh = useCallback(() => {
    api.info().then(setInfo).catch(() => setInfo(null));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    // Branch, sha and the dirty count go stale while you work in the checkout.
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const main = info?.checkouts[0]?.path;
  const checkout = info?.checkouts.find((c) => c.path === checkoutPath) ?? info?.checkouts[0];

  useEffect(() => {
    if (!checkout) return;
    try {
      localStorage.setItem("fledge:checkout", checkout.path);
    } catch {}
  }, [checkout]);

  // Follow each build as it starts.
  const runningId = jobs.find((j) => j.status === "running")?.id;
  useEffect(() => {
    if (runningId) setSelected(runningId);
  }, [runningId]);

  useEffect(() => {
    if (selected && logs[selected] === undefined) void loadLog(selected);
  }, [selected, logs, loadLog]);

  const job = jobs.find((j) => j.id === selected);

  const project = useMemo(
    () => ({ flavors: info?.flavors ?? [], toggles: info?.toggles ?? [], releases: info?.releases ?? false }),
    [info],
  );

  return (
    <ProjectContext.Provider value={project}>
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <HugeiconsIcon icon={Rocket01Icon} className="size-4.5" />
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold">fledge</h1>
              <p className="text-xs text-muted-foreground">
                Flutter {info?.flutter ?? "…"} · {info?.cli ?? ""}
              </p>
            </div>
          </div>

          <Tabs value={view} onValueChange={(v) => setView(v as "build" | "release")}>
            <TabsList>
              <TabsTrigger value="build" className="gap-1.5">
                <HugeiconsIcon icon={PackageIcon} className="size-4" />
                Build
              </TabsTrigger>
              <TabsTrigger value="release" className="gap-1.5">
                <HugeiconsIcon icon={Tag01Icon} className="size-4" />
                Release
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
            {view === "build" && info && (
              <Select value={checkout?.path} onValueChange={setCheckoutPath}>
                <SelectTrigger className="h-9 w-full max-w-80 sm:w-80" aria-label="Checkout to build">
                  <HugeiconsIcon icon={GitBranchIcon} className="size-4 text-muted-foreground" />
                  <SelectValue placeholder="Checkout" />
                </SelectTrigger>
                <SelectContent>
                  {info.checkouts.map((c) => (
                    <SelectItem key={c.path} value={c.path}>
                      <span className="font-medium">{c.branch}</span>
                      <span className="text-xs text-muted-foreground">{label(c.path, main)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {view === "build" && checkout && (
              <>
                <Badge variant="outline" className="h-9 gap-1.5 px-3 font-mono text-xs">
                  {checkout.sha} · v{checkout.version}
                </Badge>
                {checkout.dirty > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="h-9 gap-1.5 border-warning/50 px-3 text-xs text-warning">
                        <HugeiconsIcon icon={Alert02Icon} className="size-3.5" />
                        {checkout.dirty} uncommitted
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>Builds include uncommitted changes to tracked files.</TooltipContent>
                  </Tooltip>
                )}
              </>
            )}
            <FirebaseLogin />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={refresh} aria-label="Refresh checkouts">
                  <HugeiconsIcon icon={Refresh01Icon} className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh checkouts</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="icon" onClick={() => setDark(!dark)} aria-label="Toggle theme">
              <HugeiconsIcon icon={dark ? Sun03Icon : Moon02Icon} className="size-4" />
            </Button>
            <span
              className={cn("size-2 rounded-full", connected ? "bg-success" : "bg-destructive")}
              title={connected ? "Connected" : "Server not reachable"}
            />
          </div>
        </div>
      </header>

      {/* Both tabs stay mounted (only hidden), so switching keeps loaded changes, drafted notes and form state. */}
      <main className={cn("mx-auto w-full max-w-[1500px] flex-1 p-4", view !== "release" && "hidden")}>
        <ReleasePanel />
      </main>
      <main
        className={cn(
          "mx-auto grid w-full max-w-[1500px] flex-1 grid-cols-[minmax(0,1fr)] gap-4 p-4 lg:grid-cols-[400px_minmax(0,1fr)]",
          view !== "build" && "hidden",
        )}
      >
        <div className="lg:sticky lg:top-[73px] lg:max-h-[calc(100svh-89px)] lg:overflow-y-auto">
          <BuildForm checkout={checkout} />
        </div>
        <div className="grid min-h-0 gap-4 lg:h-[calc(100svh-89px)] lg:grid-rows-[minmax(0,2fr)_minmax(0,3fr)]">
          <JobList jobs={jobs} selected={selected} onSelect={setSelected} />
          <LogView job={job} log={selected ? logs[selected] : undefined} />
        </div>
      </main>
    </div>
    </ProjectContext.Provider>
  );
}
