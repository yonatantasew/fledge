import { Delete02Icon, FileEditIcon, Loading03Icon, MagicWand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { projectsApi, type ConfigFile, type ProjectSummary } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { DetectionNotes } from "./DetectionNotes";

const SOURCE: Record<NonNullable<ConfigFile["source"]>, string> = {
  explicit: "file given with --config",
  local: "your config on this Mac",
  repo: "the app repository's fledge.json",
};

/** View and edit an app's config. Saving always writes the local file, which then wins over the repo's. */
export function ConfigDialog({
  app,
  open,
  onOpenChange,
  onSaved,
  onRemoved,
}: {
  app: ProjectSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onRemoved: () => void;
}) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [text, setText] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function detect() {
    setDetecting(true);
    setError(null);
    try {
      const d = await projectsApi.detect(app.root);
      setText(JSON.stringify(d.config, null, 2));
      setNotes(d.notes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetecting(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotes([]);
    setConfirmRemove(false);
    void projectsApi.config(app.id).then((f) => {
      setFile(f);
      setText(f.text);
      setError(f.error);
      if (!f.source) void detect(); // nothing yet: start from what can be detected
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, app.id]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await projectsApi.saveConfig(app.id, JSON.parse(text));
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirmRemove) return setConfirmRemove(true);
    try {
      await projectsApi.remove(app.id);
      onRemoved();
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const willOverride = file?.source === "repo";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={FileEditIcon} className="size-5" />
            {app.name} config
          </DialogTitle>
          <DialogDescription className="space-y-1">
            {file?.source ? (
              <>
                Using <Badge variant="secondary">{SOURCE[file.source]}</Badge>{" "}
                <span className="font-mono text-xs break-all">{file.file}</span>
              </>
            ) : (
              <>No config yet. This one was detected from the project; review it and save.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {willOverride && (
          <p className="text-xs text-muted-foreground">
            Saving writes <span className="font-mono">{file?.local}</span>, which then takes precedence over the repo's
            fledge.json on this Mac. The repo's file isn't changed.
          </p>
        )}
        {file?.source === "explicit" && (
          <p className="text-xs text-warning">
            This app was started with --config, which wins over everything else. Saving here writes your local file,
            which is used once you start fledge without --config.
          </p>
        )}

        <DetectionNotes notes={notes} />

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={detecting ? "Detecting…" : ""}
          className="min-h-80 font-mono text-xs leading-relaxed"
          spellCheck={false}
        />
        {error && <p className="text-sm whitespace-pre-wrap text-destructive">{error}</p>}

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void remove()}>
              <HugeiconsIcon icon={Delete02Icon} className="size-4" />
              {confirmRemove ? "Click again to remove" : "Remove app"}
            </Button>
            <Button variant="outline" onClick={() => void detect()} disabled={detecting}>
              <HugeiconsIcon icon={detecting ? Loading03Icon : MagicWand01Icon} className={detecting ? "size-4 animate-spin" : "size-4"} />
              {detecting ? "Detecting…" : "Detect again"}
            </Button>
          </div>
          <Button onClick={() => void save()} disabled={saving || !text.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
