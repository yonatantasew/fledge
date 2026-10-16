// Firebase CLI sign-in state, and a way to sign in from the UI.
//
// `firebase login:list` keeps naming the account after its refresh token has
// expired, so "logged in" is decided by an authenticated call that must succeed
// (`projects:list`), not by the presence of an account.
//
// Login runs `firebase login --reauth --interactive`:
//   --interactive  the server has no TTY, and without it the CLI drops into its
//                  copy-a-code remote flow, which needs a second command.
//   --reauth       skips the first-run consent prompts, which would wait on a
//                  stdin nobody can answer, and replaces an expired token.
// The CLI then opens the browser itself and waits for Google's redirect on a
// localhost port (9005+); the URL it prints is surfaced as a fallback link.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FirebaseState = "ok" | "expired" | "logged-out" | "missing" | "checking";

export interface FirebaseStatus {
  state: FirebaseState;
  email?: string;
  checkedAt: number;
  login?: { running: boolean; url?: string; output: string; error?: string };
}

// The CLI drops firebase-debug.log into its cwd; keep that out of the repo.
const scratch = await mkdtemp(path.join(tmpdir(), "fledge-firebase-"));

async function firebase(...args: string[]) {
  return run("firebase", args, { cwd: scratch, timeout: 60_000, maxBuffer: 8 << 20 });
}

function parseJson(stdout: string): { status?: string; result?: unknown } {
  const i = stdout.indexOf("{");
  return i < 0 ? {} : JSON.parse(stdout.slice(i));
}

let status: FirebaseStatus = { state: "checking", checkedAt: 0 };
let checking: Promise<FirebaseStatus> | null = null;
let child: ChildProcess | null = null;
let onChange: (s: FirebaseStatus) => void = () => {};

export function onFirebaseChange(fn: (s: FirebaseStatus) => void) {
  onChange = fn;
}

function set(patch: Partial<FirebaseStatus>) {
  status = { ...status, ...patch };
  onChange(status);
}

export function firebaseStatus(maxAgeMs = 60_000): Promise<FirebaseStatus> {
  if (Date.now() - status.checkedAt < maxAgeMs && status.state !== "checking") return Promise.resolve(status);
  checking ??= check().finally(() => (checking = null));
  return checking;
}

async function check(): Promise<FirebaseStatus> {
  let email: string | undefined;
  try {
    const list = parseJson((await firebase("login:list", "--json")).stdout);
    const accounts = (list.result as { user?: { email?: string } }[] | undefined) ?? [];
    email = accounts[0]?.user?.email;
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    set({ state: missing ? "missing" : "logged-out", email: undefined, checkedAt: Date.now() });
    return status;
  }
  if (!email) {
    set({ state: "logged-out", email: undefined, checkedAt: Date.now() });
    return status;
  }
  const probe = await firebase("projects:list", "--json").then(
    (r) => parseJson(r.stdout),
    () => ({ status: "error" }),
  );
  set({ state: probe.status === "success" ? "ok" : "expired", email, checkedAt: Date.now() });
  return status;
}

export function startLogin(): FirebaseStatus {
  if (child) return status;
  const login = { running: true, output: "" } as NonNullable<FirebaseStatus["login"]>;
  set({ login });

  child = spawn("firebase", ["login", "--reauth", "--interactive"], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  const take = (chunk: Buffer) => {
    login.output += chunk.toString();
    login.url ??= /https:\/\/accounts\.google\.com\/\S+/.exec(login.output)?.[0];
    set({ login: { ...login } });
  };
  child.stdout!.on("data", take);
  child.stderr!.on("data", take);
  child.on("error", (e) => {
    login.error = (e as NodeJS.ErrnoException).code === "ENOENT" ? "firebase CLI not found on PATH" : e.message;
  });
  child.on("close", (code, signal) => {
    child = null;
    if (signal) login.error = "Cancelled";
    else if (code !== 0 && !login.error) login.error = /Error: (.+)/.exec(login.output)?.[1] ?? `firebase exited with ${code}`;
    set({ login: { ...login, running: false } });
    void firebaseStatus(0);
  });
  return status;
}

export function cancelLogin() {
  child?.kill("SIGTERM");
}
