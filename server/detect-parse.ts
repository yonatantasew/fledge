// Pure parsers behind "Add app": they read a Flutter project's own files and
// git history and guess a fledge.json. No I/O here, so every rule is tested
// against small hand-written samples.

/** Removes // and /* *\/ comments, leaving string contents (and URLs in them) alone. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The text between the brace at `open` and its matching closing brace. */
function block(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Top-level `name { … }` children of a block, in Groovy (`staging {`) or Kotlin DSL (`create("staging") {`) form. */
function children(body: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /(?:^|[\s;])(?:(?:create|register|maybeCreate)\s*\(\s*["']([\w-]+)["']\s*\)|([A-Za-z_][\w]*))\s*\{/g;
  let depth = 0;
  let last = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    // Only count matches at depth 0 of this block.
    for (let i = last; i < m.index; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") depth--;
    }
    last = m.index;
    const brace = body.indexOf("{", m.index + m[0].length - 1);
    if (depth === 0) {
      out.push({ name: m[1] ?? m[2], body: block(body, brace) });
      // Skip past this child's body.
      const inner = block(body, brace);
      re.lastIndex = brace + inner.length + 2;
      last = re.lastIndex;
    }
  }
  return out;
}

function stringValue(body: string, key: string): string | undefined {
  return new RegExp(`\\b${key}\\s*(?:=\\s*)?["']([^"']+)["']`).exec(body)?.[1];
}

export interface GradleFlavor {
  name: string;
  applicationId?: string;
}

/** Product flavors from android/app/build.gradle(.kts), with their application IDs. */
export function parseGradleFlavors(gradle: string): GradleFlavor[] {
  const src = stripComments(gradle);
  const pf = /productFlavors\s*\{/.exec(src);
  if (!pf) return [];
  const defaultConfig = /defaultConfig\s*\{/.exec(src);
  const baseId = defaultConfig ? stringValue(block(src, src.indexOf("{", defaultConfig.index)), "applicationId") : undefined;
  return children(block(src, src.indexOf("{", pf.index))).map(({ name, body }) => {
    const id = stringValue(body, "applicationId");
    const suffix = stringValue(body, "applicationIdSuffix");
    return { name, applicationId: id ?? (baseId && suffix ? baseId + suffix : baseId) };
  });
}

/** PRODUCT_BUNDLE_IDENTIFIER per build configuration name ("Release-Staging") of the app target, from project.pbxproj. */
export function parsePbxBundleIds(pbx: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of pbx.split("isa = XCBuildConfiguration;").slice(1)) {
    const name = /\bname = "?([^";]+)"?;/.exec(part)?.[1];
    const id = /PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/.exec(part.slice(0, part.indexOf("name = ") + 200))?.[1];
    // Test targets share the configuration names; skip them and unresolved $(VARIABLES).
    if (!name || !id || /tests?$/i.test(id) || id.includes("$(")) continue;
    out[name] ??= id;
  }
  return out;
}

/** The iOS bundle ID for a flavor: its Release configuration first, then any "<Mode>-<flavor>" one. */
export function iosIdFor(flavor: string, ids: Record<string, string>): string | undefined {
  const entries = Object.entries(ids);
  const match = (mode: string) => entries.find(([n]) => n.toLowerCase() === `${mode}-${flavor}`.toLowerCase())?.[1];
  return match("release") ?? match("profile") ?? match("debug");
}

/** The shared scheme whose name matches a flavor, ignoring case. */
export function schemeFor(flavor: string, schemes: string[]): string | undefined {
  return schemes.find((s) => s.toLowerCase() === flavor.toLowerCase());
}

/** `String/bool/int.fromEnvironment('KEY')` keys used in Dart sources, with their type. */
export function fromEnvironmentKeys(dart: string): { key: string; type: "String" | "bool" | "int" }[] {
  const out = new Map<string, "String" | "bool" | "int">();
  for (const m of dart.matchAll(/\b(String|bool|int)\.fromEnvironment\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
    if (!out.has(m[2])) out.set(m[2], m[1] as "String" | "bool" | "int");
  }
  return [...out].map(([key, type]) => ({ key, type }));
}

/**
 * "owner/repo" from a GitHub remote URL: https, ssh, or an ssh host alias
 * such as `git@github-work:owner/repo.git` (common with several accounts).
 */
export function githubRepoFromUrl(url: string): string | undefined {
  return /github[\w.-]*[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim())?.slice(1, 3).join("/");
}

/** The most common ticket prefix in commit subjects ("PROJ" from "PROJ-123: …"), ignoring PROJ-0000. */
export function ticketProjectFrom(subjects: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const s of subjects) {
    for (const m of s.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-(\d+)(?![0-9])/g)) {
      if (Number(m[2]) === 0) continue;
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : undefined;
}

const VERSION = /v?(\d+)\.(\d+)\.(\d+)\+(\d+)/;
const SLUG = /v?(\d+)-(\d+)-(\d+)-(\d+)(?![\d])/;

/**
 * The repo's own version-bump conventions, from earlier bump commits and
 * branches: "PROJ-0000: bump version to v1.3.1+2" → "PROJ-0000: bump version to {tag}".
 */
export function bumpTemplatesFrom(subjects: string[], branches: string[]): { commitMessage?: string; branch?: string } {
  const subject = subjects.find((s) => /bump/i.test(s) && /version/i.test(s) && VERSION.test(s));
  const commitMessage = subject?.replace(VERSION, (m) => (m.startsWith("v") ? "{tag}" : "{version}"));
  const branch = branches
    .map((b) => b.trim().replace(/^(?:remotes\/)?origin\//, ""))
    .find((b) => /bump/i.test(b) && SLUG.test(b));
  return {
    commitMessage,
    branch: branch?.replace(SLUG, (m) => (m.startsWith("v") ? "v{versionSlug}" : "{versionSlug}")),
  };
}

/** Production-like flavor names get "ask twice" by default. */
export const looksLikeProduction = (name: string) => /^(prod|production|release|live|store)$/i.test(name);

/** "VERBOSE_LOGS" → "Verbose logs". */
export function humanize(key: string): string {
  const s = key.toLowerCase().replace(/_+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Logged-in github.com accounts and the active one, from gh's hosts.yml. */
export function parseGhHosts(yml: string): { accounts: string[]; active?: string } {
  const section = /^github\.com:\n((?:[ \t]+.*\n?)*)/m.exec(yml)?.[1] ?? "";
  const users = /^([ \t]+)users:\n((?:\1[ \t]+.*\n?)*)/m.exec(section);
  return {
    accounts: users ? [...users[2].matchAll(/^[ \t]+([A-Za-z0-9-]+):/gm)].map((m) => m[1]) : [],
    active: /^[ \t]+user:[ \t]*(\S+)/m.exec(section)?.[1],
  };
}
