// "Add app": looks at a Flutter project and suggests a fledge.json, with a note
// for every guess so the person adding the app knows what to check. Nothing is
// written here; the UI shows the suggestion for review before it's saved.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  bumpTemplatesFrom,
  fromEnvironmentKeys,
  githubRepoFromUrl,
  humanize,
  iosIdFor,
  parseGhHosts,
  looksLikeProduction,
  parseGradleFlavors,
  parsePbxBundleIds,
  schemeFor,
  ticketProjectFrom,
} from "./detect-parse.ts";

const run = promisify(execFile);
const quiet = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
  run(cmd, args, { timeout: 20_000, maxBuffer: 16 << 20, ...opts }).then(
    (r) => r.stdout.trim(),
    () => null,
  );

export interface Detection {
  config: Record<string, unknown>;
  notes: string[];
}

async function dartSources(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await dartSources(p, out);
    else if (e.name.endsWith(".dart") && !/\.(g|freezed|gen)\.dart$/.test(e.name)) out.push(await readFile(p, "utf8"));
  }
  return out;
}

const label = (name: string) => (name.length <= 3 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1));

export async function detectProject(root: string): Promise<Detection> {
  const notes: string[] = [];
  const config: Record<string, unknown> = {};

  // ---------------------------------------------------------------- flavors
  const gradleFile = ["android/app/build.gradle", "android/app/build.gradle.kts"].map((f) => path.join(root, f)).find(existsSync);
  const gradle = gradleFile ? parseGradleFlavors(await readFile(gradleFile, "utf8")) : [];
  const pbxFile = path.join(root, "ios/Runner.xcodeproj/project.pbxproj");
  const iosIds = existsSync(pbxFile) ? parsePbxBundleIds(await readFile(pbxFile, "utf8")) : {};
  const schemes = (await readdir(path.join(root, "ios/Runner.xcodeproj/xcshareddata/xcschemes")).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".xcscheme"))
    .map((f) => f.replace(/\.xcscheme$/, ""))
    .filter((s) => s !== "Runner");

  let names = gradle.map((f) => f.name);
  if (names.length) {
    notes.push(`Flavors ${names.join(", ")} come from productFlavors in ${path.relative(root, gradleFile!)}.`);
  } else if (schemes.length) {
    names = schemes.map((s) => s.toLowerCase());
    notes.push(`No Android productFlavors found; flavors ${names.join(", ")} come from the Xcode schemes.`);
  } else {
    notes.push("No flavors found (no Android productFlavors or Xcode schemes). fledge builds with --flavor, so add them by hand.");
  }
  config.flavors = names.map((name) => {
    const f: Record<string, unknown> = { name, label: label(name) };
    const androidId = gradle.find((g) => g.name === name)?.applicationId;
    const iosId = iosIdFor(name, iosIds);
    const scheme = schemeFor(name, schemes);
    if (androidId) f.androidId = androidId;
    if (iosId) f.iosId = iosId;
    if (scheme) f.xcodeScheme = scheme;
    else if (schemes.length) notes.push(`No Xcode scheme matches "${name}"; set xcodeScheme for Prepare Xcode.`);
    if (looksLikeProduction(name)) f.confirm = true;
    return f;
  });
  const prod = names.filter(looksLikeProduction);
  if (prod.length) notes.push(`${prod.join(", ")} looks like production, so it asks for a second click before building.`);

  // ---------------------------------------------------------------- defines
  const keys = fromEnvironmentKeys((await dartSources(path.join(root, "lib"))).join("\n"));
  const strings = keys.filter((k) => k.type === "String").map((k) => k.key);
  const flavorKey =
    strings.find((k) => /^(FLAVOR|APP_FLAVOR|ENV|APP_ENV|ENVIRONMENT)$/.test(k)) ?? strings.find((k) => /FLAVOR/.test(k));
  const shaKey = strings.find((k) => /^(GIT_SHA|GIT_COMMIT|COMMIT_SHA|BUILD_SHA)$/.test(k));
  config.flavorDefine = flavorKey ?? null;
  config.gitShaDefine = shaKey ?? null;
  notes.push(
    flavorKey
      ? `Your Dart code reads ${flavorKey}, so every build passes --dart-define=${flavorKey}=<flavor>.`
      : "Your Dart code doesn't seem to read the flavor from a define, so none is passed.",
  );
  if (shaKey) notes.push(`Your Dart code reads ${shaKey}; builds pass the checkout's commit in it.`);
  const defines: Record<string, string> = {};
  if (strings.includes("BUILD_SOURCE")) {
    defines.BUILD_SOURCE = "local";
    notes.push("BUILD_SOURCE is set to \"local\", to tell these builds apart from CI ones.");
  }
  config.defines = defines;
  const otherStrings = strings.filter((k) => k !== flavorKey && k !== shaKey && k !== "BUILD_SOURCE");
  if (otherStrings.length) notes.push(`Your code also reads ${otherStrings.join(", ")}; add any that builds need under "defines".`);

  const bools = keys.filter((k) => k.type === "bool").map((k) => k.key);
  config.toggles = bools.map((key) => ({
    id: key.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
    label: humanize(key),
    hint: `Builds with --dart-define=${key}=true.`,
    define: `${key}=true`,
    skipFlavors: prod,
  }));
  if (bools.length) {
    notes.push(
      `Switches suggested for the on/off flags your code reads (${bools.join(", ")}); remove any you don't need.` +
        (prod.length ? ` They're never added to ${prod.join(", ")}.` : ""),
    );
  }

  // ---------------------------------------------------------------- release
  const remote = await quiet("git", ["-C", root, "remote", "get-url", "origin"]);
  const repo = remote ? githubRepoFromUrl(remote) : undefined;
  if (!repo) {
    notes.push("No GitHub remote found, so the Release tab is left off.");
    return { config, notes };
  }
  const base = (await quiet("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.replace(/^origin\//, "") ?? "main";
  const release: Record<string, unknown> = { github: { repo, baseBranch: base } };

  const subjects = ((await quiet("git", ["-C", root, "log", "-n", "2000", "--all", "--format=%s"])) ?? "").split("\n");
  const branches = ((await quiet("git", ["-C", root, "branch", "-r"])) ?? "").split("\n");
  const project = ticketProjectFrom(subjects.slice(0, 600));

  // The two slow lookups (GitHub accounts, Jira statuses) run side by side.
  const [account, jira] = await Promise.all([githubAccount(repo), project ? jiraStatuses(project) : Promise.resolve(null)]);
  const active = account?.active;
  if (account?.login && account.login !== active) {
    (release.github as Record<string, unknown>).account = account.login;
    notes.push(`GitHub: ${repo} is reached with your "${account.login}" gh account (not the active one).`);
  } else if (account?.login) {
    notes.push(`GitHub: ${repo}, with your active gh account.`);
  } else {
    notes.push(`None of your logged-in gh accounts can see ${repo}; log in with one that can before cutting releases.`);
  }

  if (project) {
    release.tickets = { project };
    notes.push(`Ticket keys look like ${project}-123, the most common prefix in recent commits.`);
  }
  const bump = bumpTemplatesFrom(subjects, branches);
  release.versionBump = {
    ...(bump.branch ? { branch: bump.branch } : {}),
    ...(bump.commitMessage ? { commitMessage: bump.commitMessage, prTitle: bump.commitMessage } : {}),
  };
  if (bump.commitMessage || bump.branch) {
    notes.push(`Version bumps follow your earlier ones: ${[bump.branch && `branch "${bump.branch}"`, bump.commitMessage && `commit "${bump.commitMessage}"`].filter(Boolean).join(", ")}.`);
  } else {
    notes.push('No earlier version bumps found; bumps use "release/bump-{versionSlug}" and "Bump version to {tag}".');
  }
  if (existsSync(path.join(root, ".github/pull_request_template.md"))) {
    notes.push("Your repo has a PR template. If a check requires its sections, copy them into release.versionBump.prBody.");
  }
  const nonProd = names.filter((n) => !looksLikeProduction(n)).map(label);
  release.channel = nonProd.length ? `${nonProd.join(" and ")} releases` : "Releases";

  if (jira?.from && jira.to) {
    release.jira = { site: jira.site, fromStatus: jira.from, toStatus: jira.to };
    notes.push(`Jira: releases move tickets "${jira.from}" → "${jira.to}". Check these are the statuses your team uses.`);
  } else if (jira) {
    notes.push(
      `Jira is signed in, but fledge couldn't tell which statuses to move between` +
        (jira.used.length ? ` (statuses in use: ${jira.used.join(", ")})` : "") +
        "; add release.jira by hand.",
    );
  }

  // Team names: the GitHub profile names of recent PR authors.
  const authors = await quiet("gh", ["pr", "list", "--repo", repo, "--state", "merged", "--limit", "60", "--json", "author"], {
    env: account?.token ? { ...process.env, GH_TOKEN: account.token } : process.env,
  });
  if (authors) {
    const team: Record<string, string> = {};
    for (const { author } of JSON.parse(authors) as { author: { login: string; name?: string; is_bot?: boolean } }[]) {
      if (!author.is_bot && !author.login.endsWith("[bot]")) team[author.login] ??= author.name || author.login;
    }
    release.team = team;
    if (Object.keys(team).length) notes.push(`Team names come from GitHub profiles of ${Object.keys(team).length} recent PR authors; change them to what your notes use.`);
  }

  config.release = release;
  return { config, notes };
}

/**
 * The logged-in gh account that can see the repo, preferring the active one.
 * Accounts come from gh's hosts.yml: `gh auth status` re-checks every login
 * online and can take longer than the whole detection should.
 */
export async function githubAccount(repo: string) {
  const dir = process.env.GH_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "", ".config"), "gh");
  const hosts = await readFile(path.join(dir, "hosts.yml"), "utf8").catch(() => "");
  const { accounts, active } = parseGhHosts(hosts);
  for (const login of [active, ...accounts.filter((x) => x !== active)].filter(Boolean) as string[]) {
    const token = await quiet("gh", ["auth", "token", "--user", login]);
    if (token && (await quiet("gh", ["api", `repos/${repo}`, "-q", ".full_name"], { env: { ...process.env, GH_TOKEN: token }, timeout: 30_000 }))) {
      return { login, token, active };
    }
  }
  return { login: undefined, token: undefined, active };
}

/**
 * Jira statuses for the release move, chosen from the statuses the project's
 * recent tickets actually use (one search, instead of guessing names).
 */
export async function jiraStatuses(project: string) {
  const auth = await quiet("acli", ["jira", "auth", "status"]);
  const site = auth && /Authenticated/.test(auth) ? /Site:\s*(\S+)/.exec(auth)?.[1] : undefined;
  if (!site) return null;
  const search = () =>
    quiet(
      "acli",
      ["jira", "workitem", "search", "--jql", `project = ${project} AND updated >= -90d`, "--fields", "status", "--json", "--limit", "100"],
      { timeout: 60_000 },
    );
  const out = (await search()) ?? (await search()); // one retry: Jira is often slow to answer

  const json = out ? out.slice(out.indexOf("[")) : "";
  const used = json
    ? [...new Set((JSON.parse(json) as { fields?: { status?: { name?: string } } }[]).map((i) => i.fields?.status?.name).filter(Boolean) as string[])]
    : [];
  const pick = (candidates: string[]) => used.find((u) => candidates.some((c) => c.toLowerCase() === u.toLowerCase()));
  return {
    site: `https://${site.replace(/^https?:\/\//, "")}`,
    used,
    from: pick(["Ready for test", "Ready for testing", "Ready for QA", "To test", "Ready to test"]),
    to: pick(["In Testing", "In QA", "Testing", "QA", "In test"]),
  };
}
