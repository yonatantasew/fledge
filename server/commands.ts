// Turns a build selection from the UI into the exact `fvm flutter build` argv.
//
// Everything the server executes is assembled here from closed enums, values
// checked against the app's fledge.json (flavors, toggles) and two regex-checked
// strings — nothing from the request reaches a shell, and argv is passed to
// spawn() without one. Kept pure so the flag rules are unit-tested.

import { fill, type FledgeConfig } from "./config.ts";

export const PLATFORMS = ["android", "ios"] as const;
export const ARM64_ONLY_FLAG = "android-arm64";
export const MODES = ["debug", "profile", "release"] as const;
export const ANDROID_ARTIFACTS = ["apk", "appbundle"] as const;
// "xcode" builds nothing: it writes the flavor's Generated.xcconfig and
// restarts Xcode on the workspace, for archiving by hand in Xcode.
export const IOS_ARTIFACTS = ["ipa", "app", "xcode"] as const;
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
  artifact: AndroidArtifact | IosArtifact;
  argv: string[];
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
export function planBuild(
  t: Target,
  o: BuildOptions,
  gitSha: string,
  cfg: FledgeConfig,
): { build: PlannedBuild } | { skipped: SkippedBuild } {
  const artifact = t.platform === "android" ? o.androidArtifact : o.iosArtifact;
  const notes: string[] = [];

  // `flutter build ipa` has no debug archive: Xcode cannot export one.
  if (t.platform === "ios" && artifact === "ipa" && t.mode === "debug") {
    return { skipped: { ...t, reason: "an IPA can't be exported from a debug build — choose .app for debug" } };
  }

  const sub = t.platform === "android" ? artifact : artifact === "ipa" ? "ipa" : "ios";
  const configOnly = artifact === "xcode";
  const argv = [
    "flutter",
    "build",
    sub,
    `--${t.mode}`,
    "--flavor",
    t.flavor,
    // --flavor picks the native flavor; apps that read the flavor in Dart need
    // it as a define too, and the two must never disagree. Always pass both.
    ...(cfg.flavorDefine ? [`--dart-define=${cfg.flavorDefine}=${t.flavor}`] : []),
    ...(cfg.gitShaDefine ? [`--dart-define=${cfg.gitShaDefine}=${gitSha}`] : []),
    ...Object.entries(cfg.defines).map(([k, v]) => `--dart-define=${k}=${v}`),
  ];
  if (configOnly) argv.splice(3, 0, "--config-only");

  let symbolsDir: string | null = null;
  if (configOnly) {
    // Nothing is compiled, so there are no symbols; Xcode's archive makes them.
  } else if (o.splitDebugInfo && t.mode !== "debug") {
    symbolsDir = fill(cfg.symbolsDir, { flavor: t.flavor, platform: t.platform });
    argv.push(`--split-debug-info=${symbolsDir}`);
    if (o.obfuscate) argv.push("--obfuscate");
  } else if (o.splitDebugInfo) {
    notes.push("split debug info skipped: debug builds keep their symbols");
  }

  for (const toggle of cfg.toggles) {
    if (!o.toggles.includes(toggle.id)) continue;
    if (toggle.skipFlavors.includes(t.flavor)) notes.push(`${toggle.label} skipped: not used for ${t.flavor}`);
    else argv.push(`--dart-define=${toggle.define}`);
  }

  if (o.arm64Only && t.platform === "android") {
    // Only Flutter's own libraries are filtered: plugin native code for the
    // other ABIs stays in the APK, so a 32-bit-only phone would install it and
    // crash on launch. fledge's Install refuses such phones for this build.
    argv.push("--target-platform", "android-arm64");
    if (t.mode === "debug") notes.push("arm64 only barely helps debug builds: Dart isn't ahead-of-time compiled in debug");
  }

  if (sub === "ipa") argv.push(`--export-method=${o.exportMethod}`);
  if (o.buildName) argv.push(`--build-name=${o.buildName}`);
  if (o.buildNumber) argv.push(`--build-number=${o.buildNumber}`);

  return { build: { ...t, artifact, argv, symbolsDir, notes } };
}

/** Where `flutter build` leaves the artifact, relative to the checkout. */
export const XCARCHIVE_PATH = "build/ios/archive/Runner.xcarchive"; // written by `flutter build ipa` (3.24)

export function artifactPath(b: Pick<PlannedBuild, "platform" | "flavor" | "mode" | "artifact">): string {
  const Mode = b.mode[0].toUpperCase() + b.mode.slice(1);
  switch (b.artifact) {
    case "apk":
      return `build/app/outputs/flutter-apk/app-${b.flavor}-${b.mode}.apk`;
    case "appbundle":
      return `build/app/outputs/bundle/${b.flavor}${Mode}/app-${b.flavor}-${b.mode}.aab`;
    case "ipa":
      return "build/ios/ipa"; // a directory; the server picks the .ipa inside
    case "app":
      return "build/ios/iphoneos/Runner.app";
    case "xcode":
      return "ios/Flutter/Generated.xcconfig";
  }
}
