// "Add app": looks at a Flutter project and suggests a fledge.json, with a note
// for every guess so the person adding the app knows what to check. Nothing is
// written here; the UI shows the suggestion for review before it's saved.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseConfig } from "./config.ts";
import { generateCommands } from "./templates.ts";
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
  ciBuildDefines,
  ciEnvironmentMatrix,
  environmentKey,
  environmentValuesInDart,
  environmentsFromEntryFiles,
  parseLaunchConfigs,
  type RunConfig,
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

/**
 * The suggestion with its build commands written out as text, so the person
 * adding the app sees and can edit exactly what will run. The fields folded
 * into the commands are dropped.
 */
function withCommands(d: Detection): Detection {
  try {
    const commands = generateCommands(parseConfig(d.config));
    const config = { ...d.config };
    for (const k of ["flavorDefine", "gitShaDefine", "defines", "defineFiles", "args"]) delete config[k];
    // Keep "flutter" and the environments first, then the commands, then the rest.
    const { flutter, flavors, ...rest } = config;
    return { config: { flutter, flavors, commands, ...rest }, notes: d.notes };
  } catch {
    return d; // an incomplete suggestion stays field-based; the dialog shows what's missing
  }
}

export async function detectProject(root: string): Promise<Detection> {
  return withCommands(await detectFields(root));
}

async function detectFields(root: string): Promise<Detection> {
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

  const dart = await dartSources(path.join(root, "lib"));
  const keys = fromEnvironmentKeys(dart.join("\n"));
  const strings = keys.filter((k) => k.type === "String").map((k) => k.key);
  const envKey = environmentKey(strings);
  const ciFiles = [
    ...(await readdir(path.join(root, ".github/workflows")).catch(() => [] as string[]))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => `.github/workflows/${f}`),
    "Makefile",
    "codemagic.yaml",
    "bitrise.yml",
  ];
  const ci = (await Promise.all(ciFiles.map((f) => readFile(path.join(root, f), "utf8").catch(() => "")))).join("\n");

  const launch = parseLaunchConfigs(await readFile(path.join(root, ".vscode/launch.json"), "utf8").catch(() => ""));
  const entryFiles = environmentsFromEntryFiles(await readdir(path.join(root, "lib")).catch(() => [] as string[]));

  interface Env {
    name: string;
    flavor: string | null;
    target?: string;
    defines: Record<string, string>;
    defineFiles: string[];
  }
  // What a run configuration (or a main_<env>.dart file) adds to an environment.
  const extras = (match: (c: RunConfig) => boolean, name: string): Omit<Env, "name" | "flavor"> => {
    const c = launch.find(match);
    return {
      target: c?.target ?? entryFiles.find((e) => e.name === name)?.target,
      defines: c?.defines ?? {},
      defineFiles: c?.defineFiles ?? [],
    };
  };

  let envs: Env[];
  if (gradle.length) {
    envs = gradle.map((g) => ({ name: g.name, flavor: g.name, ...extras((c) => c.flavor === g.name, g.name) }));
    notes.push(`Environments ${envs.map((e) => e.name).join(", ")} are the productFlavors in ${path.relative(root, gradleFile!)}.`);
  } else if (schemes.length) {
    envs = schemes.map((sc) => sc.toLowerCase()).map((n) => ({ name: n, flavor: n, ...extras((c) => c.flavor === n, n) }));
    notes.push(`No Android productFlavors found; environments ${envs.map((e) => e.name).join(", ")} come from the Xcode schemes.`);
  } else if (launch.some((c) => c.target)) {
    envs = launch.map((c) => {
      const name = /main_([a-z0-9_]+)\.dart$/.exec(c.target ?? "")?.[1] ?? (c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "default");
      return { name, flavor: c.flavor ?? null, target: c.target, defines: c.defines, defineFiles: c.defineFiles };
    });
    notes.push(`No native flavors; environments ${envs.map((e) => e.name).join(", ")} come from .vscode/launch.json, each with its own entry file.`);
  } else if (entryFiles.length) {
    envs = entryFiles.map((e) => ({ name: e.name, flavor: null, target: e.target, defines: {}, defineFiles: [] }));
    notes.push(`No native flavors; environments ${envs.map((e) => e.name).join(", ")} come from the lib/main_<environment>.dart entry files.`);
  } else {
    const matrix = ciEnvironmentMatrix(ci);
    const values = matrix.length >= 2 ? matrix : environmentValuesInDart(dart);
    if (envKey && values.length >= 2) {
      envs = values.map((v) => ({ name: v, flavor: null, defines: {}, defineFiles: [] }));
      notes.push(
        `No native flavors; your app picks its environment with ${envKey}, so there's one environment per value ` +
          `(${values.join(", ")}, from ${matrix.length >= 2 ? "the CI build matrix" : "the values your Dart code compares against"}). ` +
          `Each build passes --dart-define=${envKey}=<environment>.`,
      );
    } else {
      envs = [{ name: "default", flavor: null, defines: {}, defineFiles: [] }];
      notes.push(
        envKey
          ? `Your app reads ${envKey}, but fledge couldn't tell its values; there's one environment for now. Add one per value (its name is what ${envKey} gets).`
          : "No flavors or per-environment entry files found, so there's one environment that builds without --flavor. Add more if the app has them.",
      );
    }
  }
  if (launch.length) notes.push("Entry files, defines and define files were taken from .vscode/launch.json where a configuration matched.");

  // A define file every environment uses belongs to all builds.
  const shared = envs[0].defineFiles.filter((f) => envs.every((e) => e.defineFiles.includes(f)));
  if (envs.length > 1 && shared.length) {
    config.defineFiles = shared;
    for (const e of envs) e.defineFiles = e.defineFiles.filter((f) => !shared.includes(f));
  }
  const missingFiles = [...new Set([...shared, ...envs.flatMap((e) => e.defineFiles)])].filter((f) => !existsSync(path.join(root, f)));
  if (missingFiles.length) notes.push(`Define files not found in the repo (maybe gitignored, so check they exist on this Mac): ${missingFiles.join(", ")}.`);

  const names = envs.map((e) => e.name);
  config.flavors = envs.map((e) => {
    const f: Record<string, unknown> = { name: e.name, label: label(e.name) };
    if (e.flavor !== e.name) f.flavor = e.flavor;
    if (e.target) f.target = e.target;
    if (Object.keys(e.defines).length) f.defines = e.defines;
    if (e.defineFiles.length) f.defineFiles = e.defineFiles;
    const androidId = gradle.find((g) => g.name === e.flavor)?.applicationId;
    const iosId = e.flavor ? iosIdFor(e.flavor, iosIds) : (iosIds.Release ?? iosIds.Profile ?? iosIds.Debug);
    const scheme = e.flavor ? schemeFor(e.flavor, schemes) : undefined;
    if (androidId) f.androidId = androidId;
    if (iosId) f.iosId = iosId;
    if (scheme) f.xcodeScheme = scheme;
    else if (e.flavor && schemes.length) notes.push(`No Xcode scheme matches "${e.flavor}"; set xcodeScheme for Prepare Xcode.`);
    if (looksLikeProduction(e.name)) f.confirm = true;
    return f;
  });

  // How Flutter is run: "auto" follows the project's own files, per checkout.
  config.flutter = "auto";
  if (existsSync(path.join(root, ".fvmrc")) || existsSync(path.join(root, ".fvm/fvm_config.json"))) {
    notes.push('The project pins Flutter with fvm (.fvmrc), so builds run "fvm flutter".');
  } else if (existsSync(path.join(root, ".puro.json"))) {
    notes.push('The project uses puro (.puro.json), so builds run "puro flutter".');
  } else {
    notes.push('No fvm or puro config found, so builds run plain "flutter". Change "flutter" in the config if you use something else.');
  }
  const prod = names.filter(looksLikeProduction);
  if (prod.length) notes.push(`${prod.join(", ")} looks like production, so it asks for a second click before building.`);

  // ---------------------------------------------------------------- defines
  const flavorKey = envKey;
  const shaKey = strings.find((k) => /^(GIT_SHA|GIT_COMMIT|COMMIT_SHA|BUILD_SHA)$/.test(k));
  config.flavorDefine = flavorKey ?? null;
  config.gitShaDefine = shaKey ?? null;
  // fledge passes these itself; drop copies a run configuration carried.
  for (const f of config.flavors as Record<string, unknown>[]) {
    const d = f.defines as Record<string, string> | undefined;
    if (!d) continue;
    for (const k of [flavorKey, shaKey]) if (k) delete d[k];
    if (!Object.keys(d).length) delete f.defines;
  }
  notes.push(
    flavorKey
      ? `Your Dart code reads ${flavorKey}, so every build passes --dart-define=${flavorKey}=<environment>.`
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
  const ciDefines = ciBuildDefines(ci).filter((d) => d.key !== flavorKey && d.key !== shaKey && !(d.key in defines));
  const fromVariables = ciDefines.filter((d) => d.variable).map((d) => d.key);
  if (fromVariables.length) {
    notes.push(`Your CI also passes ${fromVariables.join(", ")} from its own variables or secrets; add them under each environment's "defines" if local builds need them.`);
  }
  for (const d of ciDefines.filter((x) => !x.variable)) defines[d.key] = d.value;
  const fixed = ciDefines.filter((d) => !d.variable).map((d) => `${d.key}=${d.value}`);
  if (fixed.length) notes.push(`Copied fixed defines from your CI build command: ${fixed.join(", ")}.`);

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
