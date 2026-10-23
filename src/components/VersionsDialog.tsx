import { HugeiconsIcon } from "@hugeicons/react";
import { RocketIcon } from "@hugeicons/core-free-icons";
import type { VersionsInfo } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useFlavorLabel } from "@/project";
import { PLATFORM_ICON } from "./BuildForm";

const HOW = { auto: "next, picked by fledge", typed: "typed in", pubspec: "pubspec's" } as const;

/** Every version fledge built for this app, newest first, and the next one. */
export function VersionsDialog({ open, onOpenChange, info }: { open: boolean; onOpenChange: (o: boolean) => void; info: VersionsInfo | null }) {
  const flavorLabel = useFlavorLabel();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Versions</DialogTitle>
          <DialogDescription>
            {info ? (
              <>
                Next: <span className="font-mono font-medium text-foreground">{info.next.version}</span>
                {info.next.after && <> · after {info.next.after.version} ({info.next.after.label})</>} · based on{" "}
                {info.settings.basedOn === "releases" ? "release tags" : "the highest version seen anywhere"}. The build number only goes up.
              </>
            ) : (
              "Loading…"
            )}
          </DialogDescription>
        </DialogHeader>
        {info && !info.history.length && <p className="text-sm text-muted-foreground">Nothing built by fledge yet.</p>}
        <ul className="divide-y rounded-lg border">
          {info?.history.map((r, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="w-24 shrink-0 font-mono font-medium">{r.version}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                {r.builds.map((b) => (
                  <Badge key={b.id} variant="outline" className="gap-1 font-normal">
                    <HugeiconsIcon icon={PLATFORM_ICON[b.platform]} className="size-3" />
                    {flavorLabel(b.environment)} {b.artifact}
                  </Badge>
                ))}
                {r.deployment && (
                  <Badge variant="secondary" className="gap-1">
                    <HugeiconsIcon icon={RocketIcon} className="size-3" />
                    deployed
                  </Badge>
                )}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {HOW[r.how]}
                {r.pubspecCommit ? `, committed ${r.pubspecCommit.slice(0, 8)}` : ""} · {r.branch} @ {r.sha.slice(0, 8)} · {new Date(r.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
