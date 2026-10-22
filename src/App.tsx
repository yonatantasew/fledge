import {
  Add01Icon,
  Alert02Icon,
  FolderAddIcon,
  GitBranchIcon,
  Moon02Icon,
  PackageIcon,
  Refresh01Icon,
  Rocket01Icon,
  Settings02Icon,
  Sun03Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, projectsApi, useJobs, type Info, type ProjectSummary } from "@/api";
import { AddAppDialog } from "@/components/AddAppDialog";
import { Assistant } from "@/components/Assistant";
import { Mascot } from "@/components/Mascot";
import { OutsideApprovals } from "@/components/OutsideApprovals";
import { BuildForm } from "@/components/BuildForm";
import { ConfigDialog } from "@/components/ConfigDialog";
import { FirebaseLogin } from "@/components/FirebaseLogin";
import { BuildDetails } from "@/components/BuildDetails";
import { BuildTiles } from "@/components/BuildTiles";
import { ReleasePanel } from "@/components/ReleasePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ProjectContext } from "@/project";

function label(p: string, main: string | undefined) {
  if (p === main) return "main checkout";
  const i = p.indexOf("/worktrees/");
  if (i >= 0) return p.slice(i + "/worktrees/".length);
  return p.split("/").slice(-1)[0];
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    store("fledge:theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, setDark] as const;
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  // The app shown: ?project= (what `fledge` prints), else the last one used.
  const [projectId, setProjectId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("project") ?? stored("fledge:project"),
  );
  const [info, setInfo] = useState<Info | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [checkoutPath, setCheckoutPath] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [assistant, setAssistant] = useState(() => stored("fledge:assistant") === "open");
  useEffect(() => store("fledge:assistant", assistant ? "open" : "closed"), [assistant]);
  const [editing, setEditing] = useState(false);
  const { jobs, logs, loadLog, connected } = useJobs();
  const [selected, setSelected] = useState<string | null>(null);
  const [dark, setDark] = useTheme();
  const [view, setView] = useState<"build" | "release">(() => (stored("fledge:view") === "release" ? "release" : "build"));
  useEffect(() => store("fledge:view", view), [view]);

  const refreshProjects = useCallback(async () => {
    const list = await projectsApi.list().catch(() => [] as ProjectSummary[]);
    setProjects(list);
    setProjectId((id) => (id && list.some((p) => p.id === id) ? id : (list[0]?.id ?? null)));
  }, []);
  useEffect(() => void refreshProjects(), [refreshProjects]);

  const current = projects?.find((p) => p.id === projectId);

  useEffect(() => {
    if (!projectId) return;
    store("fledge:project", projectId);
    const url = new URL(location.href);
    url.searchParams.set("project", projectId);
    history.replaceState(null, "", url);
    setCheckoutPath(stored(`fledge:checkout:${projectId}`));
    setInfo(null);
  }, [projectId]);

  const refresh = useCallback(() => {
    if (!projectId) return;
    api.info(projectId).then(
      (i) => {
        setInfo(i);
        setInfoError(null);
      },
      (e: Error) => setInfoError(e.message),
    );
  }, [projectId]);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    // Branch, sha and the dirty count go stale while you work in the checkout.
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const main = info?.checkouts[0]?.path;
  const checkout = info?.checkouts.find((c) => c.path === checkoutPath) ?? info?.checkouts[0];
  useEffect(() => {
    if (checkout && projectId) store(`fledge:checkout:${projectId}`, checkout.path);
  }, [checkout, projectId]);

  // Follow each build as it starts.
  const runningId = jobs.find((j) => j.status === "running")?.id;
  useEffect(() => {
    if (runningId) setSelected(runningId);
  }, [runningId]);

  useEffect(() => {
    if (selected && logs[selected] === undefined) void loadLog(selected);
  }, [selected, logs, loadLog]);

  const job = jobs.find((j) => j.id === selected);
  const ready = !!current?.ready && !!info;

  const project = useMemo(
    () => ({
      flavors: info?.flavors ?? [],
      toggles: info?.toggles ?? [],
      releases: info?.releases ?? false,
      deployRoutes: info?.deployRoutes ?? [],
      shipChannel: info?.shipChannel ?? null,
    }),
    [info],
  );

  return (
    <ProjectContext.Provider value={project}>
      <div className="flex min-h-svh flex-col">
        <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
                <HugeiconsIcon icon={Rocket01Icon} className="size-4.5" />
              </div>
              <div className="leading-tight">
                <h1 className="text-sm font-semibold">fledge</h1>
                <p className="text-xs text-muted-foreground">
                  {info ? `Flutter ${info.flutter} · ${info.cli}` : "Flutter apps on this Mac"}
                </p>
              </div>
            </div>

            {projects && projects.length > 0 && (
              <div className="flex items-center gap-1">
                <Select value={projectId ?? undefined} onValueChange={setProjectId}>
                  <SelectTrigger className="h-9 w-52" aria-label="App">
                    <SelectValue placeholder="App" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="font-medium">{p.name}</span>
                        {!p.ready && <span className="size-1.5 rounded-full bg-warning" aria-label="needs setup" />}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {current && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" onClick={() => setEditing(true)} aria-label="App config">
                        <HugeiconsIcon icon={Settings02Icon} className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {current.name} config{current.source ? ` (${current.source})` : " — not set up"}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={() => setAdding(true)} aria-label="Add an app">
                      <HugeiconsIcon icon={Add01Icon} className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Add an app</TooltipContent>
                </Tooltip>
              </div>
            )}

            {ready && (
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
            )}

            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              {ready && view === "build" && info && (
                <Select value={checkout?.path} onValueChange={setCheckoutPath}>
                  <SelectTrigger className="h-9 w-full max-w-80 sm:w-72" aria-label="Checkout to build">
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
              {ready && view === "build" && checkout && (
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
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      void refreshProjects();
                      refresh();
                    }}
                    aria-label="Refresh"
                  >
                    <HugeiconsIcon icon={Refresh01Icon} className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh apps and checkouts</TooltipContent>
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

        {projects && projects.length === 0 && (
          <main className="mx-auto grid w-full max-w-xl flex-1 place-items-center p-4">
            <Card className="w-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HugeiconsIcon icon={FolderAddIcon} className="size-5" />
                  Add your first app
                </CardTitle>
                <CardDescription>
                  Pick a Flutter app on this Mac. fledge reads its flavors, bundle IDs, schemes and release conventions,
                  and shows you what it found before saving.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => setAdding(true)}>
                  <HugeiconsIcon icon={Add01Icon} className="size-4" />
                  Add an app
                </Button>
              </CardContent>
            </Card>
          </main>
        )}

        {current && !current.ready && (
          <main className="mx-auto grid w-full max-w-xl flex-1 place-items-center p-4">
            <Card className="w-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HugeiconsIcon icon={Settings02Icon} className="size-5" />
                  Set up {current.name}
                </CardTitle>
                <CardDescription className="space-y-2">
                  <span className="block font-mono text-xs break-all">{current.root}</span>
                  {current.error ? (
                    <span className="block whitespace-pre-wrap text-destructive">{current.error}</span>
                  ) : (
                    <span className="block">This app has no fledge config yet. fledge can detect one for you to review.</span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => setEditing(true)}>
                  <HugeiconsIcon icon={Settings02Icon} className="size-4" />
                  {current.error ? "Fix the config" : "Set up"}
                </Button>
              </CardContent>
            </Card>
          </main>
        )}

        {current?.ready && infoError && <p className="p-4 text-sm text-destructive">{infoError}</p>}

        {ready && projectId && (
          <>
            {/* Both tabs stay mounted (only hidden), so switching keeps loaded changes, drafted notes and form state.
                Keyed by app, so each app starts with its own. */}
            {/* pb-24: the end of the page can scroll clear of the mascot in the corner. */}
            <main className={cn("w-full flex-1 p-4 pb-24", view !== "release" && "hidden")}>
              <ReleasePanel key={projectId} project={projectId} />
            </main>
            <main
              className={cn(
                "grid w-full flex-1 grid-cols-[minmax(0,1fr)] gap-4 p-4 pb-24 lg:grid-cols-[400px_minmax(0,1fr)]",
                view !== "build" && "hidden",
              )}
            >
              <div className="lg:sticky lg:top-[73px] lg:max-h-[calc(100svh-89px)] lg:overflow-y-auto">
                <BuildForm key={projectId} projectId={projectId} checkout={checkout} />
              </div>
              {/* Argo CD style: the builds as tiles, or one build's steps and log. */}
              <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] lg:h-[calc(100svh-89px)] lg:grid-rows-[minmax(0,1fr)]">
                {job ? (
                  <BuildDetails job={job} log={logs[job.id]} onBack={() => setSelected(null)} />
                ) : (
                  <BuildTiles projectId={projectId} jobs={jobs} onSelect={setSelected} showProject={(projects?.length ?? 0) > 1} />
                )}
              </div>
            </main>
          </>
        )}

        {assistant && <Assistant app={projectId} onClose={() => setAssistant(false)} />}
        <Mascot open={assistant} onToggle={() => setAssistant(!assistant)} />
        <OutsideApprovals />

        <AddAppDialog
          open={adding}
          onOpenChange={setAdding}
          onAdded={(id) => {
            setProjectId(id);
            void refreshProjects();
          }}
        />
        {current && (
          <ConfigDialog
            app={current}
            open={editing}
            onOpenChange={setEditing}
            onSaved={() => {
              void refreshProjects();
              refresh();
            }}
            onRemoved={() => {
              setProjectId(null);
              void refreshProjects();
            }}
          />
        )}
      </div>
    </ProjectContext.Provider>
  );
}
