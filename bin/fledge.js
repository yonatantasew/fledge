#!/usr/bin/env node
// The installed `fledge` command: a few flags, then the compiled server.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`fledge ${pkg.version} — build, install and release a Flutter app from a local web UI

Usage: fledge [--repo <path>] [--config <file>] [--port <n>]

  --repo <path>     the Flutter app's repository (default: the one you're in; or $FLEDGE_REPO)
  --config <file>   its fledge.json (default: <repo>/fledge.json; or $FLEDGE_CONFIG)
  --port <n>        port for the UI on localhost (default: 4417; or $PORT)
  -v, --version     print the version
  -h, --help        show this help

Config format and examples: https://github.com/yonatantasew/fledge#configuration`);
  process.exit(0);
}

const port = args.indexOf("--port");
if (port >= 0) {
  const n = Number(args[port + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error("fledge: --port needs a number between 1 and 65535");
    process.exit(1);
  }
  process.env.PORT = String(n);
}

await import("../dist-server/index.js");
