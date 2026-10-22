// The app's fledge.json: everything fledge knows about one Flutter project.
//
// It lives in the app's repository, so it is versioned with the app. Values
// from it end up on build command lines, so every field is checked here, once,
// at startup — a typo fails loudly instead of building the wrong flavor.

import path from "node:path";

/**
 * One environment the app is built for. Usually a native flavor (`flavor`,
 * which defaults to `name`), but apps without flavors set `flavor: null` and
 * tell environments apart by entry file (`target`) and/or defines.
 */
export interface FlavorConfig {
  name: string; // fledge's id for it; also the {flavor} in symbolsDir and the value of flavorDefine
  flavor: string | null; // --flavor value, or null to build without one
  target?: string; // -t entry file, e.g. lib/main_staging.dart
  defines: Record<string, string>; // --dart-define for this environment only
  defineFiles: string[]; // --dart-define-from-file for this environment only
  vars: Record<string, string>; // this environment's values for {NAME} placeholders in commands
  label: string;
  androidId?: string; // applicationId, used when it can't be read back from the APK
  iosId?: string; // bundle identifier
  xcodeScheme: string; // for "Prepare Xcode"
  confirm: boolean; // ask twice before building it (e.g. production)
}

export interface ToggleConfig {
  id: string;
  label: string;
  hint: string;
  define: string; // KEY=VALUE passed as --dart-define when the toggle is on
  skipFlavors: string[]; // flavors the define is never added to
}

export interface ReleaseConfig {
  github: { repo: string; account?: string; baseBranch: string };
  channel: string;
  tickets?: { project: string }; // ticket keys like PROJ-123; PROJ-0 means "no ticket"
  versionBump: { branch: string; commitMessage: string; prTitle: string; prBody: string[] };
  jira?: { site: string; fromStatus: string; toStatus: string };
  team: Record<string, string>; // GitHub login → name used in notes
}

/** Where finished builds are shipped. The Slack bot token is per Mac, in the keychain, not here. */
export interface ShipConfig {
  // channel: "#deployments" or a channel id; message: lines with {placeholders} (see SHIP_PLACEHOLDERS).
  slack?: { channel: string; message: string[] };
}

export const SHIP_PLACEHOLDERS = ["app", "env", "mode", "platform", "output", "version", "bundleId", "branch", "sha", "file", "size", "note"] as const;
export const DEFAULT_SHIP_MESSAGE = ["*{app}* {env} {mode} · {platform} {output} · {version}", "{branch} @ {sha} · {file} ({size})", "{note}"];

/**
 * Deploy routes: named sets of builds that, once all have built, are posted
 * together with notes (changes since the route's last deploy) to a channel.
 */
export interface DeployRoute {
  id: string;
  label: string;
  builds: { platform: "android" | "ios"; environment: string; mode: "debug" | "profile" | "release" }[];
  options: {
    androidOutput?: "apk" | "appbundle";
    iosOutput?: "ipa" | "app";
    exportMethod?: "app-store" | "ad-hoc" | "development";
    splitDebugInfo?: boolean;
    obfuscate?: boolean;
    arm64Only?: boolean;
    toggles?: string[];
  };
  to: { slack: string };
  // together: one message once all have built (onFailure: hold, or post what built);
  // as-built: the notes with the first build, the rest as replies in their thread.
  post: "together" | "as-built";
  onFailure: "hold" | "post-built";
}

/** Extra flags passed through unchanged (e.g. --no-tree-shake-icons). */
export interface ExtraArgs {
  all: string[];
  android: string[];
  ios: string[];
}

export interface FledgeConfig {
  // The command that runs Flutter, e.g. ["fvm", "flutter"]; "auto" picks per
  // checkout (fvm with .fvmrc, puro with .puro.json, else flutter).
  flutter: "auto" | string[];
  flavors: FlavorConfig[];
  flavorDefine: string | null; // --dart-define=<this>=<flavor>; null to not pass one
  gitShaDefine: string | null;
  defines: Record<string, string>; // added to every build
  defineFiles: string[]; // --dart-define-from-file for every build
  args: ExtraArgs;
  symbolsDir: string; // relative; {flavor} and {platform} are filled in
  toggles: ToggleConfig[];
  // The build commands as text (see templates.ts). null: generated from the
  // fields above, which is also what "Write out commands" puts here.
  commands: CommandTemplates | null;
  release: ReleaseConfig | null;
  ship: ShipConfig | null;
  deploy: DeployRoute[];
}

const NAME = /^[a-z][a-z0-9_]*$/;
const DEFINE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFINE_VALUE = /^[A-Za-z0-9_.:/-]*$/;
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/;
const SCHEME = /^[A-Za-z0-9 _.-]+$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9-]+$/;
const BRANCH = /^[A-Za-z0-9._/{}-]+$/;

export const DEFAULT_PR_BODY = [
  "## Summary",
  "- Set the app version to `{version}` for the {date} release ({baseBranch} @ {headShort}).",
  "",
  "The `{tag}` {releaseKind} is tagged on this branch's commit `{bumpShort}`.",
  "",
  "Opened by fledge.",
];

const FLUTTER_ALIASES: Record<string, string[]> = { flutter: ["flutter"], fvm: ["fvm", "flutter"], puro: ["puro", "flutter"] };
const COMMAND_PART = /^[A-Za-z0-9_.\/@:+-]+$/;
const ARG = /^--?[A-Za-z][A-Za-z0-9-]*(=[A-Za-z0-9_.,:\/@+-]*)?$/;
const REL_PATH = /^[A-Za-z0-9_.\/-]+$/;

class ConfigError extends Error {}

function fail(where: string, msg: string): never {
  throw new ConfigError(`${where}: ${msg}`);
}

function str(v: unknown, where: string, re?: RegExp): string {
  if (typeof v !== "string" || !v) fail(where, "must be a non-empty string");
  if (re && !re.test(v)) fail(where, `"${v}" is not allowed (must match ${re})`);
  return v;
}

function optStr(v: unknown, where: string, re?: RegExp): string | undefined {
  return v === undefined ? undefined : str(v, where, re);
}

/** A path inside the app (no absolute paths, no ".."). */
function relPath(v: unknown, where: string): string {
  const p = str(v, where);
  if (path.isAbsolute(p) || p.split("/").includes("..") || !REL_PATH.test(p)) fail(where, `"${p}" must be a plain relative path inside the app`);
  return p;
}

function pathList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(where, "must be an array of paths");
  return v.map((x, i) => relPath(x, `${where}[${i}]`));
}

function defineMap(v: unknown, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (v === undefined) return out;
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(where, "must be an object of NAME: value");
  for (const [k, val] of Object.entries(v)) {
    defineEntry(k, val, where);
    out[k] = val as string;
  }
  return out;
}

function argList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(where, "must be an array of flags");
  return v.map((a, i) => {
    if (typeof a !== "string" || !ARG.test(a)) fail(`${where}[${i}]`, `"${String(a)}" isn't allowed; use flags like --no-tree-shake-icons or --flag=value`);
    return a;
  });
}

function parseFlutter(v: unknown): FledgeConfig["flutter"] {
  if (v === undefined || v === "auto") return "auto";
  if (typeof v === "string") {
    const alias = FLUTTER_ALIASES[v];
    if (!alias) fail("flutter", `"${v}" — use "auto", "flutter", "fvm", "puro", or a command like ["fvm", "flutter"]`);
    return alias;
  }
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !COMMAND_PART.test(x))) {
    fail("flutter", 'must be "auto", "flutter", "fvm", "puro", or an array like ["fvm", "flutter"]');
  }
  return v as string[];
}

function defineEntry(key: string, value: unknown, where: string) {
  if (!DEFINE_KEY.test(key)) fail(where, `"${key}" is not a valid define name`);
  if (typeof value !== "string" || !DEFINE_VALUE.test(value)) fail(`${where}.${key}`, "must be a plain string value");
  return `${key}=${value}`;
}

/** Validates a parsed fledge.json and fills in defaults. Throws ConfigError with the field path. */
export function parseConfig(raw: unknown): FledgeConfig {
  if (typeof raw !== "object" || raw === null) fail("fledge.json", "must be a JSON object");
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.flavors) || r.flavors.length === 0) fail("flavors", "must list at least one flavor");
  const flavors = (r.flavors as unknown[]).map((f, i): FlavorConfig => {
    const w = `flavors[${i}]`;
    const o = (f ?? {}) as Record<string, unknown>;
    const name = str(o.name, `${w}.name`, NAME);
    const flavor = o.flavor === null ? null : (optStr(o.flavor, `${w}.flavor`, /^[A-Za-z][A-Za-z0-9_]*$/) ?? name);
    return {
      name,
      flavor,
      target: o.target === undefined ? undefined : relPath(o.target, `${w}.target`),
      defines: defineMap(o.defines, `${w}.defines`),
      defineFiles: pathList(o.defineFiles, `${w}.defineFiles`),
      vars: varMap(o.vars, `${w}.vars`),
      label: optStr(o.label, `${w}.label`) ?? name.charAt(0).toUpperCase() + name.slice(1),
      androidId: optStr(o.androidId, `${w}.androidId`, APP_ID),
      iosId: optStr(o.iosId, `${w}.iosId`, APP_ID),
      // Without a native flavor there's one scheme, Runner.
      xcodeScheme:
        optStr(o.xcodeScheme, `${w}.xcodeScheme`, SCHEME) ?? (flavor ? flavor.charAt(0).toUpperCase() + flavor.slice(1) : "Runner"),
      confirm: o.confirm === true,
    };
  });
  const names = flavors.map((f) => f.name);
  if (new Set(names).size !== names.length) fail("flavors", "names must be unique");

  const defines = defineMap(r.defines, "defines");
  const a = (r.args ?? {}) as Record<string, unknown>;
  if (typeof a !== "object" || Array.isArray(a)) fail("args", "must be an object with all/android/ios arrays");

  const toggles = ((r.toggles as unknown[] | undefined) ?? []).map((t, i): ToggleConfig => {
    const w = `toggles[${i}]`;
    const o = (t ?? {}) as Record<string, unknown>;
    const define = str(o.define, `${w}.define`);
    const eq = define.indexOf("=");
    if (eq < 1) fail(`${w}.define`, 'must look like "NAME=value"');
    defineEntry(define.slice(0, eq), define.slice(eq + 1), `${w}.define`);
    const skip = (o.skipFlavors as unknown[] | undefined) ?? [];
    for (const s of skip) if (!names.includes(s as string)) fail(`${w}.skipFlavors`, `unknown flavor "${String(s)}"`);
    return {
      id: str(o.id, `${w}.id`, /^[a-zA-Z][a-zA-Z0-9_-]*$/),
      label: str(o.label, `${w}.label`),
      hint: optStr(o.hint, `${w}.hint`) ?? "",
      define,
      skipFlavors: skip as string[],
    };
  });
  if (new Set(toggles.map((t) => t.id)).size !== toggles.length) fail("toggles", "ids must be unique");

  const symbolsDir = optStr(r.symbolsDir, "symbolsDir") ?? "build/symbols/{flavor}/{platform}";
  if (path.isAbsolute(symbolsDir) || symbolsDir.split("/").includes("..") || !/^[A-Za-z0-9_./{}-]+$/.test(symbolsDir)) {
    fail("symbolsDir", "must be a plain relative path inside the app");
  }

  return {
    flutter: parseFlutter(r.flutter),
    flavors,
    flavorDefine: r.flavorDefine === null ? null : (optStr(r.flavorDefine, "flavorDefine", DEFINE_KEY) ?? "FLAVOR"),
    gitShaDefine: r.gitShaDefine === null ? null : (optStr(r.gitShaDefine, "gitShaDefine", DEFINE_KEY) ?? "GIT_SHA"),
    defines,
    defineFiles: pathList(r.defineFiles, "defineFiles"),
    args: { all: argList(a.all, "args.all"), android: argList(a.android, "args.android"), ios: argList(a.ios, "args.ios") },
    symbolsDir,
    toggles,
    commands: r.commands === undefined || r.commands === null ? null : parseCommands(r.commands, flavors),
    release: r.release === undefined ? null : parseRelease(r.release),
    ship: r.ship === undefined || r.ship === null ? null : parseShip(r.ship),
    deploy: r.deploy === undefined ? [] : parseDeploy(r.deploy, flavors.map((f) => f.name), toggles.map((t) => t.id)),
  };
}

export const SLACK_CHANNEL = /^(#[a-z0-9][a-z0-9._-]{0,79}|[CG][A-Z0-9]{6,})$/;

function parseDeploy(raw: unknown, environments: string[], toggleIds: string[]): DeployRoute[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("deploy", "must be an object with routes");
  if (!Array.isArray(r.routes)) fail("deploy.routes", "must be a list");
  const routes = (r.routes as unknown[]).map((x, i): DeployRoute => {
    const w = `deploy.routes[${i}]`;
    const o = (x ?? {}) as Record<string, unknown>;
    if (!Array.isArray(o.builds) || o.builds.length === 0) fail(`${w}.builds`, "must list at least one build");
    if (o.builds.length > 10) fail(`${w}.builds`, "at most 10 (one Slack message holds 10 files)");
    const builds = (o.builds as unknown[]).map((b, j) => {
      const bw = `${w}.builds[${j}]`;
      const bo = (b ?? {}) as Record<string, unknown>;
      const platform = str(bo.platform, `${bw}.platform`, /^(android|ios)$/) as "android" | "ios";
      const environment = str(bo.environment, `${bw}.environment`);
      if (!environments.includes(environment)) fail(`${bw}.environment`, `unknown environment "${environment}" (have ${environments.join(", ")})`);
      const mode = str(bo.mode, `${bw}.mode`, /^(debug|profile|release)$/) as "debug" | "profile" | "release";
      return { platform, environment, mode };
    });
    const opt = (o.options ?? {}) as Record<string, unknown>;
    if (typeof opt !== "object" || Array.isArray(opt)) fail(`${w}.options`, "must be an object");
    const options: DeployRoute["options"] = {
      androidOutput: optStr(opt.androidOutput, `${w}.options.androidOutput`, /^(apk|appbundle)$/) as DeployRoute["options"]["androidOutput"],
      iosOutput: optStr(opt.iosOutput, `${w}.options.iosOutput`, /^(ipa|app)$/) as DeployRoute["options"]["iosOutput"],
      exportMethod: optStr(opt.exportMethod, `${w}.options.exportMethod`, /^(app-store|ad-hoc|development)$/) as DeployRoute["options"]["exportMethod"],
    };
    for (const k of ["splitDebugInfo", "obfuscate", "arm64Only"] as const) {
      if (opt[k] !== undefined && typeof opt[k] !== "boolean") fail(`${w}.options.${k}`, "must be true or false");
      if (opt[k] !== undefined) options[k] = opt[k] as boolean;
    }
    if (opt.toggles !== undefined) {
      if (!Array.isArray(opt.toggles) || opt.toggles.some((t) => !toggleIds.includes(t as string))) fail(`${w}.options.toggles`, `must be switch ids (have ${toggleIds.join(", ") || "none"})`);
      options.toggles = opt.toggles as string[];
    }
    const to = (o.to ?? {}) as Record<string, unknown>;
    return {
      id: str(o.id, `${w}.id`, /^[a-z0-9][a-z0-9-]{0,39}$/),
      label: optStr(o.label, `${w}.label`) ?? String(o.id),
      builds,
      options,
      to: { slack: str(to.slack, `${w}.to.slack`, SLACK_CHANNEL) },
      post: (optStr(o.post, `${w}.post`, /^(together|as-built)$/) ?? "together") as DeployRoute["post"],
      onFailure: (optStr(o.onFailure, `${w}.onFailure`, /^(hold|post-built)$/) ?? "hold") as DeployRoute["onFailure"],
    };
  });
  if (new Set(routes.map((x) => x.id)).size !== routes.length) fail("deploy.routes", "ids must be unique");
  return routes;
}

function parseShip(raw: unknown): ShipConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("ship", "must be an object");
  const r = raw as Record<string, unknown>;
  if (r.slack === undefined) return {};
  const sl = (r.slack ?? {}) as Record<string, unknown>;
  const channel = str(sl.channel, "ship.slack.channel", SLACK_CHANNEL);
  const message = sl.message === undefined ? DEFAULT_SHIP_MESSAGE : sl.message;
  if (!Array.isArray(message) || message.some((l) => typeof l !== "string")) fail("ship.slack.message", "must be an array of lines");
  for (const line of message as string[]) {
    for (const [, k] of line.matchAll(/\{(\w+)\}/g)) {
      if (!(SHIP_PLACEHOLDERS as readonly string[]).includes(k)) fail("ship.slack.message", `unknown placeholder {${k}} (use ${SHIP_PLACEHOLDERS.map((p) => `{${p}}`).join(" ")})`);
    }
  }
  return { slack: { channel, message: message as string[] } };
}

function varMap(v: unknown, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (v === undefined) return out;
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(where, "must be an object of NAME: value");
  for (const [k, val] of Object.entries(v)) {
    if (!DEFINE_KEY.test(k)) fail(where, `"${k}" isn't a valid placeholder name`);
    if ((INLINE as readonly string[]).includes(k) || (WHOLE as readonly string[]).includes(k)) fail(where, `"${k}" is one of fledge's own placeholders`);
    if (typeof val !== "string" || !/^[^\s\u0000-\u001f]*$/.test(val)) fail(`${where}.${k}`, "must be a string without spaces");
    out[k] = val;
  }
  return out;
}

function parseCommands(raw: unknown, flavors: FlavorConfig[]): CommandTemplates {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("commands", "must be an object");
  const r = raw as Record<string, unknown>;
  const check = (v: unknown, where: string, allowed?: readonly string[]): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string") fail(where, "must be a command line (a string)");
    if (v.length > 4000) fail(where, "is too long");
    const problems = templateProblems(v, flavors, allowed);
    if (problems.length) fail(where, problems.join("; "));
    return v;
  };
  const section = (name: "android" | "ios", outputs: readonly string[]) => {
    const o = r[name];
    if (o === undefined) return {};
    if (typeof o !== "object" || o === null || Array.isArray(o)) fail(`commands.${name}`, "must be an object");
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!outputs.includes(k)) fail(`commands.${name}.${k}`, `unknown output; use ${outputs.join(", ")}`);
      out[k] = check(v, `commands.${name}.${k}`)!;
    }
    return out;
  };
  return {
    pubGet: r.pubGet === null ? null : (check(r.pubGet, "commands.pubGet", ["flutter"]) ?? "{flutter} pub get"),
    android: section("android", ["apk", "appbundle"]),
    ios: section("ios", ["ipa", "app", "xcode"]),
  };
}

function parseRelease(raw: unknown): ReleaseConfig {
  if (typeof raw !== "object" || raw === null) fail("release", "must be an object");
  const r = raw as Record<string, unknown>;
  const gh = (r.github ?? {}) as Record<string, unknown>;
  const bump = (r.versionBump ?? {}) as Record<string, unknown>;
  const team: Record<string, string> = {};
  for (const [login, name] of Object.entries((r.team as Record<string, unknown> | undefined) ?? {})) {
    if (!LOGIN.test(login)) fail("release.team", `"${login}" is not a GitHub login`);
    team[login] = str(name, `release.team.${login}`);
  }
  const prBody = bump.prBody === undefined ? DEFAULT_PR_BODY : bump.prBody;
  if (!Array.isArray(prBody) || prBody.some((l) => typeof l !== "string")) fail("release.versionBump.prBody", "must be an array of lines");

  let jira: ReleaseConfig["jira"];
  if (r.jira !== undefined) {
    const j = (r.jira ?? {}) as Record<string, unknown>;
    jira = {
      site: str(j.site, "release.jira.site", /^https:\/\/[A-Za-z0-9.-]+$/),
      fromStatus: str(j.fromStatus, "release.jira.fromStatus"),
      toStatus: str(j.toStatus, "release.jira.toStatus"),
    };
  }
  const tickets = r.tickets === undefined ? undefined : { project: str((r.tickets as Record<string, unknown>).project, "release.tickets.project", /^[A-Z][A-Z0-9]+$/) };
  if (jira && !tickets) fail("release.jira", "needs release.tickets.project to find ticket keys");

  return {
    github: {
      repo: str(gh.repo, "release.github.repo", REPO),
      account: optStr(gh.account, "release.github.account", LOGIN),
      baseBranch: optStr(gh.baseBranch, "release.github.baseBranch", /^[A-Za-z0-9._/-]+$/) ?? "main",
    },
    channel: optStr(r.channel, "release.channel") ?? "Release",
    tickets,
    versionBump: {
      branch: optStr(bump.branch, "release.versionBump.branch", BRANCH) ?? "release/bump-{versionSlug}",
      commitMessage: optStr(bump.commitMessage, "release.versionBump.commitMessage") ?? "Bump version to {tag}",
      prTitle: optStr(bump.prTitle, "release.versionBump.prTitle") ?? "Bump version to {tag}",
      prBody: prBody as string[],
    },
    jira,
    team,
  };
}

export { fill } from "./template.ts";
import { INLINE, templateProblems, WHOLE, type CommandTemplates } from "./templates.ts";

export function flavorOf(cfg: FledgeConfig, name: string): FlavorConfig | undefined {
  return cfg.flavors.find((f) => f.name === name);
}
