import {
  ArrowRight01Icon,
  CodeIcon,
  Copy01Icon,
  File01Icon,
  FileZipIcon,
  Folder01Icon,
  FolderOpenIcon,
  Link01Icon,
  Loading03Icon,
  PackageIcon,
  TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ArchiveListing, type Job } from "@/api";
import type { BuildGroup } from "@/build-groups";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MODE_LABEL, PLATFORM_ICON } from "./BuildForm";
import { STATUS } from "./build-status";

type Entry = ArchiveListing["entries"][number];

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  for (; v >= 1024 && i < units.length - 1; i++) v /= 1024;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function iconFor(e: Pick<Entry, "kind" | "name">, open = false): IconSvgElement {
  if (e.kind === "dir") return open ? FolderOpenIcon : Folder01Icon;
  if (e.kind === "package") return PackageIcon;
  if (e.kind === "link") return Link01Icon;
  if (/\.(apk|aab|ipa)$/.test(e.name)) return FileZipIcon;
  if (/\.(json|plist|xcconfig)$/.test(e.name)) return CodeIcon;
  if (/\.(log|txt)$/.test(e.name)) return TextIcon;
  return File01Icon;
}

const COLUMN = "flex w-64 shrink-0 flex-col border-r last:border-r-0";

/** A row in a column: icon, name, a quiet detail, and a › when it opens another column. */
function Row({ icon, iconClass, name, detail, opens, selected, onPick, mono = true }: {
  icon: IconSvgElement;
  iconClass?: string;
  name: React.ReactNode;
  detail?: string;
  opens: boolean;
  selected: boolean;
  onPick: () => void;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-primary text-primary-foreground hover:bg-primary",
      )}
    >
      <HugeiconsIcon icon={icon} className={cn("size-3.5 shrink-0", selected ? "text-primary-foreground" : iconClass)} />
      <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-[11.5px]")}>{name}</span>
      {detail && <span className={cn("shrink-0 tabular-nums", selected ? "text-primary-foreground/70" : "text-muted-foreground")}>{detail}</span>}
      {opens && <HugeiconsIcon icon={ArrowRight01Icon} className={cn("size-3 shrink-0", selected ? "text-primary-foreground/70" : "text-muted-foreground")} />}
    </button>
  );
}

/** One folder's contents as a column, loaded when it's opened. */
function DirColumn({ job, path, picked, onPick }: { job: Job; path: string; picked: string | null; onPick: (e: Entry, root: string) => void }) {
  const [listing, setListing] = useState<ArchiveListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setListing(null);
    setError(null);
    void api.files(job.id, path).then(setListing, (e: Error) => setError(e.message));
  }, [job.id, path, job.status, job.steps?.length]); // a running build's folder fills as its steps finish
  return (
    <div className={COLUMN}>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error && <p className="p-2 text-xs text-destructive">{error}</p>}
        {!listing && !error && <HugeiconsIcon icon={Loading03Icon} className="m-2 size-4 animate-spin text-muted-foreground" />}
        {listing && !listing.entries.length && <p className="p-2 text-xs text-muted-foreground">Empty</p>}
        {listing?.entries.map((e) => {
          const folder = e.kind === "dir" || e.kind === "package";
          return (
            <Row
              key={e.path}
              icon={iconFor(e, picked === e.path)}
              iconClass={folder ? "text-info" : "text-muted-foreground"}
              name={e.name}
              detail={e.kind === "file" && e.size !== undefined ? bytes(e.size) : undefined}
              opens={folder}
              selected={picked === e.path}
              onPick={() => onPick(e, listing.root)}
            />
          );
        })}
        {listing?.truncated && <p className="p-2 text-xs text-muted-foreground">Only the first 500; Show in Finder for the rest.</p>}
      </div>
    </div>
  );
}

/** The last column: what the picked file (or folder) is, and what to do with it. */
function InfoColumn({ job, entry, root, onOpenBuild }: { job: Job; entry: Entry; root: string; onOpenBuild: () => void }) {
  const absolute = `${root}/${entry.path}`;
  const folder = entry.kind === "dir" || entry.kind === "package";
  const facts: [string, string][] = [
    ["Kind", entry.kind === "package" ? "Package" : folder ? "Folder" : entry.kind === "link" ? "Link (not followed)" : (entry.name.split(".").pop() ?? "").toUpperCase() + " file"],
    ...(entry.size !== undefined ? [["Size", bytes(entry.size)] as [string, string]] : []),
    ...(entry.items !== undefined ? [["Contains", `${entry.items} item${entry.items === 1 ? "" : "s"}`] as [string, string]] : []),
    ["Modified", new Date(entry.modified).toLocaleString()],
    ["Where", entry.path],
  ];
  return (
    <div className={cn(COLUMN, "w-72")}>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="flex flex-col items-center gap-2 pt-2 text-center">
          <span className="flex size-14 items-center justify-center rounded-xl bg-muted">
            <HugeiconsIcon icon={iconFor(entry)} className={cn("size-7", folder ? "text-info" : "text-muted-foreground")} />
          </span>
          <span className="font-mono text-xs font-medium break-all">{entry.name}</span>
        </div>
        <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono text-[11px] break-all">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void api.revealFile(job.id, entry.path)}>
            <HugeiconsIcon icon={FolderOpenIcon} className="size-4" />
            Show in Finder
          </Button>
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(absolute)}>
            <HugeiconsIcon icon={Copy01Icon} className="size-4" />
            Copy path
          </Button>
          {entry.name === "build.log" && (
            <Button size="sm" variant="outline" onClick={onOpenBuild}>
              <HugeiconsIcon icon={TextIcon} className="size-4" />
              Open the log
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Files: Finder's column view. The builds (by group) in the first column; a
 * build's folder in the next; each folder picked opens another column to the
 * right, and a file picked shows what it is in the last.
 */
export function FileBrowser({ groups, grouped, flavorLabel, onSelect }: {
  groups: BuildGroup[];
  grouped: boolean;
  flavorLabel: (f: string) => string;
  onSelect: (id: string) => void;
}) {
  const builds = groups.flatMap((g) => g.builds);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [trail, setTrail] = useState<{ entry: Entry; root: string }[]>([]); // what's picked in each column after the build's
  const job = builds.find((b) => b.id === buildId) ?? null;
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the newest column in view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [buildId, trail.length]);

  const pickIn = (level: number) => (entry: Entry, root: string) => setTrail((t) => [...t.slice(0, level), { entry, root }]);
  const last = trail.at(-1);
  // Folders along the trail each open a column; the folder at `trail[i]` is listed by column i + 2.
  const folders = trail.filter((t) => t.entry.kind === "dir" || t.entry.kind === "package");

  return (
    <div ref={scroller} className="flex h-full min-h-80 overflow-x-auto rounded-lg border bg-card">
      <div className={cn(COLUMN, "w-72")}>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {groups.map((g) => (
            <div key={g.key}>
              {grouped && <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{g.label}</p>}
              {g.builds.map((b) => {
                const s = STATUS[b.status];
                const folder = b.archiveDir?.split("/").pop();
                return (
                  <Row
                    key={b.id}
                    icon={s.icon}
                    iconClass={cn(s.className, "animate-none")}
                    mono={false}
                    name={
                      <span className="flex items-center gap-1.5">
                        <HugeiconsIcon icon={PLATFORM_ICON[b.platform]} className="size-3 shrink-0 opacity-70" />
                        <span className="font-medium">{flavorLabel(b.flavor)}</span>
                        <span className="opacity-70">{MODE_LABEL[b.mode]}</span>
                        <Badge variant="outline" className="h-4 px-1 font-mono text-[9px] text-inherit">
                          {b.artifact}
                        </Badge>
                      </span>
                    }
                    detail={folder ? folder.slice(9, 15).replace(/(..)(..)(..)/, "$1:$2") : "no folder"}
                    opens={!!folder}
                    selected={buildId === b.id}
                    onPick={() => {
                      setBuildId(b.id);
                      setTrail([]);
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {job && !job.archiveDir && (
        <div className={COLUMN}>
          <p className="p-3 text-xs text-muted-foreground">This build never started, so it has no folder.</p>
        </div>
      )}
      {job?.archiveDir && (
        <>
          <DirColumn job={job} path="" picked={trail[0]?.entry.path ?? null} onPick={pickIn(0)} />
          {folders.map((f, i) => (
            <DirColumn key={f.entry.path} job={job} path={f.entry.path} picked={trail[i + 1]?.entry.path ?? null} onPick={pickIn(i + 1)} />
          ))}
          {last && <InfoColumn key={last.entry.path} job={job} entry={last.entry} root={last.root} onOpenBuild={() => onSelect(job.id)} />}
        </>
      )}
      {!job && <p className="self-center px-6 text-xs text-muted-foreground">Pick a build to see its folder.</p>}
    </div>
  );
}
