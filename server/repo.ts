// Which Flutter project fledge works on: `--repo <path>`, else $FLEDGE_REPO,
// else the git repository containing the directory fledge was started from.
// Fledge itself lives outside the app, so it never assumes its own location.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";

const run = promisify(execFile);

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function resolveRepo(): Promise<string> {
  const start = path.resolve(argValue("--repo") ?? process.env.FLEDGE_REPO ?? process.cwd());
  const root = await run("git", ["-C", start, "rev-parse", "--show-toplevel"]).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (!root || !existsSync(path.join(root, "pubspec.yaml"))) {
    console.error(
      `fledge: ${start} is not inside a Flutter project's git repository.\n` +
        "Run it from your app's folder, or pass --repo /path/to/app (or set FLEDGE_REPO).",
    );
    process.exit(1);
  }
  return root;
}

export const REPO_ROOT = await resolveRepo();

// The app's fledge.json (see config.ts), loaded once at startup.
export const { config: CONFIG, file: CONFIG_FILE } = loadConfig(REPO_ROOT);
