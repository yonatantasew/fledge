import { ArrowLeft01Icon, Folder02Icon, FolderAddIcon, Loading03Icon, MagicWand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { projectsApi, type Detected } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfigEditor } from "./ConfigEditor";
import { DetectionNotes } from "./DetectionNotes";

/** Register a Flutter app: pick its folder, review the detected config, save. */
export function AddAppDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (id: string) => void;
}) {
  const [path, setPath] = useState("");
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath("");
    setDetected(null);
    setError(null);
    setCandidates(null);
    void projectsApi.candidates().then(setCandidates, () => setCandidates([]));
  }, [open]);

  async function detect(dir = path) {
    setPath(dir);
    setDetecting(true);
    setError(null);
    try {
      const d = await projectsApi.detect(dir.trim());
      setDetected(d);
      setName(d.root.split("/").pop() ?? "");
      setText(JSON.stringify(d.config, null, 2));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetecting(false);
    }
  }

  async function save() {
    if (!detected) return;
    setSaving(true);
    setError(null);
    try {
      const config = JSON.parse(text);
      const { id } = await projectsApi.add(detected.root, name, config);
      onAdded(id);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={FolderAddIcon} className="size-5" />
            Add an app
          </DialogTitle>
          <DialogDescription>
            {detected
              ? "Check what fledge found. The config is saved on this Mac only; it takes precedence over a fledge.json in the repo."
              : "Pick a Flutter app. fledge reads its flavors, bundle IDs, Xcode schemes, build defines and release conventions."}
          </DialogDescription>
        </DialogHeader>

        {!detected ? (
          <div className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="/Users/you/code/my_app"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && path.trim() && void detect()}
                className="font-mono"
                autoFocus
              />
              <Button onClick={() => void detect()} disabled={!path.trim() || detecting}>
                <HugeiconsIcon icon={detecting ? Loading03Icon : MagicWand01Icon} className={detecting ? "size-4 animate-spin" : "size-4"} />
                {detecting ? "Looking…" : "Detect"}
              </Button>
            </div>
            {detecting && (
              <p className="text-xs text-muted-foreground">
                Reading the project, git history, GitHub and Jira. This takes up to half a minute.
              </p>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Flutter apps found on this Mac</Label>
              {candidates === null ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" /> Looking in your usual folders…
                </p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">None found in ~/Documents, ~/Projects, ~/Developer and similar. Type the path above.</p>
              ) : (
                <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border">
                  {candidates.map((c) => (
                    <li key={c}>
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                        disabled={detecting}
                        onClick={() => void detect(c)}
                      >
                        <HugeiconsIcon icon={Folder02Icon} className="size-4 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{c.split("/").pop()}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">{c}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="truncate font-mono text-xs text-muted-foreground">{detected.root}</p>
            <div className="space-y-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input id="app-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <DetectionNotes notes={detected.notes} />
            <ConfigEditor text={text} onChange={setText} />
          </div>
        )}

        {error && <p className="text-sm whitespace-pre-wrap text-destructive">{error}</p>}

        {detected && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDetected(null)}>
              <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
              Back
            </Button>
            <Button onClick={() => void save()} disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Add app"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
