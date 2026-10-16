// `prepare` hook: builds dist/ and dist-server/ when fledge is installed from
// GitHub (`npm install -g github:…`).
//
// npm runs this in a fresh clone after installing the dev dependencies — except
// that for a global install it passes the global location on to that inner
// install, so the build tools land in the global folder instead of this clone
// and `vite` is missing here. So when they're absent, install them into this
// folder with npm's inherited location settings removed, then build.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const here = new URL("..", import.meta.url).pathname;
const run = (args, env = process.env) => {
  const r = spawnSync("npm", args, { cwd: here, stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(new URL("../node_modules/.bin/vite", import.meta.url))) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^npm_config_(global|location|prefix|local_prefix)$/i.test(k)),
  );
  // --ignore-scripts: installing here would otherwise run this hook again.
  run(["install", "--include=dev", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--global=false"], env);
}
run(["run", "build"]);
