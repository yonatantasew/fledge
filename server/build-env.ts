// Build variables per app, kept on this Mac: each value in the login Keychain
// (service "fledge-env", account "<app>/<NAME>"), and the names in
// <FLEDGE_HOME>/env/<app>.json so they can be listed without reading a secret.
// Every build step gets fledge's own environment plus these, which win. That
// takes upload tokens out of shell profiles, and a change applies to the next
// build without restarting fledge.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FLEDGE_HOME } from "./projects.ts";

const run = promisify(execFile);
const SERVICE = "fledge-env";

export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// Ones that would change which programs a build runs, or how; not settable here.
const RESERVED = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|PWD|LANG|LC_[A-Z_]+|TERM|NODE_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|LD_[A-Z0-9_]*|GIT_[A-Z0-9_]*|SSH_[A-Z0-9_]*|FLEDGE_[A-Z0-9_]*|BASH_ENV|ENV|ZDOTDIR|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|GRADLE_OPTS|JAVA_OPTS|RUBYOPT|PERL5OPT|PYTHONPATH|PYTHONSTARTUP)$/;

export function envNameProblem(name: string): string | null {
  if (!ENV_NAME.test(name)) return `"${name}" isn't a variable name (capitals, digits and _, starting with a letter)`;
  if (RESERVED.test(name)) return `${name} changes how builds run, so it can't be set here`;
  return null;
}

/** Where values live; the Keychain normally, an in-memory map in tests. */
export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export const keychain: SecretStore = {
  get: (account) =>
    run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]).then(
      (r) => r.stdout.replace(/\n$/, "") || undefined,
      () => undefined,
    ),
  // The value is in `security`'s arguments for a moment, readable by this user's other processes.
  set: async (account, value) => void (await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value])),
  remove: async (account) => void (await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]).catch(() => {})),
};

export class BuildEnv {
  private readonly store: SecretStore;
  private readonly dir: string;

  constructor(store: SecretStore = keychain, dir = path.join(FLEDGE_HOME, "env")) {
    this.store = store;
    this.dir = dir;
  }

  private file(app: string) {
    return path.join(this.dir, `${app}.json`);
  }

  /** The names set for an app, sorted. Never the values. */
  async names(app: string): Promise<string[]> {
    const raw = await readFile(this.file(app), "utf8").catch(() => null);
    const names = raw ? ((JSON.parse(raw) as { names?: unknown }).names ?? []) : [];
    return (Array.isArray(names) ? names : []).filter((n): n is string => typeof n === "string" && !envNameProblem(n)).sort();
  }

  private async writeNames(app: string, names: string[]) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(app)}.tmp`;
    await writeFile(tmp, JSON.stringify({ names: [...new Set(names)].sort() }, null, 2) + "\n");
    await rename(tmp, this.file(app));
  }

  /** Sets a variable; an empty value or null removes it. Returns the names. */
  async set(app: string, name: string, value: string | null): Promise<string[]> {
    const problem = envNameProblem(name);
    if (problem) throw new Error(problem);
    if (value !== null && value.length > 8192) throw new Error("that value is too long");
    if (value !== null && /[\r\n\0]/.test(value)) throw new Error("a value is one line");
    const names = await this.names(app);
    if (value) {
      await this.store.set(`${app}/${name}`, value);
      if (!names.includes(name)) await this.writeNames(app, [...names, name]);
    } else {
      await this.store.remove(`${app}/${name}`);
      await this.writeNames(app, names.filter((n) => n !== name));
    }
    return this.names(app);
  }

  /** The values to add to a build's environment. A name whose value is gone is left out. */
  async values(app: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of await this.names(app)) {
      const v = await this.store.get(`${app}/${name}`);
      if (v) out[name] = v;
    }
    return out;
  }
}

export const buildEnv = new BuildEnv();

/** A build's environment: fledge's own, then the app's variables on top. */
export async function envFor(app: string | undefined, base: NodeJS.ProcessEnv = process.env, env = buildEnv): Promise<NodeJS.ProcessEnv> {
  return app ? { ...base, ...(await env.values(app)) } : { ...base };
}
