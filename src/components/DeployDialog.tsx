import { Alert02Icon, Loading03Icon, RocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { deployApi, type DeployPreview, type DeployWhat, type OnFailure, type PostMode } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFlavorLabel, useProject } from "@/project";
import { cn } from "@/lib/utils";
import { MODE_LABEL, PLATFORM_ICON } from "./BuildForm";

// How a deploy posts: the route's setting, which a deploy can change.
const HOW: { id: string; post: PostMode; onFailure: OnFailure; label: string; hint: string }[] = [
  { id: "together", post: "together", onFailure: "hold", label: "Together", hint: "One message once all have built. Files upload as each finishes. Nothing if one fails." },
  { id: "post-built", post: "together", onFailure: "post-built", label: "Together, post what built", hint: "One message once all are done; a failed build is listed as not built." },
  { id: "as-built", post: "as-built", onFailure: "hold", label: "As each finishes", hint: "The notes with the first build to finish; each later one replies in their thread." },
];

const howId = (c: { post: PostMode; onFailure: OnFailure }) => (c.post === "as-built" ? "as-built" : c.onFailure === "post-built" ? "post-built" : "together");

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
  const [how, setHow] = useState("together");
  const [note, setNote] = useState("");
  const [savedDefault, setSavedDefault] = useState<string | null>(null);

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
      // Your last choice for this route, else the route's default.
      setHow(howId(p.remembered ?? p));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !what) return;
    setPreview(null);
    setNotes("");
    setError(null);
    setConfirmed(false);
    setSavedDefault(null);
    setChannel(project.shipChannel ?? "");
    setNote("");
    const route = "route" in what ? what.route : null;
    // What was picked last time: the one-off channel is needed before the notes, the note line after.
    void deployApi.choices(what.project, route).then((c) => {
      if (c?.channel && !route) setChannel(c.channel);
      if (c?.note) setNote(c.note);
    }, () => {});
    // A route knows its channel: gather the notes straight away. A one-off asks for the channel first.
    if (route) void gather();
  }, [open]);

  const confirmNames = [...new Set((preview?.builds ?? []).filter((b) => project.flavors.find((f) => f.name === b.flavor)?.confirm).map((b) => flavorLabel(b.flavor)))];
  const needsConfirm = confirmNames.length > 0;

  async function start() {
    const r = request();
    if (!r) return;
    setStarting(true);
    setError(null);
    try {
      const chosen = HOW.find((h) => h.id === how)!;
      const d = await deployApi.start(r, notes, { post: chosen.post, onFailure: chosen.onFailure }, note);
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
          <DialogDescription>Builds, then posts the notes and the files to Slack, the way you pick below.</DialogDescription>
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
            <div className="space-y-1.5" role="radiogroup" aria-label="How to post">
              <Label>How to post</Label>
              <div className="grid gap-1.5 sm:grid-cols-3">
                {HOW.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    role="radio"
                    aria-checked={how === h.id}
                    onClick={() => setHow(h.id)}
                    className={cn("rounded-md border p-2 text-left text-xs hover:bg-muted", how === h.id && "border-foreground/40 bg-muted")}
                  >
                    <span className="block font-medium">{h.label}</span>
                    <span className="text-muted-foreground">{h.hint}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {how === howId(preview) ? (
                  "The route's default."
                ) : (
                  <>
                    {preview.remembered && how === howId(preview.remembered) ? "Your last choice. " : ""}
                    {"route" in (what ?? {}) ? `The route's default is ${HOW.find((h) => h.id === howId(preview))!.label.toLowerCase()}.` : "One-off deploys default to together."}
                    {preview.canSaveDefault && what && "route" in what && (
                      <>
                        {" "}
                        {savedDefault === how ? (
                          <span className="text-success">Saved as the route's default.</span>
                        ) : (
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:text-foreground"
                            onClick={() => {
                              const chosen = HOW.find((h) => h.id === how)!;
                              void deployApi.saveRouteDefault(what.project, what.route, { post: chosen.post, onFailure: chosen.onFailure }).then(
                                // It is the route's default now.
                                () => (setSavedDefault(how), setPreview({ ...preview, post: chosen.post, onFailure: chosen.onFailure })),
                                (e: Error) => setError(e.message),
                              );
                            }}
                          >
                            Make this the route's default
                          </button>
                        )}
                      </>
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deploy-note">Your note (added under the notes, offered again next time)</Label>
              <Textarea id="deploy-note" rows={2} placeholder="What to test, or that this is a test deploy…" value={note} onChange={(e) => setNote(e.target.value)} />
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
