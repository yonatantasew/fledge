// The app's fledge.json: everything fledge knows about one Flutter project.
//
// It lives in the app's repository, so it is versioned with the app. Values
// from it end up on build command lines, so every field is checked here, once,
// at startup — a typo fails loudly instead of building the wrong flavor.

import path from "node:path";

export interface FlavorConfig {
  name: string; // the --flavor value
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

export interface FledgeConfig {
  flavors: FlavorConfig[];
  flavorDefine: string | null; // --dart-define=<this>=<flavor>; null to not pass one
  gitShaDefine: string | null;
  defines: Record<string, string>; // added to every build
  symbolsDir: string; // relative; {flavor} and {platform} are filled in
  toggles: ToggleConfig[];
  release: ReleaseConfig | null;
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
    return {
      name,
      label: optStr(o.label, `${w}.label`) ?? name.charAt(0).toUpperCase() + name.slice(1),
      androidId: optStr(o.androidId, `${w}.androidId`, APP_ID),
      iosId: optStr(o.iosId, `${w}.iosId`, APP_ID),
      xcodeScheme: optStr(o.xcodeScheme, `${w}.xcodeScheme`, SCHEME) ?? name.charAt(0).toUpperCase() + name.slice(1),
      confirm: o.confirm === true,
    };
  });
  const names = flavors.map((f) => f.name);
  if (new Set(names).size !== names.length) fail("flavors", "names must be unique");

  const defines: Record<string, string> = {};
  if (r.defines !== undefined) {
    if (typeof r.defines !== "object" || r.defines === null) fail("defines", "must be an object of NAME: value");
    for (const [k, v] of Object.entries(r.defines)) {
      defineEntry(k, v, "defines");
      defines[k] = v as string;
    }
  }

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
    flavors,
    flavorDefine: r.flavorDefine === null ? null : (optStr(r.flavorDefine, "flavorDefine", DEFINE_KEY) ?? "FLAVOR"),
    gitShaDefine: r.gitShaDefine === null ? null : (optStr(r.gitShaDefine, "gitShaDefine", DEFINE_KEY) ?? "GIT_SHA"),
    defines,
    symbolsDir,
    toggles,
    release: r.release === undefined ? null : parseRelease(r.release),
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

export function flavorOf(cfg: FledgeConfig, name: string): FlavorConfig | undefined {
  return cfg.flavors.find((f) => f.name === name);
}
