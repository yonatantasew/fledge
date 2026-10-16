// The Flutter apps fledge manages, and where each one's config comes from.
//
// Registered apps live in <home>/projects.json; a config you keep on this Mac
// lives in <home>/projects/<id>.json. <home> is $FLEDGE_HOME, else
// $XDG_CONFIG_HOME/fledge, else ~/.config/fledge.
//
// An app's config is the first of:
//   1. the file given with --config when it was registered ("explicit"),
//   2. your local file in <home>/projects/<id>.json ("local"),
//   3. the fledge.json committed in the app's repository ("repo").
// So a personal setup always wins over the team's shared default.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseConfig, type FledgeConfig } from "./config.ts";

const run = promisify(execFile);

export const FLEDGE_HOME =
  process.env.FLEDGE_HOME ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "fledge");
const REGISTRY = path.join(FLEDGE_HOME, "projects.json");
const LOCAL_DIR = path.join(FLEDGE_HOME, "projects");
const ID = /^[a-z0-9][a-z0-9-]*$/;

export interface ProjectEntry {
  id: string;
  name: string;
  path: string; // the repository's main checkout
  configPath?: string; // explicit config file, if one was given
}

export type ConfigSource = "explicit" | "local" | "repo";

export interface Project extends ProjectEntry {
  root: string;
  config: FledgeConfig | null;
  configFile: string | null; // the file the config came from, or where a local one would go
  source: ConfigSource | null;
  error?: string; // set when the chosen file exists but is invalid
}

export const localConfigPath = (id: string) => path.join(LOCAL_DIR, `${id}.json`);

async function readRegistry(): Promise<ProjectEntry[]> {
  const raw = await readFile(REGISTRY, "utf8").catch(() => null);
  if (!raw) return [];
  const list = (JSON.parse(raw) as { projects?: ProjectEntry[] }).projects ?? [];
  return list.filter((p) => ID.test(p.id) && typeof p.path === "string");
}

async function writeRegistry(list: ProjectEntry[]) {
  await mkdir(FLEDGE_HOME, { recursive: true });
  // Write then rename, so a crash mid-write can't leave a truncated registry.
  const tmp = `${REGISTRY}.tmp`;
  await writeFile(tmp, JSON.stringify({ projects: list }, null, 2) + "\n");
  await rename(tmp, REGISTRY);
}

export const listEntries = readRegistry;

/** The git repository root containing `dir`, if it is a Flutter project. */
export async function flutterRepoRoot(dir: string): Promise<string | null> {
  const root = await run("git", ["-C", path.resolve(dir), "rev-parse", "--show-toplevel"]).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (!root || !existsSync(path.join(root, "pubspec.yaml"))) return null;
  // A linked worktree resolves to its own folder; register the main checkout instead.
  const common = await run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  const main = common && path.basename(common) === ".git" ? path.dirname(common) : root;
  return existsSync(path.join(main, "pubspec.yaml")) ? main : root;
}

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

/** Registers an app (or returns it if already registered). `config` sets or replaces its explicit config file. */
export async function addProject(dir: string, opts: { name?: string; config?: string } = {}): Promise<ProjectEntry> {
  const root = await flutterRepoRoot(dir);
  if (!root) throw new Error(`${dir} is not inside a Flutter project's git repository`);
  const list = await readRegistry();
  const existing = list.find((p) => p.path === root);
  if (existing) {
    if (opts.config && existing.configPath !== path.resolve(opts.config)) {
      existing.configPath = path.resolve(opts.config);
      await writeRegistry(list);
    }
    return existing;
  }
  const base = slug(opts.name ?? path.basename(root));
  let id = base;
  for (let n = 2; list.some((p) => p.id === id); n++) id = `${base}-${n}`;
  const entry: ProjectEntry = { id, name: opts.name ?? path.basename(root), path: root };
  if (opts.config) entry.configPath = path.resolve(opts.config);
  list.push(entry);
  await writeRegistry(list);
  return entry;
}

/** Forgets an app. Its local config file is kept, in case it's added again. */
export async function removeProject(id: string) {
  const list = await readRegistry();
  await writeRegistry(list.filter((p) => p.id !== id));
}

async function readConfig(file: string): Promise<{ config: FledgeConfig | null; error?: string }> {
  try {
    return { config: parseConfig(JSON.parse(await readFile(file, "utf8"))) };
  } catch (e) {
    return { config: null, error: `${file}: ${(e as Error).message}` };
  }
}

export async function loadProject(entry: ProjectEntry): Promise<Project> {
  const candidates: [ConfigSource, string | undefined][] = [
    ["explicit", entry.configPath],
    ["local", localConfigPath(entry.id)],
    ["repo", path.join(entry.path, "fledge.json")],
  ];
  for (const [source, file] of candidates) {
    if (!file || !existsSync(file)) continue;
    const { config, error } = await readConfig(file);
    return { ...entry, root: entry.path, config, configFile: file, source, error };
  }
  return { ...entry, root: entry.path, config: null, configFile: localConfigPath(entry.id), source: null };
}

export async function getProject(id: unknown): Promise<Project | null> {
  if (typeof id !== "string" || !ID.test(id)) return null;
  const entry = (await readRegistry()).find((p) => p.id === id);
  return entry ? loadProject(entry) : null;
}

export async function listProjects(): Promise<Project[]> {
  return Promise.all((await readRegistry()).map(loadProject));
}

/** Validates and saves a config as this app's local file (which then takes precedence over the repo's). */
export async function saveLocalConfig(id: string, raw: unknown): Promise<string> {
  if (!ID.test(id)) throw new Error("bad project id");
  parseConfig(raw); // throws with the field path when invalid
  await mkdir(LOCAL_DIR, { recursive: true });
  const file = localConfigPath(id);
  await writeFile(`${file}.tmp`, JSON.stringify(raw, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
  return file;
}

const SKIP = new Set(["node_modules", ".git", "build", "Pods", ".dart_tool", ".pub-cache", "Library", ".Trash", ".claude"]);

/** Flutter apps under the usual project folders, for the "Add app" picker. Shallow and capped. */
export async function findCandidates(registered: string[]): Promise<string[]> {
  const home = os.homedir();
  const roots = [...new Set([...registered.map((p) => path.dirname(path.dirname(p))), ...["Documents", "Projects", "Developer", "dev", "code", "src", "work"].map((d) => path.join(home, d))])].filter(existsSync);
  const found = new Set<string>();
  async function walk(dir: string, depth: number) {
    if (found.size >= 60 || depth > 3) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.name === "pubspec.yaml") && entries.some((e) => e.name === ".git") && entries.some((e) => e.name === "android" || e.name === "ios")) {
      found.add(dir);
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)) await walk(path.join(dir, e.name), depth + 1);
    }
  }
  for (const r of roots) await walk(r, 0);
  return [...found].filter((p) => !registered.includes(p)).sort();
}
