// Turns a build selection from the UI into the exact command line to run: the
// app's command template for that output (templates.ts), filled in with the
// environment, build type and the options ticked in the form.
//
// Request values are closed enums, names checked against the config, and two
// regex-checked strings; the result is passed to spawn() as argv, never to a
// shell. Kept pure so the rules are unit-tested.

import { fill, type FlavorConfig, type FledgeConfig } from "./config.ts";
import { expand, generateCommands, type Output } from "./templates.ts";

export const PLATFORMS = ["android", "ios"] as const;
export const ARM64_ONLY_FLAG = "android-arm64";
export const MODES = ["debug", "profile", "release"] as const;
export const ANDROID_ARTIFACTS = ["apk", "appbundle"] as const;
// "xcode" builds nothing: it writes the flavor's Generated.xcconfig and
// restarts Xcode on the workspace, for archiving by hand in Xcode.
// "simulator" is the app for the iOS simulator, zipped so it can be shipped;
// Flutter only builds the simulator in debug.
export const IOS_ARTIFACTS = ["ipa", "app", "simulator", "xcode"] as const;
export const EXPORT_METHODS = ["app-store", "ad-hoc", "development"] as const;

export type Platform = (typeof PLATFORMS)[number];
export type Flavor = string; // one of fledge.json's flavors
export type Mode = (typeof MODES)[number];
export type AndroidArtifact = (typeof ANDROID_ARTIFACTS)[number];
export type IosArtifact = (typeof IOS_ARTIFACTS)[number];
export type ExportMethod = (typeof EXPORT_METHODS)[number];

export interface BuildOptions {
  androidArtifact: AndroidArtifact;
  iosArtifact: IosArtifact;
  exportMethod: ExportMethod;
  splitDebugInfo: boolean;
  obfuscate: boolean;
  toggles: string[]; // ids of fledge.json toggles to switch on
  // Android only: compile Dart for 64-bit ARM alone (`--target-platform android-arm64`).
  arm64Only: boolean;
  buildName: string;
  buildNumber: string;
}

export interface Target {
  platform: Platform;
  flavor: Flavor;
  mode: Mode;
}

export interface PlannedBuild extends Target {
  nativeFlavor: string | null; // the --flavor actually passed (null: none)
  artifact: AndroidArtifact | IosArtifact;
  argv: string[]; // the complete command line, executable first
  symbolsDir: string | null;
  notes: string[];
}

export interface SkippedBuild extends Target {
  reason: string;
}

const BUILD_NAME = /^\d+\.\d+\.\d+$/;
const BUILD_NUMBER = /^\d{1,9}$/;

function oneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}

/** Parses the request body; returns an error string instead of throwing. */
export function parseRequest(
  body: unknown,
  cfg: FledgeConfig,
): { targets: Target[]; options: BuildOptions } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.targets) || b.targets.length === 0) return { error: "targets must be a non-empty array" };
  if (b.targets.length > 18) return { error: "at most 18 targets per request" };

  const targets: Target[] = [];
  for (const t of b.targets as unknown[]) {
    const r = (t ?? {}) as Record<string, unknown>;
    if (!oneOf(PLATFORMS, r.platform)) return { error: `bad platform: ${String(r.platform)}` };
    if (!oneOf(cfg.flavors.map((f) => f.name), r.flavor)) return { error: `bad flavor: ${String(r.flavor)}` };
    if (!oneOf(MODES, r.mode)) return { error: `bad mode: ${String(r.mode)}` };
    targets.push({ platform: r.platform, flavor: r.flavor, mode: r.mode });
  }

  const o = (b.options ?? {}) as Record<string, unknown>;
  const options: BuildOptions = {
    androidArtifact: oneOf(ANDROID_ARTIFACTS, o.androidArtifact) ? o.androidArtifact : "apk",
    iosArtifact: oneOf(IOS_ARTIFACTS, o.iosArtifact) ? o.iosArtifact : "ipa",
    exportMethod: oneOf(EXPORT_METHODS, o.exportMethod) ? o.exportMethod : "app-store",
    splitDebugInfo: o.splitDebugInfo === true,
    obfuscate: o.obfuscate === true,
    toggles: Array.isArray(o.toggles) ? [...new Set(o.toggles as unknown[])].map(String) : [],
    arm64Only: o.arm64Only === true,
    buildName: typeof o.buildName === "string" ? o.buildName.trim() : "",
    buildNumber: typeof o.buildNumber === "string" ? o.buildNumber.trim() : "",
  };
  if (options.buildName && !BUILD_NAME.test(options.buildName)) return { error: "build name must look like 1.3.1" };
  if (options.buildNumber && !BUILD_NUMBER.test(options.buildNumber)) return { error: "build number must be digits" };
  const unknown = options.toggles.find((id) => !cfg.toggles.some((t) => t.id === id));
  if (unknown) return { error: `unknown toggle: ${unknown}` };
  if (options.obfuscate && !options.splitDebugInfo) return { error: "obfuscate needs split debug info (Flutter refuses it otherwise)" };
  return { targets, options };
}

/**
 * Plans one target. `gitSha` is the checkout's HEAD, passed as the configured
 * git-sha define so a local build can be told apart from a CI one.
 */
/** The command line `env` builds `output` with: its own if it has one, else the shared one. */
export function templateFor(cfg: FledgeConfig, env: FlavorConfig, platform: Platform, output: Output): { template: string; own: boolean } | null {
  const own = (env.commands[platform] as Record<string, string | undefined>)[output];
  if (own) return { template: own, own: true };
  const shared = ((cfg.commands ?? generateCommands(cfg))[platform] as Record<string, string | undefined>)[output];
  return shared ? { template: shared, own: false } : null;
}

export function planBuild(
  t: Target,
  o: BuildOptions,
  gitSha: string,
  cfg: FledgeConfig,
  flutter: string[] = ["flutter"],
): { build: PlannedBuild } | { skipped: SkippedBuild } {
  const artifact = t.platform === "android" ? o.androidArtifact : o.iosArtifact;
  const notes: string[] = [];
  const env = cfg.flavors.find((f) => f.name === t.flavor);
  if (!env) return { skipped: { ...t, reason: `no environment "${t.flavor}" in the config` } };

  // `flutter build ipa` has no debug archive: Xcode cannot export one.
  if (t.platform === "ios" && artifact === "ipa" && t.mode === "debug") {
    return { skipped: { ...t, reason: "an IPA can't be exported from a debug build — choose .app for a device or Simulator for the iOS simulator" } };
  }
  if (t.platform === "ios" && artifact === "simulator" && t.mode !== "debug") {
    return { skipped: { ...t, reason: `Flutter only builds the iOS simulator in debug, not ${t.mode} — choose Debug` } };
  }

  const template = templateFor(cfg, env, t.platform, artifact)?.template;
  if (!template) return { skipped: { ...t, reason: `the config has no commands.${t.platform}.${artifact}, for all environments or for ${t.flavor}` } };

  // {options}: the switches ticked in the form.
  const options: string[] = [];
  let symbolsDir: string | null = null;
  if (artifact === "xcode") {
    // Nothing is compiled, so there are no symbols; Xcode's archive makes them.
  } else if (o.splitDebugInfo && t.mode !== "debug") {
    symbolsDir = fill(cfg.symbolsDir, { flavor: t.flavor, platform: t.platform });
    options.push(`--split-debug-info=${symbolsDir}`);
    if (o.obfuscate) options.push("--obfuscate");
  } else if (o.splitDebugInfo) {
    notes.push("split debug info skipped: debug builds keep their symbols");
  }
  for (const toggle of cfg.toggles) {
    if (!o.toggles.includes(toggle.id)) continue;
    if (toggle.skipFlavors.includes(t.flavor)) notes.push(`${toggle.label} skipped: not used for ${t.flavor}`);
    else options.push(`--dart-define=${toggle.define}`);
  }
  if (o.arm64Only && t.platform === "android") {
    // Only Flutter's own libraries are filtered: plugin native code for the
    // other ABIs stays in the APK, so a 32-bit-only phone would install it and
    // crash on launch. fledge's Install refuses such phones for this build.
    options.push("--target-platform", "android-arm64");
    if (t.mode === "debug") notes.push("arm64 only barely helps debug builds: Dart isn't ahead-of-time compiled in debug");
  }

  // {version}: the build name/number overrides from the form.
  const version = [
    ...(o.buildName ? [`--build-name=${o.buildName}`] : []),
    ...(o.buildNumber ? [`--build-number=${o.buildNumber}`] : []),
  ];

  const argv = expand(template, { flutter, mode: t.mode, env, sha: gitSha, exportMethod: o.exportMethod, options, version });
  return { build: { ...t, nativeFlavor: env.flavor, artifact, argv, symbolsDir, notes } };
}

/** Where `flutter build` leaves the artifact, relative to the checkout. */
export const XCARCHIVE_PATH = "build/ios/archive/Runner.xcarchive"; // written by `flutter build ipa` (3.24)

export function artifactPath(b: Pick<PlannedBuild, "platform" | "nativeFlavor" | "mode" | "artifact">): string {
  const Mode = b.mode[0].toUpperCase() + b.mode.slice(1);
  const f = b.nativeFlavor;
  switch (b.artifact) {
    case "apk":
      return f ? `build/app/outputs/flutter-apk/app-${f}-${b.mode}.apk` : `build/app/outputs/flutter-apk/app-${b.mode}.apk`;
    case "appbundle":
      return f ? `build/app/outputs/bundle/${f}${Mode}/app-${f}-${b.mode}.aab` : `build/app/outputs/bundle/${b.mode}/app-${b.mode}.aab`;
    case "ipa":
      return "build/ios/ipa"; // a directory; the server picks the .ipa inside
    case "app":
      return "build/ios/iphoneos/Runner.app";
    case "simulator":
      return "build/ios/iphonesimulator/Runner.app";
    case "xcode":
      return "ios/Flutter/Generated.xcconfig";
  }
}

/**
 * The command that runs Flutter for a checkout. "auto" follows the files the
 * project carries: .fvmrc / .fvm (fvm), .puro.json (puro), else plain flutter.
 */
export function resolveFlutter(
  setting: FledgeConfig["flutter"],
  has: { fvmConfig: boolean; puroConfig: boolean },
): string[] {
  if (setting !== "auto") return setting;
  if (has.fvmConfig) return ["fvm", "flutter"];
  if (has.puroConfig) return ["puro", "flutter"];
  return ["flutter"];
}

export interface CommandPreview {
  environment: string;
  platform: Platform;
  output: Output;
  template: string | null; // what it runs; null: no command for this output, shared or own
  own: boolean;
  shared: string | null; // the shared command, used when it has no own one
  argv: string[] | null;
}

const OUTPUTS: { platform: Platform; output: Output }[] = [
  ...ANDROID_ARTIFACTS.map((output) => ({ platform: "android" as const, output })),
  ...IOS_ARTIFACTS.map((output) => ({ platform: "ios" as const, output })),
];

/**
 * Every environment's command for every output, as a `mode` build runs it.
 * What the build form decides per build ({options}, {version}, the export
 * method) is left as the placeholder.
 */
export function previewCommands(cfg: FledgeConfig, mode: Mode, gitSha: string, flutter: string[]): CommandPreview[] {
  return cfg.flavors.flatMap((env) =>
    OUTPUTS.map(({ platform, output }) => {
      const t = templateFor(cfg, env, platform, output);
      const shared = ((cfg.commands ?? generateCommands(cfg))[platform] as Record<string, string | undefined>)[output] ?? null;
      const argv = t && expand(t.template, { flutter, mode, env, sha: gitSha, exportMethod: "{exportMethod}", options: ["{options}"], version: ["{version}"] });
      return { environment: env.name, platform, output, template: t?.template ?? null, own: t?.own ?? false, shared, argv };
    }),
  );
}
