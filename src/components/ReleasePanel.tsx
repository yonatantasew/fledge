import {
  AiMagicIcon,
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  GitPullRequestIcon,
  GithubIcon,
  Link01Icon,
  Loading03Icon,
  RotateClockwiseIcon,
  SentIcon,
  Tag01Icon,
  Ticket01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  releaseApi,
  useReleaseLog,
  type Connections,
  type MergedPr,
  type Notes,
  type PublishResult,
  type ReleaseFacts,
  type ReleaseSettings,
  type ReleaseTag,
} from "@/api";
import { bumpValues } from "../../server/notes.ts";
import { fill } from "../../server/template.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function statusTone(status: string, fromStatus?: string) {
  if (status === fromStatus) return "border-info/40 text-info";
  if (/done|closed|released/i.test(status)) return "border-success/40 text-success";
  return "border-warning/50 text-warning";
}

function Connection({ icon, label, ok, detail }: { icon: IconSvgElement; label: string; ok: boolean; detail?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="h-8 gap-1.5 px-2.5 text-xs">
          <HugeiconsIcon icon={icon} className="size-3.5" />
          {label}
          <span className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-destructive")} />
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

export function ReleasePanel({ project }: { project: string }) {
  const [connections, setConnections] = useState<Connections | null>(null);
  const [tags, setTags] = useState<ReleaseTag[]>([]);
  const [baseTag, setBaseTag] = useState<string>("");
  const [prerelease, setPrerelease] = useState(true);
  const [updateJira, setUpdateJira] = useState(true);
  const [settings, setSettings] = useState<ReleaseSettings | null | undefined>(undefined);
  const fromStatus = settings?.jira?.fromStatus;

  const [facts, setFacts] = useState<ReleaseFacts | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [notes, setNotes] = useState<Notes>({ slack: "", github: "" });
  const [edited, setEdited] = useState(false); // hand-edited or drafted: stop re-rendering the template
  const [drafting, setDrafting] = useState(false);
  const [draftInfo, setDraftInfo] = useState<{ warnings: string[]; model: string } | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [confirm, setConfirm] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const log = useReleaseLog(project);

  useEffect(() => {
    void releaseApi.connections(project).then(setConnections);
    void releaseApi.settings(project).then(setSettings);
    void releaseApi.tags(project).then((t) => {
      setTags(t);
      setBaseTag((b) => b || t[0]?.tag || "");
    });
  }, []);

  // The facts the notes and the publish use: the loaded range minus unticked PRs.
  const effective = useMemo<ReleaseFacts | null>(
    () => (facts ? { ...facts, prerelease, prs: facts.prs.filter((p) => !excluded.has(p.number)) } : null),
    [facts, excluded, prerelease],
  );

  useEffect(() => {
    if (!effective || edited) return;
    const t = setTimeout(() => void releaseApi.template(project, effective).then(setNotes), 200);
    return () => clearTimeout(t);
  }, [effective, edited]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    setResult(null);
    setDraftInfo(null);
    try {
      const r = await releaseApi.facts(project, baseTag || null, prerelease);
      setFacts(r.facts);
      setExcluded(new Set(r.facts.prs.filter((p) => p.versionBump).map((p) => p.number)));
      setNotes(r.templates);
      setEdited(false);
      setConfirm("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function draft() {
    if (!effective) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const r = await releaseApi.draft(project, effective);
      setNotes({ slack: r.slack, github: r.github });
      setDraftInfo({ warnings: r.warnings, model: r.model });
      setEdited(true);
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  async function doPublish(dryRun = false) {
    if (!effective) return;
    setPublishing(true);
    setPublishError(null);
    log.clear();
    try {
      const r = await releaseApi.publish(project, effective, notes.github, prerelease, updateJira && !!settings?.jira, dryRun);
      if (!dryRun) setResult(r);
    } catch (e) {
      setPublishError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  const tag = effective ? `v${effective.version}` : "";
  const ticketKeys = [...new Set(effective?.prs.flatMap((p) => p.tickets) ?? [])];
  const willMove = ticketKeys.filter((k) => fromStatus && effective?.tickets[k]?.status === fromStatus);
  const bump = effective && settings ? bumpValues(effective) : null;
  const versionOk = /^\d+\.\d+\.\d+\+\d+$/.test(effective?.version ?? "");
  const canPublish = !!effective && effective.prs.length > 0 && versionOk && confirm === tag && !publishing && !result;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={Tag01Icon} className="size-5" />
              Release range
            </CardTitle>
            <CardDescription className="col-start-1">Everything merged to main since the release you pick.</CardDescription>
            {/* Below the title on a phone, where there's no room beside it. */}
            <CardAction className="col-start-1 row-start-3 flex flex-wrap gap-1.5 justify-self-start sm:col-start-2 sm:row-start-1 sm:justify-self-end">
              {connections && (
                <>
                  <Connection icon={GithubIcon} label="GitHub" ok={connections.github.ok} detail={connections.github.login ?? connections.github.error} />
                  <Connection icon={Ticket01Icon} label="Jira" ok={connections.jira.ok} detail={connections.jira.email ?? connections.jira.error} />
                  <Connection icon={AiMagicIcon} label="Model" ok={connections.model.ok} detail={connections.model.name ?? connections.model.error} />
                </>
              )}
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1 space-y-1.5">
                <Label className="text-xs text-muted-foreground">Since release</Label>
                <Select value={baseTag} onValueChange={setBaseTag}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No previous release" />
                  </SelectTrigger>
                  <SelectContent>
                    {tags.map((t) => (
                      <SelectItem key={t.tag} value={t.tag}>
                        <span className="font-mono">{t.tag}</span>
                        <span className="text-xs text-muted-foreground">
                          {t.prerelease ? "pre-release" : "release"} · {new Date(t.createdAt).toLocaleDateString()}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={load} disabled={loading}>
                <HugeiconsIcon icon={loading ? Loading03Icon : RotateClockwiseIcon} className={cn("size-4", loading && "animate-spin")} />
                {loading ? `Reading GitHub${settings?.jira ? " and Jira" : ""}…` : facts ? "Reload" : "Load changes"}
              </Button>
            </div>
            {loadError && <p className="text-sm text-destructive">{loadError}</p>}

            {facts && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="version" className="text-xs text-muted-foreground">
                      Version
                    </Label>
                    <Input
                      id="version"
                      className={cn("font-mono", !versionOk && "border-destructive")}
                      value={facts.version}
                      onChange={(e) => setFacts({ ...facts, version: e.target.value.trim().replace(/^v/, "") })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="date" className="text-xs text-muted-foreground">
                      Deployment date
                    </Label>
                    <Input id="date" value={facts.date} onChange={(e) => setFacts({ ...facts, date: e.target.value })} />
                  </div>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {facts.previous ? `${facts.previous.base.slice(0, 8)} (${facts.previous.tag})` : "start"} → main @{" "}
                  {facts.head.sha.slice(0, 8)} · {facts.prs.length} PRs
                </p>
                <PrTable
                  prs={facts.prs}
                  tickets={facts.tickets}
                  jiraSite={facts.jiraSite}
                  fromStatus={fromStatus}
                  excluded={excluded}
                  onToggle={(n) =>
                    setExcluded((s) => {
                      const next = new Set(s);
                      if (next.has(n)) next.delete(n);
                      else next.add(n);
                      return next;
                    })
                  }
                />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={AiMagicIcon} className="size-5" />
              Notes
            </CardTitle>
            <CardDescription>
              {edited ? (draftInfo ? `Drafted by ${draftInfo.model}` : "Edited") : "From the template — the assistant's model can rewrite them for testers"}
            </CardDescription>
            <CardAction className="flex gap-1.5">
              {edited && (
                <Button variant="ghost" size="sm" onClick={() => (setEdited(false), setDraftInfo(null))}>
                  Reset
                </Button>
              )}
              <Button size="sm" disabled={!effective || drafting} onClick={draft}>
                <HugeiconsIcon icon={drafting ? Loading03Icon : AiMagicIcon} className={cn("size-4", drafting && "animate-spin")} />
                {drafting ? "Drafting…" : "Draft notes"}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            {draftError && <p className="text-sm text-destructive">{draftError}</p>}
            {draftInfo && draftInfo.warnings.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
                <p className="mb-1.5 flex items-center gap-1.5 font-medium text-warning">
                  <HugeiconsIcon icon={Alert02Icon} className="size-4" />
                  Check before posting
                </p>
                <ul className="list-disc space-y-1 pl-5 text-foreground/90">
                  {draftInfo.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <Tabs defaultValue="slack">
              <TabsList>
                <TabsTrigger value="slack">Channel note</TabsTrigger>
                <TabsTrigger value="github">GitHub release</TabsTrigger>
              </TabsList>
              {(["slack", "github"] as const).map((k) => (
                <TabsContent key={k} value={k} className="relative">
                  <Textarea
                    value={notes[k]}
                    onChange={(e) => {
                      setNotes({ ...notes, [k]: e.target.value });
                      setEdited(true);
                    }}
                    placeholder="Load changes to fill this in."
                    className="min-h-80 font-mono text-xs leading-relaxed"
                  />
                  <CopyButton text={notes[k]} />
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={SentIcon} className="size-5" />
              Publish
            </CardTitle>
            <CardDescription>Runs in a temporary worktree — none of your checkouts move.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="pre">Pre-release</Label>
                  <p className="text-xs text-muted-foreground">Marks it as a pre-release on GitHub, which also starts any workflows the repo runs on pre-releases.</p>
                </div>
                <Switch id="pre" checked={prerelease} onCheckedChange={setPrerelease} />
              </div>
              {settings?.jira && (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="jira">Update Jira from here</Label>
                  <p className="text-xs text-muted-foreground">
                    Moves tickets in &ldquo;{settings?.jira?.fromStatus}&rdquo; to &ldquo;{settings?.jira?.toStatus}&rdquo; and comments the release link. Turn it off if a GitHub workflow already does this on release, or tickets get two comments.
                  </p>
                </div>
                <Switch id="jira" checked={updateJira} onCheckedChange={setUpdateJira} />
              </div>
              )}
            </div>

            {effective && (
              <ol className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
                <Step n={1}>
                  Branch <code className="font-mono text-xs">{bump ? fill(settings!.branch, bump) : "…"}</code> from{" "}
                  {settings?.baseBranch ?? "main"} @ {effective.head.sha.slice(0, 8)}, set{" "}
                  <code className="font-mono text-xs">version: {effective.version}</code>, push
                </Step>
                <Step n={2}>
                  Open PR <span className="font-medium">{bump ? fill(settings!.prTitle, bump) : "…"}</span>
                </Step>
                <Step n={3}>
                  Create GitHub {prerelease ? "pre-release" : "release"} <span className="font-mono">{tag}</span> on the bump commit with the GitHub notes
                </Step>
                {updateJira && settings?.jira && (
                  <Step n={4}>
                    Jira: move {willMove.length} of {ticketKeys.length} tickets {settings.jira.fromStatus} → {settings.jira.toStatus}, comment the release link on all {ticketKeys.length}
                  </Step>
                )}
              </ol>
            )}
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            {!result && (
              <div className="flex gap-2">
                <Input
                  placeholder={tag ? `Type ${tag} to confirm` : "Load changes first"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value.trim())}
                  disabled={!effective || publishing}
                  className="font-mono"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" disabled={!effective || !versionOk || publishing} onClick={() => void doPublish(true)}>
                      Dry run
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Makes the bump commit locally, prints what it would push and create, then discards it.</TooltipContent>
                </Tooltip>
                <Button variant="destructive" disabled={!canPublish} onClick={() => void doPublish()}>
                  <HugeiconsIcon icon={publishing ? Loading03Icon : SentIcon} className={cn("size-4", publishing && "animate-spin")} />
                  {publishing ? "Publishing…" : "Publish"}
                </Button>
              </div>
            )}
            {publishError && <p className="text-sm text-destructive">{publishError}</p>}
            {result && (
              <div className="space-y-1.5 rounded-lg border border-success/40 bg-success/5 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium text-success">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-4" />
                  {result.tag} published
                </p>
                {result.releaseUrl && <ExtLink href={result.releaseUrl} icon={Tag01Icon} label="GitHub release" />}
                {result.prUrl && <ExtLink href={result.prUrl} icon={GitPullRequestIcon} label="Version-bump PR" />}
              </div>
            )}
            {log.lines.length > 0 && (
              <pre className="max-h-56 overflow-auto rounded-lg bg-log p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-log-foreground">
                {log.lines.join("\n")}
              </pre>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-background text-[11px] font-medium tabular-nums ring-1 ring-border">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function ExtLink({ href, icon, label }: { href: string; icon: IconSvgElement; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-foreground underline-offset-2 hover:underline">
      <HugeiconsIcon icon={icon} className="size-4 text-muted-foreground" />
      {label}
      <span className="truncate font-mono text-xs text-muted-foreground">{href.replace("https://github.com/", "")}</span>
    </a>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <Button
      variant="secondary"
      size="sm"
      className="absolute top-2 right-2"
      disabled={!text}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      }}
    >
      <HugeiconsIcon icon={copied ? CheckmarkCircle02Icon : Copy01Icon} className="size-4" />
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function PrTable({
  prs,
  tickets,
  jiraSite,
  fromStatus,
  excluded,
  onToggle,
}: {
  prs: MergedPr[];
  fromStatus?: string;
  tickets: ReleaseFacts["tickets"];
  jiraSite: string;
  excluded: Set<number>;
  onToggle: (n: number) => void;
}) {
  if (!prs.length) return <p className="text-sm text-muted-foreground">Nothing merged since that release.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {prs.map((p) => {
        const off = excluded.has(p.number);
        return (
          <li key={p.number} className={cn("flex items-start gap-3 px-3 py-2.5", off && "opacity-50")}>
            <Checkbox className="mt-0.5" checked={!off} onCheckedChange={() => onToggle(p.number)} aria-label={`Include #${p.number}`} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-baseline gap-2">
                <a href={p.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-xs text-muted-foreground hover:underline">
                  #{p.number}
                </a>
                <span className="text-sm leading-snug">{p.title}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{p.dri}</span>
                <span>·</span>
                <span className="tabular-nums">
                  {p.changedFiles} files, +{p.additions} −{p.deletions}
                </span>
                {p.versionBump && <Badge variant="secondary">version bump</Badge>}
                {p.stackedOn.length > 0 && (
                  <Badge variant="outline" className="border-warning/50 text-warning">
                    stacked on {p.stackedOn.map((n) => `#${n}`).join(", ")}
                  </Badge>
                )}
                {!p.tickets.length && !p.versionBump && (
                  <Badge variant="outline" className="border-warning/50 text-warning">
                    no ticket
                  </Badge>
                )}
                {p.tickets.map((k) => {
                  const t = tickets[k];
                  return (
                    <Tooltip key={k}>
                      <TooltipTrigger asChild>
                        <a href={`${jiraSite}/browse/${k}`} target="_blank" rel="noreferrer">
                          <Badge variant="outline" className={cn("gap-1 font-mono", t ? statusTone(t.status, fromStatus) : "")}>
                            <HugeiconsIcon icon={Link01Icon} className="size-3" />
                            {k}
                            {t && <span className="font-sans">· {t.status}</span>}
                          </Badge>
                        </a>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-80">{t ? `${t.summary}${t.assignee ? ` · ${t.assignee}` : ""}` : "Not found in Jira"}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
