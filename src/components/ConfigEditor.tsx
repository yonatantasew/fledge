import { useEffect, useMemo, useRef, useState } from "react";
import { projectsApi, type BuildMode, type CommandPreview } from "@/api";
import { parseText, toText } from "@/config-form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ConfigForm } from "./ConfigForm";

/**
 * An app's config as a form (Settings) or as JSON (Advanced). Both edit the
 * same text, so switching never loses anything.
 */
export function ConfigEditor({
  appId,
  text,
  onChange,
  busy,
  advancedFooter,
}: {
  appId?: string; // a registered app: its environments then show their exact commands
  text: string;
  onChange: (text: string) => void;
  busy?: string; // shown instead of the editor while the config is being made, e.g. "Detecting…"
  advancedFooter?: React.ReactNode;
}) {
  const [tab, setTab] = useState("settings");
  const parsed = useMemo(() => parseText(text), [text]);

  // Each environment's exact commands, worked out by the server from the config as edited.
  const [mode, setMode] = useState<BuildMode>("release");
  const [preview, setPreview] = useState<{ list: CommandPreview[] | null; error: string | null }>({ list: null, error: null });
  const latest = useRef(0);
  useEffect(() => {
    if (!appId || "error" in parsed || !text.trim()) return;
    const n = ++latest.current;
    const t = setTimeout(() => {
      projectsApi.previewCommands(appId, parsed.value, mode).then(
        (r) => n === latest.current && setPreview({ list: r.commands, error: null }),
        (e: Error) => n === latest.current && setPreview((p) => ({ list: p.list, error: e.message })),
      );
    }, 400);
    return () => clearTimeout(t);
  }, [appId, parsed, text, mode]);

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-w-0">
      <TabsList>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="advanced">Advanced (JSON)</TabsTrigger>
      </TabsList>
      <TabsContent value="settings" className="pt-2">
        {busy && !text ? (
          <p className="text-sm text-muted-foreground">{busy}</p>
        ) : "error" in parsed ? (
          <p className="rounded-lg border border-destructive/40 p-3 text-sm">
            The JSON can't be read ({parsed.error}). Fix it in{" "}
            <button className="underline underline-offset-2" onClick={() => setTab("advanced")}>
              Advanced
            </button>{" "}
            to use the form again.
          </p>
        ) : (
          <>
            {preview.error && (
              <p className="mb-4 rounded-lg border border-destructive/40 p-3 text-xs whitespace-pre-wrap text-destructive">
                This config won't save as it is: {preview.error}
              </p>
            )}
            <ConfigForm
              value={parsed.value}
              onChange={(v) => onChange(toText(v))}
              commands={appId ? { mode, setMode, list: preview.list, error: preview.error } : undefined}
            />
          </>
        )}
      </TabsContent>
      <TabsContent value="advanced" className="space-y-3 pt-2">
        <p className="text-xs text-muted-foreground">
          The whole config as JSON, including what the form doesn't show: build commands, defines, deploy routes and more.
        </p>
        <Textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={busy ?? ""}
          className="min-h-80 font-mono text-xs leading-relaxed"
          spellCheck={false}
        />
        {advancedFooter}
      </TabsContent>
    </Tabs>
  );
}
