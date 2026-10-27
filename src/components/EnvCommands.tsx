import { Add01Icon, ArrowTurnBackwardIcon, Edit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { BuildMode, CommandPreview } from "@/api";
import { getIn, type Obj } from "@/config-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CommandLine } from "./CommandLine";

/** The config dialog's command previews, shared by every environment card. */
export interface CommandsPreview {
  mode: BuildMode;
  setMode: (m: BuildMode) => void;
  list: CommandPreview[] | null;
  error: string | null;
}

type Output = CommandPreview["output"];
type Path = (string | number)[];

const LABEL: Record<Output, string> = {
  apk: "Android APK",
  appbundle: "Android App Bundle",
  ipa: "iOS IPA",
  app: "iOS .app (device)",
  xcode: "Xcode project (config only)",
};

// A start for an output the app has no command for; edited from there.
const STARTER: Record<Output, string> = {
  apk: "{flutter} build apk --{mode} {flavorArgs} {targetArgs} {envDefines} {options} {version} --no-pub",
  appbundle: "{flutter} build appbundle --{mode} {flavorArgs} {targetArgs} {envDefines} {options} {version} --no-pub",
  ipa: "{flutter} build ipa --{mode} {flavorArgs} {targetArgs} {envDefines} {options} --export-method={exportMethod} {version} --no-pub",
  app: "{flutter} build ios --{mode} {flavorArgs} {targetArgs} {envDefines} {options} {version} --no-pub",
  xcode: "{flutter} build ios --config-only --{mode} {flavorArgs} {targetArgs} {envDefines} {options} {version} --no-pub",
};

/**
 * One environment's build commands: the exact line each output runs, from the
 * shared command or its own. Making one its own copies the shared line into
 * this environment's `commands`, where it can be edited.
 */
export function EnvCommands({ name, env, at, edit, preview }: { name: string; env: Obj; at: Path; edit: (path: Path, value: unknown) => void; preview: CommandsPreview }) {
  const rows = preview.list?.filter((p) => p.environment === name) ?? [];
  const used = rows.filter((r) => r.template);
  const missing = rows.filter((r) => !r.template);
  const ownCount = used.filter((r) => r.own).length;
  const path = (r: CommandPreview) => [...at, "commands", r.platform, r.output];

  return (
    <details className="group rounded-md border bg-muted/30">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm select-none [&::-webkit-details-marker]:hidden">
        <span className="font-medium">Build commands</span>
        <span className="text-muted-foreground">
          {" "}
          · {used.length} output{used.length === 1 ? "" : "s"}
          {ownCount > 0 && `, ${ownCount} its own`}
        </span>
        <span className="float-right text-xs text-muted-foreground group-open:hidden">Show</span>
        <span className="float-right hidden text-xs text-muted-foreground group-open:inline">Hide</span>
      </summary>
      <div className="space-y-4 border-t px-3 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>As a</span>
          <Select value={preview.mode} onValueChange={(v) => preview.setMode(v as BuildMode)}>
            <SelectTrigger size="sm" className="h-7 w-auto text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="debug">debug</SelectItem>
              <SelectItem value="profile">profile</SelectItem>
              <SelectItem value="release">release</SelectItem>
            </SelectContent>
          </Select>
          <span>
            build runs them. <code className="font-mono">{"{options}"}</code>, <code className="font-mono">{"{version}"}</code> and{" "}
            <code className="font-mono">{"{exportMethod}"}</code> come from the build form.
          </span>
        </div>

        {!preview.list && !preview.error && <p className="text-xs text-muted-foreground">Working out the commands…</p>}

        {used.map((r) => (
          <div key={`${r.platform}-${r.output}`} className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-xs font-medium">
                {LABEL[r.output]}
                <Badge variant={r.own ? "default" : "secondary"} className="text-[10px]">
                  {r.own ? "its own" : "shared"}
                </Badge>
              </p>
              {r.own ? (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => edit(path(r), undefined)}>
                  <HugeiconsIcon icon={ArrowTurnBackwardIcon} className="size-3.5" />
                  {r.shared ? "Back to shared" : "Remove"}
                </Button>
              ) : (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => edit(path(r), r.template)}>
                  <HugeiconsIcon icon={Edit02Icon} className="size-3.5" />
                  Use its own command
                </Button>
              )}
            </div>
            {r.own && (
              <Textarea
                value={typeof getIn(env, ["commands", r.platform, r.output]) === "string" ? (getIn(env, ["commands", r.platform, r.output]) as string) : ""}
                onChange={(e) => edit(path(r), e.target.value)}
                className="min-h-16 font-mono text-[11px] leading-relaxed md:text-[11px]"
                spellCheck={false}
                aria-label={`${name} ${LABEL[r.output]} command`}
              />
            )}
            <CommandLine text={r.argv?.join(" ") ?? ""} />
          </div>
        ))}

        {missing.length > 0 && (
          <Select value="" onValueChange={(v) => { const r = missing.find((m) => m.output === v); if (r) edit(path(r), STARTER[r.output]); }}>
            <SelectTrigger size="sm" className="h-8 w-auto text-xs">
              <HugeiconsIcon icon={Add01Icon} className="size-3.5" />
              <SelectValue placeholder="Add a command for…" />
            </SelectTrigger>
            <SelectContent>
              {missing.map((r) => (
                <SelectItem key={r.output} value={r.output}>
                  {LABEL[r.output]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </details>
  );
}
