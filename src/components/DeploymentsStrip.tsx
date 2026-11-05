import { Alert02Icon, ArrowDown01Icon, ArrowRight01Icon, Cancel01Icon, CheckmarkCircle02Icon, Loading03Icon, PauseIcon, RocketIcon, SlackIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useState } from "react";
import { deployApi, type Deployment, type DeployStatus, type Job } from "@/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFlavorLabel } from "@/project";
import { MODE_LABEL, PLATFORM_ICON } from "./BuildForm";
import { STATUS } from "./build-status";

const STATE: Record<DeployStatus, { icon: IconSvgElement; className: string; label: string }> = {
  building: { icon: Loading03Icon, className: "text-info animate-spin", label: "Building" },
  posting: { icon: SlackIcon, className: "text-info", label: "Posting" },
  posted: { icon: CheckmarkCircle02Icon, className: "text-success", label: "Posted" },
  held: { icon: PauseIcon, className: "text-warning", label: "Held" },
  failed: { icon: Alert02Icon, className: "text-destructive", label: "Post failed" },
  cancelled: { icon: Cancel01Icon, className: "text-muted-foreground", label: "Cancelled" },
};
const ACTIVE: DeployStatus[] = ["building", "posting", "held", "failed"];

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

function duration(s: number) {
  const m = Math.round(s / 60);
  return s < 60 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Which of its builds' files have gone up: staged (together) or posted (as each finishes). */
function uploadedOf(d: Deployment) {
  return new Set(d.mode === "as-built" ? (d.handled ?? []) : Object.keys(d.staged ?? {}));
}

/** The file going up now: a bar, which file of how many, its speed and what's left of it. */
function UploadProgress({ d }: { d: Deployment }) {
  const u = d.upload!;
  const pct = u.total ? Math.min(100, (u.sent / u.total) * 100) : 0;
  const secs = (Date.now() - u.startedAt) / 1000;
  const rate = secs > 2 ? u.sent / secs : 0; // bytes a second; too soon to say in the first moments
  const done = uploadedOf(d).size;
  return (
    <div className="space-y-1 px-3 pb-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`Uploading ${u.name}`}>
        <div className="h-full rounded-full bg-info transition-[width] duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-medium text-foreground">{u.name}</span>
        <span>
          file {Math.min(done + 1, d.builds.length)} of {d.builds.length}
        </span>
        <span>
          {mb(u.sent)} / {mb(u.total)} ({Math.floor(pct)}%)
        </span>
        {rate > 0 && <span>{mb(rate)}/s</span>}
        {rate > 0 && u.sent < u.total && <span>about {duration((u.total - u.sent) / rate)} left for this file</span>}
      </p>
    </div>
  );
}

function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
}

/** The app's deployments above its builds: what each is waiting for, posting, or why it's held. */
export function DeploymentsStrip({ deployments, jobs, onSelect }: { deployments: Deployment[]; jobs: Job[]; onSelect: (id: string) => void }) {
  const [showRecent, setShowRecent] = useState(false);
  const active = deployments.filter((d) => ACTIVE.includes(d.status));
  const recent = deployments.filter((d) => !ACTIVE.includes(d.status)).slice(0, 5);
  if (!active.length && !recent.length) return null;
  return (
    <div className="space-y-1.5 px-6">
      {active.map((d) => (
        <DeploymentRow key={d.id} d={d} jobs={jobs} onSelect={onSelect} />
      ))}
      {recent.length > 0 && (
        <>
          <button type="button" onClick={() => setShowRecent(!showRecent)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <HugeiconsIcon icon={showRecent ? ArrowDown01Icon : ArrowRight01Icon} className="size-3" />
            {recent.length} recent deployment{recent.length === 1 ? "" : "s"}
          </button>
          {showRecent && recent.map((d) => <DeploymentRow key={d.id} d={d} jobs={jobs} onSelect={onSelect} />)}
        </>
      )}
    </div>
  );
}

function DeploymentRow({ d, jobs, onSelect }: { d: Deployment; jobs: Job[]; onSelect: (id: string) => void }) {
  const flavorLabel = useFlavorLabel();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = STATE[d.status];
  const builds = d.builds.map((id) => jobs.find((j) => j.id === id));
  const uploaded = uploadedOf(d);
  const act = (run: () => Promise<unknown>) => () => {
    setError(null);
    void run().catch((e: Error) => setError(e.message));
  };
  return (
    <div className={cn("rounded-lg border bg-card text-sm", d.status === "held" && "border-warning/50", d.status === "failed" && "border-destructive/50")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 items-center gap-2 text-left">
          <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
          <HugeiconsIcon icon={RocketIcon} className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{d.label}</span>
          <span className="text-xs text-muted-foreground">
            → {d.channel} · {d.mode === "as-built" ? "as each finishes" : d.onFailure === "post-built" ? "together, post what built" : "together"}
          </span>
        </button>
        <span className="flex items-center gap-1 text-xs">
          <HugeiconsIcon icon={st.icon} className={cn("size-3.5", st.className)} />
          {st.label}
        </span>
        <span className="flex items-center gap-1" aria-label="Its builds">
          {builds.map((b, i) =>
            b ? (
              <HugeiconsIcon key={i} icon={STATUS[b.status].icon} className={cn("size-3.5", STATUS[b.status].className)} />
            ) : (
              <span key={i} className="size-3.5" />
            ),
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={d.error ?? d.progress}>
          {(d.upload && `uploading, ${uploaded.size} of ${d.builds.length} up`) ??
            d.progress ??
            d.error ??
            (d.status === "building" && d.staged && Object.keys(d.staged).length
              ? `${Object.keys(d.staged).length} of ${d.builds.length} uploaded, waiting for the rest`
              : null) ??
            (d.posted ? `${d.posted.files.length} file${d.posted.files.length === 1 ? "" : "s"}${d.posted.missing.length ? `, ${d.posted.missing.length} not built` : ""}` : "")}
        </span>
        <span className="text-xs text-muted-foreground">{ago(d.endedAt ?? d.createdAt)}</span>
        {(d.status === "held" || d.status === "failed") && (
          <Button size="sm" variant="outline" className="h-7" onClick={act(() => deployApi.postWhatBuilt(d.id))}>
            Post what built
          </Button>
        )}
        {(d.status === "building" || d.status === "held") && (
          <Button size="sm" variant="ghost" className="h-7 text-destructive hover:text-destructive" onClick={act(() => deployApi.cancel(d.id))}>
            Cancel
          </Button>
        )}
      </div>
      {d.upload && <UploadProgress d={d} />}
      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
      {open && (
        <div className="grid gap-3 border-t px-3 py-2 md:grid-cols-[minmax(0,1fr)_16rem]">
          <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-sans text-xs whitespace-pre-wrap">{d.notes}</pre>
          <ul className="space-y-1 text-xs">
            {builds.map((b, i) =>
              b ? (
                <li key={b.id}>
                  <button type="button" onClick={() => onSelect(b.id)} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-muted">
                    <HugeiconsIcon icon={STATUS[b.status].icon} className={cn("size-3.5", STATUS[b.status].className)} />
                    <HugeiconsIcon icon={PLATFORM_ICON[b.platform]} className="size-3.5 text-muted-foreground" />
                    {flavorLabel(b.flavor)} {MODE_LABEL[b.mode]} {b.artifact}
                    <span className="ml-auto text-muted-foreground">
                      {d.upload?.build === b.id
                        ? `uploading ${d.upload.total ? Math.floor((d.upload.sent / d.upload.total) * 100) : 0}%`
                        : uploaded.has(b.id) && d.status !== "posted"
                          ? "uploaded"
                          : ""}
                    </span>
                    <HugeiconsIcon icon={ArrowRight01Icon} className="size-3 text-muted-foreground" />
                  </button>
                </li>
              ) : (
                <li key={i} className="px-1.5 text-muted-foreground">
                  a build that was cleared
                </li>
              ),
            )}
            <li className="px-1.5 pt-1 text-muted-foreground">
              {d.branch} @ {d.sha.slice(0, 8)}
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
