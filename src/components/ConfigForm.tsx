import { Add01Icon, Delete02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId } from "react";
import { getIn, otherKeys, removeAt, setIn, type Obj } from "@/config-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EnvCommands, type CommandsPreview } from "./EnvCommands";

type Path = (string | number)[];
type Edit = (path: Path, value: unknown) => void;

const ENV_FIELDS = ["name", "label", "flavor", "androidId", "iosId", "xcodeScheme", "confirm"] as const;
const SWITCH_FIELDS = ["id", "label", "hint", "define", "skipFlavors", "iosOutput"] as const;
const FORM_TOP = ["flutter", "flavors", "versions", "ship", "release", "toggles"] as const;
const FLUTTER = [
  { value: "auto", label: "Auto: fvm or puro if the app pins one, else flutter" },
  { value: "flutter", label: "flutter" },
  { value: "fvm", label: "fvm flutter" },
  { value: "puro", label: "puro flutter" },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** The everyday settings of an app's config as fields. Everything else stays in Advanced, untouched. */
export function ConfigForm({ value, onChange, commands }: { value: Obj; onChange: (next: Obj) => void; commands?: CommandsPreview }) {
  const edit: Edit = (path, v) => onChange(setIn(value, path, v));
  const flavors = (getIn(value, ["flavors"]) as Obj[] | undefined) ?? [];
  const toggles = (getIn(value, ["toggles"]) as Obj[] | undefined) ?? [];
  const names = flavors.map((f) => text(f.name)).filter(Boolean);

  return (
    <div className="space-y-6">
      <Section title="Flutter" hint="The command fledge runs Flutter with in each checkout.">
        <FlutterSelect value={getIn(value, ["flutter"])} onChange={(v) => edit(["flutter"], v)} />
      </Section>

      <Section title="Environments" hint="What the app is built for, such as staging and production. Each one is a row in the build form.">
        <div className="space-y-3">
          {flavors.map((f, i) => (
            <Environment key={i} env={f} at={["flavors", i]} edit={edit} commands={commands} onRemove={flavors.length > 1 ? () => onChange(removeAt(value, ["flavors"], i)) : undefined} />
          ))}
          <Button variant="outline" size="sm" onClick={() => edit(["flavors", flavors.length], { name: `env${flavors.length + 1}` })}>
            <HugeiconsIcon icon={Add01Icon} className="size-4" />
            Add environment
          </Button>
        </div>
      </Section>

      <Section title="Versions" hint="How the next version is suggested in the build form.">
        <div className="space-y-3">
          <Field label="Next version follows">
            <Select value={text(getIn(value, ["versions", "basedOn"])) || "highest"} onValueChange={(v) => edit(["versions", "basedOn"], v === "highest" ? undefined : v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="highest">The highest version seen anywhere (builds, tags, pubspec)</SelectItem>
                <SelectItem value="releases">Release tags only</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Toggle
            label="Take the next version for every build"
            hint="Turns on the build form's auto-increment switch by default."
            checked={getIn(value, ["versions", "autoIncrement"]) === true}
            onChange={(v) => edit(["versions", "autoIncrement"], v || undefined)}
          />
          <Toggle
            label="Write it to pubspec.yaml"
            hint="Also commits the version to pubspec.yaml when a build takes it."
            checked={getIn(value, ["versions", "writePubspec"]) === true}
            onChange={(v) => edit(["versions", "writePubspec"], v || undefined)}
          />
        </div>
      </Section>

      <Section title="Slack" hint="Where Ship sends a finished build. The bot token is set per Mac, not here.">
        <Field label="Channel" hint="#channel-name or a channel ID">
          <Input value={text(getIn(value, ["ship", "slack", "channel"]))} onChange={(e) => edit(["ship", "slack", "channel"], e.target.value.trim())} placeholder="#builds" className="font-mono" />
        </Field>
      </Section>

      <Section title="Releases" hint="Where releases and version bumps go, and which Jira tickets move when a release is published. Leave empty to not use releases.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="GitHub repository">
            <Input value={text(getIn(value, ["release", "github", "repo"]))} onChange={(e) => edit(["release", "github", "repo"], e.target.value.trim())} placeholder="owner/repo" className="font-mono" />
          </Field>
          <Field label="Base branch">
            <Input value={text(getIn(value, ["release", "github", "baseBranch"]))} onChange={(e) => edit(["release", "github", "baseBranch"], e.target.value.trim())} placeholder="main" className="font-mono" />
          </Field>
          <Field label="GitHub account" hint="optional">
            <Input value={text(getIn(value, ["release", "github", "account"]))} onChange={(e) => edit(["release", "github", "account"], e.target.value.trim())} placeholder="active gh account" className="font-mono" />
          </Field>
          <Field label="Notes heading">
            <Input value={text(getIn(value, ["release", "channel"]))} onChange={(e) => edit(["release", "channel"], e.target.value)} placeholder="Release" />
          </Field>
          <Field label="Ticket project key" hint="Ticket keys in PR titles, like PROJ-123">
            <Input value={text(getIn(value, ["release", "tickets", "project"]))} onChange={(e) => edit(["release", "tickets", "project"], e.target.value.trim().toUpperCase())} placeholder="PROJ" className="font-mono" />
          </Field>
          <Field label="Jira site">
            <Input value={text(getIn(value, ["release", "jira", "site"]))} onChange={(e) => edit(["release", "jira", "site"], e.target.value.trim())} placeholder="https://your-team.atlassian.net" className="font-mono" />
          </Field>
          <Field label="Move tickets from status">
            <Input value={text(getIn(value, ["release", "jira", "fromStatus"]))} onChange={(e) => edit(["release", "jira", "fromStatus"], e.target.value)} placeholder="Ready for test" />
          </Field>
          <Field label="To status">
            <Input value={text(getIn(value, ["release", "jira", "toStatus"]))} onChange={(e) => edit(["release", "jira", "toStatus"], e.target.value)} placeholder="In testing" />
          </Field>
        </div>
      </Section>

      <Section title="Build switches" hint="Checkboxes in the build form that each add a --dart-define, such as verbose logs.">
        <div className="space-y-3">
          {toggles.map((t, i) => (
            <BuildSwitch key={i} toggle={t} at={["toggles", i]} names={names} edit={edit} onRemove={() => onChange(removeAt(value, ["toggles"], i))} />
          ))}
          <Button variant="outline" size="sm" onClick={() => edit(["toggles", toggles.length], { id: "", label: "", define: "" })}>
            <HugeiconsIcon icon={Add01Icon} className="size-4" />
            Add switch
          </Button>
        </div>
      </Section>

      <AdvancedOnly value={value} />
    </div>
  );
}

function FlutterSelect({ value, onChange }: { value: unknown; onChange: (v: string | undefined) => void }) {
  const custom = Array.isArray(value) ? value.join(" ") : null;
  const current = custom ? "custom" : typeof value === "string" ? value : "auto";
  return (
    <Select value={current} onValueChange={(v) => v !== "custom" && onChange(v === "auto" ? undefined : v)}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FLUTTER.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
        {custom && (
          <SelectItem value="custom" className="font-mono">
            {custom} (set in Advanced)
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function Environment({ env, at, edit, commands, onRemove }: { env: Obj; at: Path; edit: Edit; commands?: CommandsPreview; onRemove?: () => void }) {
  const name = text(env.name);
  const noFlavor = env.flavor === null;
  const flavor = noFlavor ? "" : text(env.flavor) || name;
  const more = otherKeys(env, commands ? [...ENV_FIELDS, "commands"] : ENV_FIELDS);
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{text(env.label) || cap(name) || "New environment"}</p>
        {onRemove && (
          <Button variant="ghost" size="sm" className="-mt-1 text-destructive hover:text-destructive" onClick={onRemove}>
            <HugeiconsIcon icon={Delete02Icon} className="size-4" />
            Remove
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="lowercase id">
          <Input value={name} onChange={(e) => edit([...at, "name"], e.target.value.trim().toLowerCase())} placeholder="staging" className="font-mono" />
        </Field>
        <Field label="Label">
          <Input value={text(env.label)} onChange={(e) => edit([...at, "label"], e.target.value)} placeholder={cap(name)} />
        </Field>
        <Field label="Native flavor" hint="The --flavor value">
          <Input value={noFlavor ? "" : text(env.flavor)} onChange={(e) => edit([...at, "flavor"], e.target.value.trim())} placeholder={noFlavor ? "none" : name} disabled={noFlavor} className="font-mono" />
          <CheckRow label="Built without --flavor" checked={noFlavor} onChange={(v) => edit([...at, "flavor"], v ? null : undefined)} />
        </Field>
        <Field label="Xcode scheme">
          <Input value={text(env.xcodeScheme)} onChange={(e) => edit([...at, "xcodeScheme"], e.target.value.trim())} placeholder={flavor ? cap(flavor) : "Runner"} className="font-mono" />
        </Field>
        <Field label="Android application ID">
          <Input value={text(env.androidId)} onChange={(e) => edit([...at, "androidId"], e.target.value.trim())} placeholder="com.example.app" className="font-mono" />
        </Field>
        <Field label="iOS bundle ID">
          <Input value={text(env.iosId)} onChange={(e) => edit([...at, "iosId"], e.target.value.trim())} placeholder="com.example.app" className="font-mono" />
        </Field>
      </div>
      <Toggle
        label="Ask before building"
        hint="For production: the build form asks to confirm, and its versions get their own track."
        checked={env.confirm === true}
        onChange={(v) => edit([...at, "confirm"], v || undefined)}
      />
      {commands && <EnvCommands name={name} env={env} at={at} edit={edit} preview={commands} />}
      {more.length > 0 && <AlsoIn keys={more} />}
    </div>
  );
}

function BuildSwitch({ toggle, at, names, edit, onRemove }: { toggle: Obj; at: Path; names: string[]; edit: Edit; onRemove: () => void }) {
  const skip = (getIn(toggle, ["skipFlavors"]) as string[] | undefined) ?? [];
  const more = otherKeys(toggle, SWITCH_FIELDS);
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{text(toggle.label) || "New switch"}</p>
        <Button variant="ghost" size="sm" className="-mt-1 text-destructive hover:text-destructive" onClick={onRemove}>
          <HugeiconsIcon icon={Delete02Icon} className="size-4" />
          Remove
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">
          <Input value={text(toggle.label)} onChange={(e) => edit([...at, "label"], e.target.value)} placeholder="Verbose logs" />
        </Field>
        <Field label="Id">
          <Input value={text(toggle.id)} onChange={(e) => edit([...at, "id"], e.target.value.trim())} placeholder="verbose" className="font-mono" />
        </Field>
        <Field label="Define it adds" hint="NAME=value">
          <Input value={text(toggle.define)} onChange={(e) => edit([...at, "define"], e.target.value.trim())} placeholder="VERBOSE_LOGS=true" className="font-mono" />
        </Field>
        <Field label="Hint">
          <Input value={text(toggle.hint)} onChange={(e) => edit([...at, "hint"], e.target.value)} placeholder="Shown next to the checkbox" />
        </Field>
        <Field label="iOS output while on" hint="Replaces the form's choice; the simulator only builds debug">
          <Select value={text(toggle.iosOutput) || "form"} onValueChange={(v) => edit([...at, "iosOutput"], v === "form" ? undefined : v)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="form">The one picked in the build form</SelectItem>
              <SelectItem value="simulator">Simulator</SelectItem>
              <SelectItem value="app">.app (device)</SelectItem>
              <SelectItem value="ipa">IPA</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {names.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Never added to</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {names.map((n) => (
              <CheckRow
                key={n}
                label={n}
                checked={skip.includes(n)}
                onChange={(v) => {
                  const next = v ? [...skip, n] : skip.filter((s) => s !== n);
                  edit([...at, "skipFlavors"], next.length ? next : undefined);
                }}
              />
            ))}
          </div>
        </div>
      )}
      {more.length > 0 && <AlsoIn keys={more} />}
    </div>
  );
}

/** What this config sets that only the Advanced tab edits. */
function AdvancedOnly({ value }: { value: Obj }) {
  const items: string[] = [];
  const routes = getIn(value, ["deploy", "routes"]);
  if (Array.isArray(routes) && routes.length) items.push(`${routes.length} deploy route${routes.length > 1 ? "s" : ""}`);
  if (getIn(value, ["commands"])) items.push("the shared build commands");
  const team = getIn(value, ["release", "team"]);
  if (team && typeof team === "object" && Object.keys(team).length) items.push("team names for notes");
  if (getIn(value, ["release", "versionBump"])) items.push("the version bump branch and PR");
  if (getIn(value, ["ship", "slack", "message"])) items.push("the Slack message");
  items.push(...otherKeys(value, [...FORM_TOP, "deploy", "commands"]));
  if (!items.length) return null;
  return (
    <p className="rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">Also in this config, edited in Advanced:</span> {items.join(", ")}.
    </p>
  );
}

function AlsoIn({ keys }: { keys: string[] }) {
  return (
    <p className="text-xs text-muted-foreground">
      Also set in Advanced: <span className="font-mono">{keys.join(", ")}</span>
    </p>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</Label>
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <HugeiconsIcon icon={InformationCircleIcon} className="size-3.5 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{hint}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-xs">
        {label}
        {hint && <span className="font-normal text-muted-foreground"> · {hint}</span>}
      </Label>
      {children}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <Label htmlFor={id} className="block space-y-0.5 font-normal">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </Label>
    </div>
  );
}

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
    </div>
  );
}
