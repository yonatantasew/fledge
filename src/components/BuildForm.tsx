import {
  Alert02Icon,
  AndroidIcon,
  AppleIcon,
  ArrowDown01Icon,
  InformationCircleIcon,
  Layers01Icon,
  PlayIcon,
  RocketIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, versionsApi, type BuildOptions, type Checkout, type DeployWhat, type Flavor, type Mode, type NextVersion, type PlanResult, type Platform, type VersionsInfo } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useFlavorLabel, useProject } from "@/project";
import { DeployDialog } from "./DeployDialog";
import { VersionsDialog } from "./VersionsDialog";

const MODE_LABEL: Record<Mode, string> = { debug: "Debug", profile: "Profile", release: "Release" };
export const PLATFORM_ICON: Record<Platform, IconSvgElement> = { android: AndroidIcon, ios: AppleIcon };


interface FormState {
  platforms: Platform[];
  flavors: Flavor[];
  modes: Mode[];
  options: BuildOptions;
  autoVersion?: boolean; // unset: the app config's versions.autoIncrement
  writePubspec?: boolean; // unset: versions.writePubspec
}

const DEFAULTS: FormState = {
  platforms: ["android", "ios"],
  flavors: [],
  modes: ["release"],
  options: {
    androidArtifact: "apk",
    iosArtifact: "ipa",
    exportMethod: "app-store",
    splitDebugInfo: true,
    obfuscate: false,
    toggles: [],
    arm64Only: false,
    buildName: "",
    buildNumber: "",
  },
};

// Remembered per app: each one has its own flavors and switches.
const storageKey = (project: string) => `fledge:form:${project}`;

function loadForm(project: string): FormState {
  try {
    const raw = localStorage.getItem(storageKey(project));
    if (raw) {
      const saved = JSON.parse(raw) as Partial<FormState>;
      // Version overrides are per-release; never carry them over silently.
      return { ...DEFAULTS, ...saved, options: { ...DEFAULTS.options, ...saved.options, buildName: "", buildNumber: "" } };
    }
  } catch {}
  return DEFAULTS;
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

function OptionRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", disabled && "opacity-50")}>
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

export function BuildForm({ projectId, checkout }: { projectId: string; checkout: Checkout | undefined }) {
  const [form, setForm] = useState<FormState>(() => loadForm(projectId));
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmProd, setConfirmProd] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<DeployWhat | null>(null);

  const project = useProject();
  const flavorLabel = useFlavorLabel();
  const { platforms, modes, options } = form;
  // Saved selections may name flavors (or toggles) this app's fledge.json doesn't have.
  // Memoized: a new array each render would make the request below new each
  // render, which re-plans in a loop and resets the Prod confirmation the moment
  // it's set.
  const flavors = useMemo(() => form.flavors.filter((f) => project.flavors.some((p) => p.name === f)), [form.flavors, project.flavors]);
  const toggleIds = useMemo(() => options.toggles.filter((id) => project.toggles.some((t) => t.id === id)), [options.toggles, project.toggles]);
  useEffect(() => {
    if (project.flavors.length && !form.flavors.some((f) => project.flavors.some((p) => p.name === f))) {
      setForm((f) => ({ ...f, flavors: [project.flavors[0].name] }));
    }
  }, [project.flavors, form.flavors]);
  const setOptions = (patch: Partial<BuildOptions>) => setForm((f) => ({ ...f, options: { ...f.options, ...patch } }));

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(projectId), JSON.stringify(form));
    } catch {}
  }, [form, projectId]);

  const targets = useMemo(
    () => platforms.flatMap((platform) => flavors.flatMap((flavor) => modes.map((mode) => ({ platform, flavor, mode })))),
    [platforms, flavors, modes],
  );

  // Versions: what's next and what was built, for the fields and the history.
  const [versions, setVersions] = useState<VersionsInfo | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const loadVersions = () => checkout && void versionsApi.get(projectId, checkout.path).then(setVersions, () => setVersions(null));
  useEffect(() => void loadVersions(), [projectId, checkout?.path]);
  const autoVersion = form.autoVersion ?? versions?.settings.autoIncrement ?? false;
  const writePubspec = form.writePubspec ?? versions?.settings.writePubspec ?? false;
  // Fill in the next version once per suggestion; clearing the fields (pubspec's) sticks until the next one.
  const filled = useRef<string | null>(null);
  useEffect(() => {
    if (!versions || autoVersion || filled.current === versions.next.version) return;
    filled.current = versions.next.version;
    setOptions({ buildName: versions.next.name, buildNumber: versions.next.number });
  }, [versions, autoVersion]);
  // Prod (the environments that ask for confirmation) has its own version: usually another app ID.
  const isProd = (f: string) => !!project.flavors.find((p) => p.name === f)?.confirm;
  const prodPicked = flavors.some(isProd);
  const mainPicked = flavors.some((f) => !isProd(f));
  const [prodVersion, setProdVersion] = useState({ buildName: "", buildNumber: "" });
  const filledProd = useRef<string | null>(null);
  useEffect(() => {
    const n = versions?.nextProd;
    if (!n || autoVersion || filledProd.current === n.version) return;
    filledProd.current = n.version;
    setProdVersion({ buildName: n.name, buildNumber: n.number });
  }, [versions, autoVersion]);
  const prodLabel = project.flavors.filter((f) => f.confirm).map((f) => f.label).join(", ") || "Prod";
  const mainLabel = flavors.filter((f) => !isProd(f)).map(flavorLabel).join(", ");

  const request = useMemo(
    () =>
      checkout && targets.length
        ? {
            project: projectId,
            checkout: checkout.path,
            targets,
            options: { ...options, toggles: toggleIds },
            autoVersion,
            writePubspec,
            ...(prodPicked ? { prodVersion } : {}),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, checkout, targets, options, toggleIds.join(","), autoVersion, writePubspec, prodPicked, prodVersion],
  );

  useEffect(() => {
    setConfirmProd(false);
    if (!request) return setPlan(null);
    const t = setTimeout(() => {
      api
        .plan(request)
        .then((p) => {
          if (p.error) {
            setPlan(null);
            setPlanError(p.error);
          } else {
            setPlan(p);
            setPlanError(null);
          }
        })
        .catch((e) => setPlanError(String(e.message ?? e)));
    }, 150);
    return () => clearTimeout(t);
  }, [request]);

  const count = plan?.builds.length ?? 0;
  const confirmFlavors = flavors.filter((f) => project.flavors.find((p) => p.name === f)?.confirm);
  const includesProd = confirmFlavors.length > 0 && count > 0;
  const confirmNames = confirmFlavors.map(flavorLabel).join(", ");

  async function submit() {
    if (!request) return;
    if (includesProd && !confirmProd) return setConfirmProd(true);
    setSubmitting(true);
    setMessage(null);
    try {
      const r = await api.queue(request);
      setMessage(`Queued ${r.queued} build${r.queued === 1 ? "" : "s"} as ${r.version}${r.pubspecCommit ? `, committed to pubspec (${r.pubspecCommit.slice(0, 8)})` : ""}.`);
      setConfirmProd(false);
      loadVersions(); // the next one moves on
    } catch (e) {
      setMessage(`Could not queue: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  const iosOn = platforms.includes("ios");
  const androidOn = platforms.includes("android");
  const onlyDebug = modes.length > 0 && modes.every((m) => m === "debug");

  return (
    <Card className="gap-5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HugeiconsIcon icon={Layers01Icon} className="size-5" />
          New builds
        </CardTitle>
        <CardDescription>Every combination you pick is queued and built one after another.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <Section title="Platform">
          <ToggleGroup
            type="multiple"
            variant="outline"
            className="w-full"
            value={platforms}
            onValueChange={(v) => setForm((f) => ({ ...f, platforms: v as Platform[] }))}
          >
            {(["android", "ios"] as const).map((p) => (
              <ToggleGroupItem key={p} value={p} className="flex-1 gap-2">
                <HugeiconsIcon icon={PLATFORM_ICON[p]} className="size-4" />
                {p === "android" ? "Android" : "iOS"}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Section>

        <Section title="Environment">
          <ToggleGroup
            type="multiple"
            variant="outline"
            className="w-full"
            value={flavors}
            onValueChange={(v) => setForm((f) => ({ ...f, flavors: v as Flavor[] }))}
          >
            {project.flavors.map((fl) => (
              <ToggleGroupItem key={fl.name} value={fl.name} className="flex-1">
                {fl.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Section>

        <Section title="Build type">
          <ToggleGroup
            type="multiple"
            variant="outline"
            className="w-full"
            value={modes}
            onValueChange={(v) => setForm((f) => ({ ...f, modes: v as Mode[] }))}
          >
            {(["debug", "profile", "release"] as const).map((m) => (
              <ToggleGroupItem key={m} value={m} className="flex-1">
                {MODE_LABEL[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Section>

        <Separator />

        {androidOn && (
          <Section title="Android output">
            <ToggleGroup
              type="single"
              variant="outline"
              className="w-full"
              value={options.androidArtifact}
              onValueChange={(v) => v && setOptions({ androidArtifact: v as BuildOptions["androidArtifact"] })}
            >
              <ToggleGroupItem value="apk" className="flex-1">
                APK
              </ToggleGroupItem>
              <ToggleGroupItem value="appbundle" className="flex-1">
                App Bundle (.aab)
              </ToggleGroupItem>
            </ToggleGroup>
          </Section>
        )}

        {iosOn && (
          <Section
            title="iOS output"
            hint="IPA: archives and exports with the chosen method, and keeps the .xcarchive so you can Distribute from Organizer. .app: a device build to install with devicectl (the only choice for debug). Prepare Xcode: builds nothing — writes this flavor's config, then quits and reopens Xcode on the right scheme for archiving by hand."
          >
            <ToggleGroup
              type="single"
              variant="outline"
              className="w-full"
              value={options.iosArtifact}
              onValueChange={(v) => v && setOptions({ iosArtifact: v as BuildOptions["iosArtifact"] })}
            >
              {/* Tighter on a phone, where "Prepare Xcode" is wider than a third of the card. */}
              <ToggleGroupItem value="ipa" className="flex-1 max-sm:px-1 max-sm:text-[13px]">
                IPA
              </ToggleGroupItem>
              <ToggleGroupItem value="app" className="flex-1 max-sm:px-1 max-sm:text-[13px]">
                .app (device)
              </ToggleGroupItem>
              <ToggleGroupItem value="xcode" className="flex-1 max-sm:px-1 max-sm:text-[13px]">
                Prepare Xcode
              </ToggleGroupItem>
            </ToggleGroup>
            {options.iosArtifact === "xcode" && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <HugeiconsIcon icon={InformationCircleIcon} className="mt-px size-3.5 shrink-0" />
                Quits Xcode (it asks about unsaved changes) and reopens the workspace on the flavor's scheme. Pick one
                environment — the last one prepared wins.
              </p>
            )}
            {options.iosArtifact === "ipa" && (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                className="w-full"
                value={options.exportMethod}
                onValueChange={(v) => v && setOptions({ exportMethod: v as BuildOptions["exportMethod"] })}
              >
                <ToggleGroupItem value="app-store" className="flex-1 text-xs">
                  App Store
                </ToggleGroupItem>
                <ToggleGroupItem value="ad-hoc" className="flex-1 text-xs">
                  Ad hoc
                </ToggleGroupItem>
                <ToggleGroupItem value="development" className="flex-1 text-xs">
                  Development
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </Section>
        )}

        <Section title="Options">
          <div className="space-y-3">
            <OptionRow
              id="split"
              label="Split debug info"
              hint="Keeps Dart symbols out of the binary and archives them with the build, as CI does."
              checked={options.splitDebugInfo}
              disabled={onlyDebug}
              onChange={(v) => setOptions({ splitDebugInfo: v, obfuscate: v ? options.obfuscate : false })}
            />
            <OptionRow
              id="obfuscate"
              label="Obfuscate"
              hint="Renames Dart symbols. Needs split debug info to symbolicate crashes."
              checked={options.obfuscate}
              disabled={!options.splitDebugInfo || onlyDebug}
              onChange={(v) => setOptions({ obfuscate: v })}
            />
            {androidOn && (
              <div className="space-y-2">
                <OptionRow
                  id="arm64"
                  label="Android: 64-bit ARM phones only"
                  hint="Faster profile and release builds for testing on your own phone. Off by default."
                  checked={options.arm64Only}
                  onChange={(v) => setOptions({ arm64Only: v })}
                />
                {options.arm64Only && (
                  <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs leading-relaxed">
                    <p>
                      Compiles the Dart code once, for 64-bit ARM, instead of three times (one per CPU type). Profile
                      and release builds finish noticeably faster; debug builds barely change.
                    </p>
                    <p className="font-medium text-warning">What you give up:</p>
                    <ul className="list-disc space-y-1 pl-4">
                      <li>
                        Phones that run 32-bit Android can't use it. That includes many low-end and Android Go phones,
                        even ones with 64-bit chips. Plugin code for them stays in the APK, so such a phone would
                        install it and then crash on launch.
                      </li>
                      <li>It isn't the build users get. Don't send it to testers or upload it anywhere.</li>
                      <li>The APK is only about 37 MB smaller; most of its size is plugin code.</li>
                    </ul>
                    <p className="text-muted-foreground">
                      The file is named <span className="font-mono">…-arm64.apk</span>, and Install refuses phones that
                      don't support 64-bit ARM.
                    </p>
                  </div>
                )}
              </div>
            )}
            {project.toggles.map((t) => (
              <OptionRow
                key={t.id}
                id={`toggle-${t.id}`}
                label={t.label}
                hint={[t.hint, t.skipFlavors.length ? `Never added to ${t.skipFlavors.map(flavorLabel).join(", ")}.` : ""]
                  .filter(Boolean)
                  .join(" ")}
                checked={toggleIds.includes(t.id)}
                onChange={(v) =>
                  setOptions({ toggles: v ? [...toggleIds, t.id] : toggleIds.filter((id) => id !== t.id) })
                }
              />
            ))}
          </div>
        </Section>

        <Section title="Version" hint="The build number only ever goes up, across version names, so a newer build always installs over an older one. Empty fields: pubspec.yaml's.">
          {autoVersion ? (
            <div className="space-y-1.5">
              {(mainPicked || !prodPicked) && <NextLine label={prodPicked ? mainLabel : null} next={versions?.next} />}
              {prodPicked && versions?.nextProd && <NextLine label={prodLabel} next={versions.nextProd} />}
            </div>
          ) : (
            <>
              {(mainPicked || !prodPicked) && (
                <VersionRow
                  label={prodPicked ? mainLabel : null}
                  value={{ buildName: options.buildName, buildNumber: options.buildNumber }}
                  onChange={(v) => setOptions(v)}
                  next={versions?.next}
                  pubspec={checkout?.version ?? ""}
                />
              )}
              {prodPicked && versions?.nextProd && (
                <VersionRow label={prodLabel} value={prodVersion} onChange={setProdVersion} next={versions.nextProd} pubspec={checkout?.version ?? ""} />
              )}
            </>
          )}
          <OptionRow
            id="auto-version"
            label="Auto-increment"
            hint="Each queue or deploy takes the next version itself, so no two share a number."
            checked={autoVersion}
            onChange={(v) => setForm((f) => ({ ...f, autoVersion: v }))}
          />
          <OptionRow
            id="write-pubspec"
            label="Write it to pubspec.yaml"
            hint={`Commits pubspec.yaml alone (“Set the version to …”) on this checkout's branch before building. Local; not pushed.${prodPicked && mainPicked ? ` pubspec holds one: ${mainLabel}'s.` : ""}`}
            checked={writePubspec}
            disabled={!autoVersion && !options.buildName && !options.buildNumber}
            onChange={(v) => setForm((f) => ({ ...f, writePubspec: v }))}
          />
          <Button variant="link" size="sm" className="h-auto justify-start px-0 text-xs" onClick={() => setShowVersions(true)}>
            Versions built so far…
          </Button>
          <VersionsDialog open={showVersions} onOpenChange={setShowVersions} info={versions} />
        </Section>

        <Separator />

        <PlanPreview plan={plan} error={planError} />
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-2">
        {includesProd && (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <HugeiconsIcon icon={Alert02Icon} className="size-3.5" />
            Includes {confirmNames} builds{confirmProd ? " — click again to confirm." : "."}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            size="lg"
            className="flex-1"
            disabled={!count || submitting || !checkout}
            variant={confirmProd ? "destructive" : "default"}
            onClick={submit}
          >
            <HugeiconsIcon icon={PlayIcon} className="size-4" />
            {confirmProd ? `Yes, queue ${count} incl. ${confirmNames}` : `Queue ${count} build${count === 1 ? "" : "s"}`}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="lg" variant="outline" disabled={!checkout} aria-label="Deploy">
                <HugeiconsIcon icon={RocketIcon} className="size-4" />
                Deploy
                <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Build, then post the notes and files</DropdownMenuLabel>
              {project.deployRoutes.map((r) => (
                <DropdownMenuItem key={r.id} onSelect={() => setDeploying({ project: projectId, checkout: checkout?.path, route: r.id, autoVersion, writePubspec })}>
                  <div className="min-w-0">
                    <div className="font-medium">{r.label}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {r.builds.map((b) => `${flavorLabel(b.environment)} ${b.mode} ${b.platform === "ios" ? "iOS" : "Android"}`).join(", ")} → {r.channel}
                    </div>
                  </div>
                </DropdownMenuItem>
              ))}
              {project.deployRoutes.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No routes yet: add them under "deploy" in this app's config.</p>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!request || !count} onSelect={() => request && setDeploying({ project: projectId, checkout: request.checkout, targets: request.targets, options: request.options, channel: "", autoVersion, writePubspec })}>
                Deploy what's selected ({count} build{count === 1 ? "" : "s"})…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DeployDialog
          open={!!deploying}
          onOpenChange={(o) => !o && setDeploying(null)}
          what={deploying}
          onStarted={() => (setMessage("Deploying: it posts once every build is done."), loadVersions())}
        />
        {message && <p className="text-center text-xs text-muted-foreground">{message}</p>}
      </CardFooter>
    </Card>
  );
}


/** "Next: 1.3.1+57", what it follows, for auto-increment. */
function NextLine({ label, next }: { label: string | null; next: NextVersion | undefined }) {
  return (
    <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
      {label && <span className="mr-1.5 text-xs font-medium text-muted-foreground">{label}</span>}
      Next: <span className="font-mono font-medium">{next?.version ?? "…"}</span>
      <span className="block text-xs text-muted-foreground">Taken when you queue{next?.after ? `, after ${next.after.version} (${next.after.label})` : ""}.</span>
    </p>
  );
}

/** One track's version fields, filled with its next version, saying where the value comes from. */
function VersionRow({
  label,
  value,
  onChange,
  next,
  pubspec,
}: {
  label: string | null;
  value: { buildName: string; buildNumber: string };
  onChange: (v: { buildName: string; buildNumber: string }) => void;
  next: NextVersion | undefined;
  pubspec: string;
}) {
  const current = `${value.buildName}+${value.buildNumber}`;
  return (
    <div className="space-y-1">
      {label && <p className="text-xs font-medium text-muted-foreground">{label}</p>}
      <div className="grid grid-cols-[1fr_7rem] gap-2">
        <Input
          placeholder={pubspec.split("+")[0] || "1.3.1"}
          value={value.buildName}
          onChange={(e) => onChange({ ...value, buildName: e.target.value })}
          aria-label={label ? `${label} build name` : "Build name"}
          className="font-mono"
        />
        <Input
          placeholder={`+${pubspec.split("+")[1] ?? ""}`}
          value={value.buildNumber}
          onChange={(e) => onChange({ ...value, buildNumber: e.target.value.replace(/^\+/, "") })}
          aria-label={label ? `${label} build number` : "Build number"}
          className="font-mono"
          inputMode="numeric"
        />
      </div>
      {next && (
        <p className="text-xs text-muted-foreground">
          {current === next.version
            ? `The next version${next.after ? `, after ${next.after.version} (${next.after.label})` : ""}.`
            : !value.buildName && !value.buildNumber
              ? `pubspec's, ${pubspec}.`
              : `Typed in; the next would be ${next.version}.`}{" "}
          {current !== next.version && (
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onChange({ buildName: next.name, buildNumber: next.number })}>
              Use {next.version}
            </button>
          )}{" "}
          {(value.buildName || value.buildNumber) && (
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onChange({ buildName: "", buildNumber: "" })}>
              Use pubspec's
            </button>
          )}
        </p>
      )}
    </div>
  );
}

function PlanPreview({ plan, error }: { plan: PlanResult | null; error: string | null }) {
  const flavorLabel = useFlavorLabel();
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!plan || (!plan.builds.length && !plan.skipped.length))
    return <p className="text-sm text-muted-foreground">Pick at least one platform, environment and build type.</p>;

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Plan · {plan.builds.length} build{plan.builds.length === 1 ? "" : "s"}
      </Label>
      <ul className="space-y-1">
        {plan.builds.map((b, i) => (
          <li key={i} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted">
            <HugeiconsIcon icon={PLATFORM_ICON[b.platform]} className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">{flavorLabel(b.flavor)}</span>
            <span className="text-muted-foreground">{MODE_LABEL[b.mode]}</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {b.artifact}
            </Badge>
            {b.notes.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <HugeiconsIcon icon={InformationCircleIcon} className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-64">{b.notes.join(" · ")}</TooltipContent>
              </Tooltip>
            )}
          </li>
        ))}
        {plan.skipped.map((s, i) => (
          <li key={`s${i}`} className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground line-through">
            <HugeiconsIcon icon={PLATFORM_ICON[s.platform]} className="size-4 shrink-0" />
            {flavorLabel(s.flavor)} {MODE_LABEL[s.mode]}
            <span className="ml-auto text-xs no-underline">{s.reason.split(" — ")[0]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { MODE_LABEL };
