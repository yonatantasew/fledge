import {
  ArrowDown01Icon,
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
import { useEffect, useState } from "react";
import { api, type ArchiveListing, type Job } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

function iconFor(e: Entry, open: boolean): IconSvgElement {
  if (e.kind === "dir") return open ? FolderOpenIcon : Folder01Icon;
  if (e.kind === "package") return PackageIcon;
  if (e.kind === "link") return Link01Icon;
  if (/\.(apk|aab|ipa)$/.test(e.name)) return FileZipIcon;
  if (/\.(json|plist|xcconfig)$/.test(e.name)) return CodeIcon;
  if (/\.(log|txt)$/.test(e.name)) return TextIcon;
  return File01Icon;
}

function RowActions({ job, entryPath, absolute }: { job: Job; entryPath: string; absolute: string }) {
  const act = (label: string, icon: IconSvgElement, run: () => void) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            run();
          }}
        >
          <HugeiconsIcon icon={icon} className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
  return (
    <span className="flex shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
      {act("Show in Finder", FolderOpenIcon, () => void api.revealFile(job.id, entryPath))}
      {act("Copy path", Copy01Icon, () => void navigator.clipboard.writeText(absolute))}
    </span>
  );
}

const indent = (depth: number) => ({ paddingLeft: `${0.75 + depth * 1.1}rem` });

/** One folder's contents, loaded when it's opened. */
function Folder({ job, path, depth }: { job: Job; path: string; depth: number }) {
  const [listing, setListing] = useState<ArchiveListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setError(null);
    void api.files(job.id, path).then(setListing, (e: Error) => setError(e.message));
  }, [job.id, path]);

  if (error) return <p className="py-1 text-xs text-destructive" style={indent(depth)}>{error}</p>;
  if (!listing)
    return (
      <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground" style={indent(depth)}>
        <HugeiconsIcon icon={Loading03Icon} className="size-3.5 animate-spin" />
        Loading…
      </p>
    );
  if (!listing.entries.length) return <p className="py-1 text-xs text-muted-foreground" style={indent(depth)}>Empty</p>;
  return (
    <ul>
      {listing.entries.map((e) => {
        const folder = e.kind === "dir" || e.kind === "package";
        const isOpen = open.has(e.path);
        const toggle = () =>
          setOpen((s) => {
            const next = new Set(s);
            if (!next.delete(e.path)) next.add(e.path);
            return next;
          });
        return (
          <li key={e.path}>
            <div
              className={cn("group/row flex items-center gap-1.5 py-0.5 pr-2 text-xs hover:bg-muted/60", folder && "cursor-pointer")}
              style={indent(depth)}
              onClick={folder ? toggle : undefined}
              {...(folder ? { role: "button", tabIndex: 0, "aria-expanded": isOpen, onKeyDown: (k: React.KeyboardEvent) => (k.key === "Enter" || k.key === " ") && (k.preventDefault(), toggle()) } : {})}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                {folder && <HugeiconsIcon icon={isOpen ? ArrowDown01Icon : ArrowRight01Icon} className="size-3" />}
              </span>
              <HugeiconsIcon icon={iconFor(e, isOpen)} className={cn("size-3.5 shrink-0", folder ? "text-info" : "text-muted-foreground")} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={e.name}>
                {e.name}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {e.kind === "file" && e.size !== undefined ? bytes(e.size) : folder ? `${e.items} item${e.items === 1 ? "" : "s"}` : "link"}
              </span>
              <RowActions job={job} entryPath={e.path} absolute={`${listing.root}/${e.path}`} />
            </div>
            {folder && isOpen && <Folder job={job} path={e.path} depth={depth + 1} />}
          </li>
        );
      })}
      {listing.truncated && (
        <li className="py-1 text-xs text-muted-foreground" style={indent(depth)}>
          Only the first 500 are shown; Show in Finder for the rest.
        </li>
      )}
    </ul>
  );
}

/** Files: a build as its folder in build/fledge/, opening into its subfolders and files. */
export function BuildFolder({ job: j, flavorLabel, onSelect }: { job: Job; flavorLabel: (f: string) => string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const s = STATUS[j.status];
  const folder = j.archiveDir?.split("/").pop();
  // A build still writing its folder re-reads it as it moves on.
  const stage = `${j.status}-${j.steps?.length ?? 0}`;
  return (
    <div>
      <div
        role="button"
        tabIndex={folder ? 0 : -1}
        aria-expanded={folder ? open : undefined}
        onClick={() => folder && setOpen(!open)}
        onKeyDown={(e) => folder && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
        className={cn("group/row flex items-center gap-2 border-l-4 px-3 py-1.5 outline-none focus-visible:bg-muted", s.edge, folder ? "cursor-pointer hover:bg-muted/60" : "opacity-70")}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {folder && <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="size-3" />}
        </span>
        <HugeiconsIcon icon={open ? FolderOpenIcon : Folder01Icon} className="size-4 shrink-0 text-info" />
        <HugeiconsIcon icon={s.icon} className={cn("size-3.5 shrink-0", s.className)} />
        <HugeiconsIcon icon={PLATFORM_ICON[j.platform]} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm font-medium">{flavorLabel(j.flavor)}</span>
        <span className="shrink-0 text-sm text-muted-foreground">{MODE_LABEL[j.mode]}</span>
        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
          {j.artifact}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={j.archiveDir}>
          {folder ?? "no folder: it never started"}
        </span>
        {folder && <RowActions job={j} entryPath="" absolute={j.archiveDir!} />}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-1.5 text-xs text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(j.id);
          }}
        >
          Details
          <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" />
        </Button>
      </div>
      {open && folder && <Folder key={stage} job={j} path="" depth={1} />}
    </div>
  );
}
