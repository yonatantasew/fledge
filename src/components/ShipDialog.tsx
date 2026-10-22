import { Copy01Icon, Loading03Icon, SlackIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { shipApi, type Job, type ShipPreview, type SlackStatus } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const SNIPPET = `"ship": { "slack": { "channel": "#deployments" } }`;

/** Ship a build to Slack: shows exactly what will be posted where, then posts it. */
export function ShipDialog({ job, open, onOpenChange }: { job: Job; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [preview, setPreview] = useState<ShipPreview | null>(null);
  const [slack, setSlack] = useState<SlackStatus | null>(null);
  const [note, setNote] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (n = note) => void shipApi.preview(job.id, n).then(setPreview);
  useEffect(() => {
    if (!open) return;
    setNote("");
    setError(null);
    setToken("");
    load("");
    void shipApi.slack().then(setSlack);
  }, [open, job.id]);
  // The note goes into the message, so the preview follows it.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(note), 300);
    return () => clearTimeout(t);
  }, [note]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      setSlack(await shipApi.connect(token));
      setToken("");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function ship() {
    setBusy(true);
    setError(null);
    try {
      await shipApi.ship(job.id, note);
      onOpenChange(false); // progress shows as a step in the build's tree
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = preview && !("error" in preview);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Rendered inside a clickable build tile: keep clicks and keys (space, Enter) from reaching it. */}
      <DialogContent className="sm:max-w-lg" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={SlackIcon} className="size-5" />
            Ship to Slack
          </DialogTitle>
          <DialogDescription>
            {slack?.connected ? `Posts as ${slack.bot} in ${slack.team}.` : "Uploads the build and posts a message in the app's channel."}
          </DialogDescription>
        </DialogHeader>

        {!preview && <HugeiconsIcon icon={Loading03Icon} className="mx-auto size-5 animate-spin text-muted-foreground" />}

        {preview && "error" in preview && preview.needs === "token" && (
          <div className="space-y-2">
            <Label htmlFor="slack-token">Bot token</Label>
            <Input id="slack-token" type="password" autoComplete="off" placeholder="xoxb-…" value={token} onChange={(e) => setToken(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              From the team's Slack app (README → Shipping has a manifest that sets it up). It's checked with Slack, then kept in this Mac's
              keychain; it never comes back to the page.
            </p>
          </div>
        )}

        {preview && "error" in preview && preview.needs === "channel" && (
          <div className="space-y-2 text-sm">
            <p>This app has no Slack channel yet. Add this to its config (the gear next to the app's name), then invite the bot to the channel:</p>
            <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-xs">
              <span className="flex-1">{SNIPPET}</span>
              <Button variant="ghost" size="icon" className="size-6" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(SNIPPET)}>
                <HugeiconsIcon icon={Copy01Icon} className="size-3.5" />
              </Button>
            </div>
          </div>
        )}

        {preview && "error" in preview && !preview.needs && <p className="text-sm text-destructive">{preview.error}</p>}

        {ready && (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
              <dt className="text-muted-foreground">Channel</dt>
              <dd className="font-medium">{preview.channel}</dd>
              <dt className="text-muted-foreground">File</dt>
              <dd className="truncate font-mono text-xs leading-5">
                {preview.file} · {(preview.size / 1048576).toFixed(1)} MB
              </dd>
            </dl>
            <div className="space-y-1.5">
              <Label htmlFor="ship-note">Note (optional)</Label>
              <Textarea id="ship-note" rows={2} placeholder="What to test, what changed…" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Message</p>
              <pre className="rounded-md border bg-muted/40 px-3 py-2 font-sans text-xs whitespace-pre-wrap">{preview.text}</pre>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          {slack?.connected && (
            <Button variant="ghost" className="mr-auto text-muted-foreground" onClick={() => void shipApi.disconnect().then(setSlack).then(() => load())}>
              Disconnect Slack
            </Button>
          )}
          {preview && "error" in preview && preview.needs === "token" ? (
            <Button disabled={busy || !token.trim()} onClick={() => void connect()}>
              {busy && <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" />}
              Connect
            </Button>
          ) : (
            <Button disabled={busy || !ready} onClick={() => void ship()}>
              {busy ? <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" /> : <HugeiconsIcon icon={SlackIcon} className="size-4" />}
              Ship
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
