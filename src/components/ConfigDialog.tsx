import { Delete02Icon, FileEditIcon, Loading03Icon, MagicWand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { projectsApi, type ConfigFile, type ProjectSummary } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfigEditor } from "./ConfigEditor";
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

  const [writing, setWriting] = useState(false);
  async function writeOut() {
    setWriting(true);
    setError(null);
    try {
      const r = await projectsApi.writeCommands(app.id, JSON.parse(text));
      setText(JSON.stringify(r.config, null, 2));
    } catch (e) {
      setError(e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : (e as Error).message);
    } finally {
      setWriting(false);
    }
  }

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

        <ConfigEditor
          text={text}
          onChange={setText}
          busy={detecting ? "Detecting…" : undefined}
          advancedFooter={<CommandsHelp hasCommands={/"commands"\s*:/.test(text)} onWriteOut={() => void writeOut()} busy={writing} />}
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

/** Under the editor: how commands work, and a way to write them out for editing. */
function CommandsHelp({ hasCommands, onWriteOut, busy }: { hasCommands: boolean; onWriteOut: () => void; busy: boolean }) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
      {hasCommands ? (
        <p>
          <span className="font-medium">Build commands</span> are under <code className="font-mono">"commands"</code>: one
          line per output, run exactly as written (split on spaces, no shell). Edit them like terminal commands.
        </p>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <p>
            This config has no <code className="font-mono">"commands"</code> yet, so fledge builds the commands from the
            other settings. Write them out to see and edit the exact commands.
          </p>
          <Button size="sm" variant="outline" className="shrink-0" onClick={onWriteOut} disabled={busy}>
            {busy ? "Writing…" : "Write out commands"}
          </Button>
        </div>
      )}
      <p className="text-muted-foreground">
        Filled in per build: <code className="font-mono">{"{mode}"}</code> <code className="font-mono">{"{env}"}</code>{" "}
        <code className="font-mono">{"{flavor}"}</code> <code className="font-mono">{"{target}"}</code>{" "}
        <code className="font-mono">{"{sha}"}</code> <code className="font-mono">{"{exportMethod}"}</code>, and each
        environment's <code className="font-mono">vars</code>. Whole words that can expand to several arguments:{" "}
        <code className="font-mono">{"{flutter}"}</code> (e.g. fvm flutter), <code className="font-mono">{"{options}"}</code>{" "}
        (the switches ticked in the form), <code className="font-mono">{"{version}"}</code>,{" "}
        <code className="font-mono">{"{flavorArgs}"}</code> <code className="font-mono">{"{targetArgs}"}</code>{" "}
        <code className="font-mono">{"{envDefines}"}</code> <code className="font-mono">{"{envDefineFiles}"}</code>.
      </p>
    </div>
  );
}
