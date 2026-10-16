// Which app fledge opens first: `--repo <path>`, else $FLEDGE_REPO, else the
// folder it was started in, registered on the way if it's a new Flutter repo.
// `--config <file>` (or $FLEDGE_CONFIG) becomes that app's explicit config.
// Started outside any Flutter repo, fledge still runs and shows the app list.

import { existsSync } from "node:fs";
import path from "node:path";
import { addProject, flutterRepoRoot, type ProjectEntry } from "./projects.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

export async function startupProject(): Promise<ProjectEntry | null> {
  const repo = argValue("--repo") ?? process.env.FLEDGE_REPO;
  const config = argValue("--config") ?? process.env.FLEDGE_CONFIG;
  const dir = path.resolve(repo ?? process.cwd());
  const root = await flutterRepoRoot(dir);
  if (!root) {
    if (repo || config) {
      console.error(`fledge: ${dir} is not inside a Flutter project's git repository.`);
      process.exit(1);
    }
    return null;
  }
  if (config && !existsSync(path.resolve(config))) {
    console.error(`fledge: no config file at ${path.resolve(config)}.`);
    process.exit(1);
  }
  return addProject(root, { config });
}
