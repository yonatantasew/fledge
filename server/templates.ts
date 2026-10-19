// Build commands as text: the `commands` section of fledge.json.
//
// Each build output has one command line that developers read and edit like a
// terminal command. A few placeholders are filled in per build:
//
//   inline, usable inside a word:
//     {mode} {env} {flavor} {target} {sha} {exportMethod}, and each
//     environment's own `vars` ({API_URL} → that environment's value)
//   whole word, expanding to zero or more arguments:
//     {flutter}         the Flutter command, e.g. "fvm flutter"
//     {options}         the switches ticked in the form (debug info, obfuscate, toggles, arm64)
//     {version}         --build-name / --build-number when overridden in the form
//     {flavorArgs}      --flavor <flavor>, or nothing for environments without one
//     {targetArgs}      -t <entry file>, or nothing
//     {envDefines}      the environment's --dart-define flags
//     {envDefineFiles}  the environment's --dart-define-from-file flags
//
// A command is split on spaces and run directly, never through a shell, so
// quotes, pipes and $VARS mean nothing special. No imports: the browser can use
// this module too.

import type { FledgeConfig, FlavorConfig } from "./config.ts";

export type Output = "apk" | "appbundle" | "ipa" | "app" | "xcode";

export interface CommandTemplates {
  pubGet: string | null; // run once per checkout before builds; null to skip
  android: { apk?: string; appbundle?: string };
  ios: { ipa?: string; app?: string; xcode?: string };
}

export const INLINE = ["mode", "env", "flavor", "target", "sha", "exportMethod"] as const;
export const WHOLE = ["flutter", "options", "version", "flavorArgs", "targetArgs", "envDefines", "envDefineFiles"] as const;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export const tokenize = (template: string) => template.trim().split(/\s+/).filter(Boolean);

/** Problems with a template, given the environments it will be filled for. Empty when it's fine. */
export function templateProblems(template: string, envs: Pick<FlavorConfig, "name" | "flavor" | "target" | "vars">[], allowed?: readonly string[]): string[] {
  const problems: string[] = [];
  const tokens = tokenize(template);
  if (!tokens.length) return ["is empty"];
  if (/[\u0000-\u001f]/.test(template)) problems.push("contains a control character");
  for (const token of tokens) {
    for (const m of token.matchAll(PLACEHOLDER)) {
      const name = m[1];
      if (allowed && !allowed.includes(name)) {
        problems.push(`{${name}} can't be used here`);
      } else if ((WHOLE as readonly string[]).includes(name)) {
        if (token !== `{${name}}`) problems.push(`{${name}} must be a separate word (it can expand to several arguments)`);
      } else if (name === "flavor") {
        const missing = envs.filter((e) => !e.flavor).map((e) => e.name);
        if (missing.length) problems.push(`uses {flavor}, but ${missing.join(", ")} has no flavor (use {flavorArgs} instead)`);
      } else if (name === "target") {
        const missing = envs.filter((e) => !e.target).map((e) => e.name);
        if (missing.length) problems.push(`uses {target}, but ${missing.join(", ")} has no target (use {targetArgs} instead)`);
      } else if (!(INLINE as readonly string[]).includes(name)) {
        const missing = envs.filter((e) => !(name in e.vars)).map((e) => e.name);
        if (missing.length) problems.push(`uses {${name}}, which isn't a placeholder fledge knows and isn't in the vars of ${missing.join(", ")}`);
      }
    }
  }
  return problems;
}

export interface Fill {
  flutter: string[];
  mode: string;
  env: FlavorConfig;
  sha: string;
  exportMethod: string;
  options: string[];
  version: string[];
}

/** A template as argv for one build. */
export function expand(template: string, f: Fill): string[] {
  const whole: Record<string, string[]> = {
    flutter: f.flutter,
    options: f.options,
    version: f.version,
    flavorArgs: f.env.flavor ? ["--flavor", f.env.flavor] : [],
    targetArgs: f.env.target ? ["-t", f.env.target] : [],
    envDefines: Object.entries(f.env.defines).map(([k, v]) => `--dart-define=${k}=${v}`),
    envDefineFiles: f.env.defineFiles.map((p) => `--dart-define-from-file=${p}`),
  };
  const inline: Record<string, string> = {
    mode: f.mode,
    env: f.env.name,
    flavor: f.env.flavor ?? "",
    target: f.env.target ?? "",
    sha: f.sha,
    exportMethod: f.exportMethod,
    ...f.env.vars,
  };
  return tokenize(template).flatMap((token) => {
    const w = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token);
    if (w && w[1] in whole) return whole[w[1]];
    return [token.replace(PLACEHOLDER, (m, name: string) => inline[name] ?? m)];
  });
}

/**
 * The commands a config's fields describe, written out as text. This is what
 * fledge runs when a config has no `commands` section, and what "Write out
 * commands" puts into the config for editing. Settings shared by every
 * environment are written literally; only what differs uses a placeholder.
 */
export function generateCommands(cfg: Pick<FledgeConfig, "flavors" | "flavorDefine" | "gitShaDefine" | "defines" | "defineFiles" | "args">): CommandTemplates {
  const envs = cfg.flavors;
  const every = (p: (e: FlavorConfig) => boolean) => envs.every(p);
  const none = (p: (e: FlavorConfig) => boolean) => !envs.some(p);
  const flavorPart = every((e) => !!e.flavor) ? "--flavor {flavor}" : none((e) => !!e.flavor) ? "" : "{flavorArgs}";
  const targetPart = every((e) => !!e.target) ? "-t {target}" : none((e) => !!e.target) ? "" : "{targetArgs}";

  const common = (platform: "android" | "ios") =>
    [
      flavorPart,
      targetPart,
      cfg.flavorDefine ? `--dart-define=${cfg.flavorDefine}={env}` : "",
      cfg.gitShaDefine ? `--dart-define=${cfg.gitShaDefine}={sha}` : "",
      ...Object.entries(cfg.defines).map(([k, v]) => `--dart-define=${k}=${v}`),
      none((e) => Object.keys(e.defines).length > 0) ? "" : "{envDefines}",
      ...cfg.defineFiles.map((p) => `--dart-define-from-file=${p}`),
      none((e) => e.defineFiles.length > 0) ? "" : "{envDefineFiles}",
    ].filter(Boolean);
  const tail = (platform: "android" | "ios", exportMethod: boolean) =>
    ["{options}", exportMethod ? "--export-method={exportMethod}" : "", "{version}", ...cfg.args.all, ...cfg.args[platform], "--no-pub"].filter(Boolean);
  const line = (head: string, platform: "android" | "ios", exportMethod = false) =>
    [head, ...common(platform), ...tail(platform, exportMethod)].join(" ");

  return {
    pubGet: "{flutter} pub get",
    android: {
      apk: line("{flutter} build apk --{mode}", "android"),
      appbundle: line("{flutter} build appbundle --{mode}", "android"),
    },
    ios: {
      ipa: line("{flutter} build ipa --{mode}", "ios", true),
      app: line("{flutter} build ios --{mode}", "ios"),
      xcode: line("{flutter} build ios --config-only --{mode}", "ios"),
    },
  };
}
