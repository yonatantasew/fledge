import { Alert02Icon, Loading03Icon, RocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { deployApi, type DeployPreview, type DeployWhat } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFlavorLabel, useProject } from "@/project";
import { MODE_LABEL, PLATFORM_ICON } from "./BuildForm";

/**
 * Start a deployment: its builds, where it posts, and the notes (what changed
 * since the last deploy), editable. Once all the builds have built, the notes
 * are posted with every file in one message.
 */
export function DeployDialog({
  open,
  onOpenChange,
  what,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  what: DeployWhat | null; // a route, or the selection without its channel (asked here)
  onStarted: (id: string) => void;
}) {
  const project = useProject();
  const flavorLabel = useFlavorLabel();
  const oneOff = !!what && !("route" in what);
  const [channel, setChannel] = useState("");
  const [preview, setPreview] = useState<DeployPreview | null>(null);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);

  const request = (): DeployWhat | null => (!what ? null : oneOff ? ({ ...what, channel } as DeployWhat) : what);

  async function gather() {
    const r = request();
    if (!r) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const p = await deployApi.preview(r);
      setPreview(p);
      setNotes(p.notes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setNotes("");
    setError(null);
    setConfirmed(false);
    setChannel(project.shipChannel ?? "");
    // A route knows its channel: gather the notes straight away. A one-off asks for the channel first.
    if (what && "route" in what) void gather();
  }, [open]);

  const confirmNames = [...new Set((preview?.builds ?? []).filter((b) => project.flavors.find((f) => f.name === b.flavor)?.confirm).map((b) => flavorLabel(b.flavor)))];
  const needsConfirm = confirmNames.length > 0;

  async function start() {
    const r = request();
    if (!r) return;
    setStarting(true);
    setError(null);
    try {
      const d = await deployApi.start(r, notes);
      onStarted(d.id);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={RocketIcon} className="size-5" />
            {preview?.label ?? (oneOff ? "Deploy what's selected" : "Deploy")}
          </DialogTitle>
          <DialogDescription>Builds, then posts the notes with every file in one message once they've all built. Nothing is posted if a build fails.</DialogDescription>
        </DialogHeader>

        {oneOff && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="deploy-channel">Slack channel</Label>
              <Input id="deploy-channel" placeholder="#channel" value={channel} onChange={(e) => setChannel(e.target.value.trim())} className="font-mono" />
            </div>
            <Button variant="outline" disabled={!channel || loading} onClick={() => void gather()}>
              {preview ? "Gather again" : "Gather notes"}
            </Button>
          </div>
        )}

        {loading && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" />
            Gathering what changed since the last deploy (a long range can take a minute)…
          </p>
        )}

        {preview && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {preview.builds.map((b, i) => (
                <span key={i} className="flex items-center gap-1">
                  <HugeiconsIcon icon={PLATFORM_ICON[b.platform]} className="size-3.5 text-muted-foreground" />
                  {flavorLabel(b.flavor)} {MODE_LABEL[b.mode]}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {b.artifact}
                  </Badge>
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Posts to <span className="font-medium text-foreground">{preview.channel}</span> · {preview.checkout.branch} @ {preview.checkout.sha.slice(0, 8)} · version {preview.version} ·
              changes since {preview.since ? `the last deploy (${preview.since.slice(0, 8)})` : "the last release"}
            </p>
            {preview.skipped.length > 0 && <p className="text-xs text-warning">Skipped: {preview.skipped.map((s) => s.reason).join("; ")}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="deploy-notes">Notes (Slack formatting; the files are listed below them when it posts)</Label>
              <Textarea id="deploy-notes" rows={14} value={notes} onChange={(e) => setNotes(e.target.value)} className="font-mono text-xs" />
            </div>
            {needsConfirm && (
              <label className="flex items-center gap-2 text-xs text-warning">
                <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
                <HugeiconsIcon icon={Alert02Icon} className="size-3.5" />
                This includes {confirmNames.join(", ")} builds.
              </label>
            )}
          </div>
        )}

        {error && <p className="text-sm whitespace-pre-wrap text-destructive">{error}</p>}

        <DialogFooter>
          <Button disabled={!preview || !notes.trim() || starting || (needsConfirm && !confirmed)} onClick={() => void start()}>
            {starting ? <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" /> : <HugeiconsIcon icon={RocketIcon} className="size-4" />}
            Build and deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
