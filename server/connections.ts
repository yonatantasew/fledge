// The services a build or release talks to, checked for real: is fledge signed
// in, as whom, and can it reach what this app's config names? Each service has
// a probe (I/O, gathers raw facts) and a judge (pure, turns the facts into a
// card). The judges are what connections.test.ts covers. Nothing here changes
// anything; the cards say how to fix what's wrong.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildEnv, envFor } from "./build-env.ts";
import type { ExportMethod, Mode, Platform } from "./commands.ts";
import { firebaseStatus, type FirebaseStatus } from "./firebase.ts";
import type { Project } from "./projects.ts";
import { slackToken } from "./slack.ts";

const run = promisify(execFile);

export type Health = "ok" | "warn" | "error" | "off";

export interface Connection {
  id: "github" | "jira" | "slack" | "firebase" | "sentry" | "signing";
  name: string;
  health: Health; // off: this app doesn't use it
  summary: string; // one line: who fledge is signed in as, or what's wrong
  details: string[]; // what was checked, one fact per line
  fix?: string; // what to do about it, when something's wrong
  needs?: string[]; // build variables that would fix it, which the UI offers to set
  stored?: string[]; // build variables of this service that fledge keeps for the app
  variables?: string[]; // all the build variables this service reads
  blocks?: Blocks; // the builds that would or might fail
}

/** Builds a broken connection fails: a build matches when it fits every field given. */
export interface Blocks {
  maybe?: boolean; // might fail, the check can't be sure: warned about, not skipped
  platforms?: Platform[];
  modes?: Mode[];
  artifacts?: string[];
  exportMethods?: ExportMethod[]; // IPAs only
}

// The checks that can say a build would fail.
export const BLOCKING: Connection["id"][] = ["sentry", "signing"];

/** What the checks say about a build: the first that's sure it fails, and any that think it might. */
export function blockedBy(b: { platform: Platform; mode: Mode; artifact: string }, exportMethod: ExportMethod, cards: Connection[]): { sure: Connection | null; maybe: Connection[] } {
  const fits = <T,>(list: T[] | undefined, v: T) => !list || list.includes(v);
  const hit = cards.filter(
    ({ blocks: k }) =>
      k && fits(k.platforms, b.platform) && fits(k.modes, b.mode) && fits(k.artifacts, b.artifact) && (b.artifact !== "ipa" || fits(k.exportMethods, exportMethod)),
  );
  return { sure: hit.find((c) => !c.blocks?.maybe) ?? null, maybe: hit.filter((c) => c.blocks?.maybe) };
}

// ------------------------------------------------------------------- judges

export function judgeGithub(f: {
  repo: string | null; // release.github.repo
  account: string | null; // release.github.account
  ghMissing: boolean;
  login: string | null; // who gh answers as for this app
  canPush: boolean | null; // null: the repo couldn't be read
  error?: string;
}): Connection {
  const c = { id: "github", name: "GitHub" } as const;
  if (!f.repo) return { ...c, health: "off", summary: "Not set up for this app", details: [], fix: "Add release.github.repo in the app's config to cut releases." };
  if (f.ghMissing) return { ...c, health: "error", summary: "The gh CLI isn't installed", details: [], fix: "brew install gh, then gh auth login." };
  if (!f.login)
    return {
      ...c,
      health: "error",
      summary: f.account ? `gh has no token for ${f.account}` : "gh isn't signed in",
      details: f.error ? [f.error] : [],
      fix: f.account ? `gh auth login, signing in as ${f.account}.` : "gh auth login.",
    };
  const details = [`Signed in as ${f.login}${f.account ? " (release.github.account)" : " (gh's active account)"}`];
  if (f.canPush === null)
    return { ...c, health: "error", summary: `${f.login} can't see ${f.repo}`, details: [...details, ...(f.error ? [f.error] : [])], fix: f.account ? `Check that ${f.account} has access to ${f.repo}.` : `Set release.github.account to an account with access to ${f.repo}.` };
  if (!f.canPush) return { ...c, health: "warn", summary: `${f.login} can read ${f.repo} but not push`, details, fix: "Releases push a version-bump branch; ask for write access." };
  return { ...c, health: "ok", summary: `${f.login} · ${f.repo}`, details: [...details, `Can push to ${f.repo}`] };
}

export function judgeJira(f: { site: string | null; acliMissing: boolean; status: string | null }): Connection {
  const c = { id: "jira", name: "Jira" } as const;
  if (!f.site) return { ...c, health: "off", summary: "Not set up for this app", details: [], fix: "Add release.jira in the app's config to move tickets on release." };
  if (f.acliMissing) return { ...c, health: "error", summary: "The acli CLI isn't installed", details: [], fix: "Install Atlassian's acli, then acli jira auth login." };
  const out = f.status ?? "";
  if (!/Authenticated/.test(out)) return { ...c, health: "error", summary: "acli isn't signed in", details: [], fix: "acli jira auth login." };
  const site = /Site:\s*(\S+)/.exec(out)?.[1] ?? "";
  const email = /Email:\s*(\S+)/.exec(out)?.[1] ?? "";
  const want = f.site.replace(/^https:\/\//, "").replace(/\/$/, "");
  const details = [`Signed in as ${email || "unknown"} on ${site || "an unknown site"}`];
  if (site && site !== want) return { ...c, health: "error", summary: `acli is signed in to ${site}, not ${want}`, details, fix: `acli jira auth login to ${want}.` };
  return { ...c, health: "ok", summary: `${email} · ${want}`, details: [] };
}

// What fledge itself calls: upload, post, and find a channel by name.
export const SLACK_SCOPES = ["chat:write", "files:write", "channels:read", "groups:read"];

export function judgeSlack(f: {
  channels: string[]; // what the app posts to (ship and deploy routes)
  token: boolean;
  who: { team: string; bot: string } | null;
  scopes: string[] | null;
  found: Record<string, { found: boolean; member: boolean }>;
  error?: string;
}): Connection {
  const c = { id: "slack", name: "Slack" } as const;
  if (!f.channels.length && !f.token) return { ...c, health: "off", summary: "Not set up for this app", details: [], fix: "Add ship.slack.channel or a deploy route to post builds to Slack." };
  if (!f.token) return { ...c, health: "error", summary: "No bot token on this Mac", details: [], fix: "Ship a build and paste the bot token there (README → Shipping)." };
  if (!f.who) return { ...c, health: "error", summary: "Slack rejected the bot token", details: f.error ? [f.error] : [], fix: "Paste a fresh bot token when you next ship a build." };
  const details = [`Posts as ${f.who.bot} in ${f.who.team}`];
  const missing = SLACK_SCOPES.filter((s) => f.scopes && !f.scopes.includes(s));
  const problems: string[] = [];
  if (missing.length) problems.push(`is missing permission${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
  for (const ch of f.channels) {
    const r = f.found[ch];
    if (!r?.found) problems.push(`can't see ${ch}`);
    else if (!r.member) problems.push(`isn't in ${ch}`);
    else details.push(`Can post in ${ch}`);
  }
  if (f.error) details.push(f.error);
  if (!problems.length) return { ...c, health: "ok", summary: `${f.who.bot} · ${f.who.team}`, details };
  const fix = [
    missing.length ? `Add ${missing.join(", ")} under OAuth & Permissions in the Slack app, then reinstall it.` : "",
    problems.some((p) => p.startsWith("isn't in") || p.startsWith("can't see")) ? "Invite the bot to the channel: /invite @" + f.who.bot + " (private channels stay invisible until then)." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { ...c, health: "error", summary: `The bot ${problems.join("; ")}`, details, fix };
}

export function judgeFirebase(f: { used: boolean; status: Pick<FirebaseStatus, "state" | "email"> }): Connection {
  const c = { id: "firebase", name: "Firebase" } as const;
  const { state, email } = f.status;
  if (!f.used && state !== "ok") return { ...c, health: "off", summary: "Not used by this app", details: [] };
  if (state === "ok") return { ...c, health: "ok", summary: email ?? "Signed in", details: ["firebase projects:list works"] };
  if (state === "missing") return { ...c, health: "error", summary: "The firebase CLI isn't installed", details: [], fix: "npm install -g firebase-tools." };
  if (state === "checking") return { ...c, health: "warn", summary: "Checking…", details: [] };
  return {
    ...c,
    health: "error",
    summary: state === "expired" ? `${email ?? "The"} sign-in has expired` : "Not signed in",
    details: [],
    fix: "Use Log in to Firebase in the header.",
  };
}

export function judgeSentry(f: {
  used: boolean;
  androidUpload: boolean; // the Gradle plugin uploads release builds' mappings
  skipUpload?: boolean; // SENTRY_SKIP_UPLOAD=1, and the Gradle file reads it
  env: { token: boolean; org: string | null; project: string | null };
  stored: string[]; // which of the three fledge keeps for the app, rather than its own environment
  cli: string | null; // sentry-cli --version, or null when it isn't on PATH
  url: string;
  probe: { status: number; detail?: string } | null; // GET projects/<org>/<project>/releases/
}): Connection {
  const c = { id: "sentry", name: "Sentry" } as const;
  if (!f.used) return { ...c, health: "off", summary: "Not used by this app", details: [] };
  const stored = f.stored;
  // Android release builds fail on these; a network hiccup or a 5xx might not.
  const blocks: Blocks | undefined = f.androidUpload && !f.skipUpload ? { platforms: ["android"], modes: ["release"] } : undefined;
  const skipping = f.skipUpload ? ["SENTRY_SKIP_UPLOAD=1 turns the upload off, so builds go ahead regardless"] : [];
  const unset = [!f.env.token && "SENTRY_AUTH_TOKEN", !f.env.org && "SENTRY_ORG", !f.env.project && "SENTRY_PROJECT"].filter(Boolean) as string[];
  if (unset.length)
    return {
      ...c,
      health: "error",
      summary: `Builds have no ${unset.join(", ")}`,
      details: ["Release builds upload their symbols with these.", ...skipping],
      fix: "Set them here; fledge keeps them in this Mac's Keychain and gives them to every build of this app.",
      needs: unset,
      stored,
      blocks,
    };
  const from = (n: string) => (stored.includes(n) ? "set in fledge" : "from fledge's environment");
  const details = [
    `${f.env.org}/${f.env.project} on ${f.url}`,
    `Token ${from("SENTRY_AUTH_TOKEN")}; org ${from("SENTRY_ORG")}; project ${from("SENTRY_PROJECT")}`,
    f.cli ? `sentry-cli ${f.cli}` : "sentry-cli isn't on fledge's PATH",
    ...skipping,
  ];
  const p = f.probe;
  if (!p) return { ...c, health: "error", summary: `Couldn't reach ${f.url}`, details, fix: "Check the network, or SENTRY_URL." };
  if (p.status === 404)
    return { ...c, health: "error", summary: `There's no project "${f.env.project}" in ${f.env.org}`, details, fix: "Set SENTRY_PROJECT to the project's slug, from its URL in Sentry.", needs: ["SENTRY_PROJECT"], stored, blocks };
  if (p.status === 401 || p.status === 403)
    return {
      ...c,
      health: "error",
      summary: "Sentry rejected the token for this project",
      details: [...details, ...(p.detail ? [p.detail] : [])],
      fix: "Make an organization auth token in Sentry (Settings → Auth Tokens) and set it as SENTRY_AUTH_TOKEN.",
      needs: ["SENTRY_AUTH_TOKEN"],
      stored,
      blocks,
    };
  if (p.status !== 200) return { ...c, health: "error", summary: `Sentry answered ${p.status}`, details: [...details, ...(p.detail ? [p.detail] : [])], fix: "Try again in a minute.", stored };
  // The Gradle plugin brings its own sentry-cli, so a build may not need this one.
  if (!f.cli) return { ...c, health: "error", summary: "sentry-cli isn't installed", details, fix: "npm install -g @sentry/cli (the version your build asks for), then restart fledge.", stored, blocks: blocks && { ...blocks, maybe: true } };
  return { ...c, health: "ok", summary: `${f.env.org}/${f.env.project}`, details: [...details, "The token can read this project"], stored };
}

export function judgeSigning(f: { used: boolean; team: string | null; identities: string[] }): Connection {
  const c = { id: "signing", name: "iOS signing" } as const;
  if (!f.used) return { ...c, health: "off", summary: "This app has no iOS project", details: [] };
  const ofTeam = (kind: RegExp) => f.identities.filter((i) => kind.test(i) && (!f.team || i.includes(`(${f.team})`)));
  const dev = ofTeam(/^(Apple|iPhone) Development:/);
  const dist = ofTeam(/^(Apple|iPhone) Distribution:/);
  const team = f.team ? `team ${f.team}` : "the app's team";
  const details = [...dev, ...dist].map((i) => `Certificate: ${i}`);
  if (!dist.length)
    return {
      ...c,
      health: dev.length ? "warn" : "error",
      summary: `No distribution certificate for ${team}`,
      details: details.length ? details : [`No signing certificates for ${team}`],
      fix: "Ad hoc and App Store IPAs need one. Sign in to Xcode → Settings → Accounts with an account in the team, and Xcode makes it when you next export.",
      // Only a warning: Xcode can sign with a certificate Apple keeps in the cloud, which isn't listed here.
      blocks: { maybe: true, platforms: ["ios"], artifacts: ["ipa"], exportMethods: dev.length ? ["app-store", "ad-hoc"] : undefined },
    };
  return { ...c, health: "ok", summary: `Can sign for ${team}`, details };
}

// ------------------------------------------------------------------- probes

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const firstLine = (e: unknown) => String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n")[0];

/** The org token's own region, when SENTRY_URL isn't set: sntrys_<base64 JSON>_<secret>. */
export function sentryUrl(env: NodeJS.ProcessEnv): string {
  if (env.SENTRY_URL) return env.SENTRY_URL.replace(/\/$/, "");
  const body = /^sntrys_([A-Za-z0-9+/=]+)_/.exec(env.SENTRY_AUTH_TOKEN ?? "")?.[1];
  try {
    const claims = body ? (JSON.parse(Buffer.from(body, "base64").toString()) as { region_url?: string; url?: string }) : {};
    return (claims.region_url || claims.url || "https://sentry.io").replace(/\/$/, "");
  } catch {
    return "https://sentry.io";
  }
}

async function github(p: Project): Promise<Connection> {
  const gh = p.config?.release?.github;
  const f = { repo: gh?.repo ?? null, account: gh?.account ?? null, ghMissing: false, login: null as string | null, canPush: null as boolean | null, error: undefined as string | undefined };
  if (!gh) return judgeGithub(f);
  try {
    const env = { ...process.env };
    if (gh.account) env.GH_TOKEN = (await run("gh", ["auth", "token", "--user", gh.account])).stdout.trim();
    f.login = (await run("gh", ["api", "user", "-q", ".login"], { env })).stdout.trim() || null;
    const push = (await run("gh", ["api", `repos/${gh.repo}`, "-q", ".permissions.push"], { env }).catch((e) => ((f.error = firstLine(e)), null)))?.stdout.trim();
    f.canPush = push === undefined ? null : push === "true";
  } catch (e) {
    f.ghMissing = missing(e);
    f.error = firstLine(e);
  }
  return judgeGithub(f);
}

async function jira(p: Project): Promise<Connection> {
  const site = p.config?.release?.jira?.site ?? null;
  if (!site) return judgeJira({ site, acliMissing: false, status: null });
  return run("acli", ["jira", "auth", "status"]).then(
    (r) => judgeJira({ site, acliMissing: false, status: r.stdout }),
    (e) => judgeJira({ site, acliMissing: missing(e), status: null }),
  );
}

async function slackCall(token: string, method: string, params: Record<string, string> = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  return { body: (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown }, scopes: res.headers.get("x-oauth-scopes") };
}

export function slackChannels(p: Project): string[] {
  const cfg = p.config;
  return [...new Set([cfg?.ship?.slack?.channel, ...(cfg?.deploy ?? []).map((r) => r.to.slack)].filter((c): c is string => !!c))];
}

async function slack(p: Project): Promise<Connection> {
  const channels = slackChannels(p);
  const token = await slackToken();
  const f = { channels, token: !!token, who: null as { team: string; bot: string } | null, scopes: null as string[] | null, found: {} as Record<string, { found: boolean; member: boolean }>, error: undefined as string | undefined };
  if (!token) return judgeSlack(f);
  try {
    const me = await slackCall(token, "auth.test");
    if (!me.body.ok) return judgeSlack({ ...f, error: `auth.test: ${me.body.error}` });
    f.who = { team: String(me.body.team ?? ""), bot: String(me.body.user ?? "") };
    f.scopes = me.scopes ? me.scopes.split(",").map((s) => s.trim()) : null;
    if (channels.length) {
      const byName = new Map<string, { id: string; is_member?: boolean }>();
      let cursor = "";
      do {
        const r = await slackCall(token, "conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) });
        if (!r.body.ok) throw new Error(`conversations.list: ${r.body.error}`);
        for (const ch of r.body.channels as { id: string; name: string; is_member?: boolean }[]) byName.set(`#${ch.name}`, ch).set(ch.id, ch);
        cursor = (r.body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      } while (cursor);
      for (const ch of channels) {
        const hit = byName.get(ch);
        f.found[ch] = { found: !!hit, member: !!hit?.is_member };
      }
    }
  } catch (e) {
    f.error = (e as Error).message;
  }
  return judgeSlack(f);
}

async function exists(file: string) {
  return readFile(file, "utf8").catch(() => null);
}

async function firebase(p: Project): Promise<Connection> {
  // Used when the app has a Firebase config, or fledge distributes through Firebase.
  const used = !!(await exists(path.join(p.root, "firebase.json"))) || !!(await exists(path.join(p.root, "android/app/google-services.json")));
  return judgeFirebase({ used, status: await firebaseStatus() });
}

const SENTRY_VARS = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];

async function sentry(p: Project): Promise<Connection> {
  // What a build of this app gets: fledge's environment plus the app's build variables.
  const env = await envFor(p.id);
  const stored = (await buildEnv.names(p.id)).filter((n) => SENTRY_VARS.includes(n));
  const pubspec = (await exists(path.join(p.root, "pubspec.yaml"))) ?? "";
  const gradle = ((await exists(path.join(p.root, "android/app/build.gradle"))) ?? "") + ((await exists(path.join(p.root, "android/app/build.gradle.kts"))) ?? "");
  const used = /^\s+sentry_flutter:/m.test(pubspec) || /io\.sentry\.android\.gradle/.test(gradle);
  const e = { token: !!env.SENTRY_AUTH_TOKEN, org: env.SENTRY_ORG || null, project: env.SENTRY_PROJECT || null };
  const url = sentryUrl(env);
  const cli = await run("sentry-cli", ["--version"], { env }).then(
    (r) => r.stdout.trim().replace(/^sentry-cli\s+/, ""),
    () => null,
  );
  let probe: { status: number; detail?: string } | null = null;
  if (used && e.token && e.org && e.project) {
    probe = await fetch(`${url}/api/0/projects/${encodeURIComponent(e.org)}/${encodeURIComponent(e.project)}/releases/?per_page=1`, {
      headers: { authorization: `Bearer ${env.SENTRY_AUTH_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    }).then(
      async (r) => ({ status: r.status, detail: r.ok ? undefined : ((await r.json().catch(() => ({}))) as { detail?: string }).detail }),
      () => null,
    );
  }
  // A common switch for skipping the upload, honoured when the Gradle file reads it.
  const skipUpload = /SENTRY_SKIP_UPLOAD/.test(gradle) && env.SENTRY_SKIP_UPLOAD === "1";
  const card = judgeSentry({ used, androidUpload: /io\.sentry\.android\.gradle/.test(gradle), skipUpload, env: e, stored, cli, url, probe });
  return used ? { ...card, variables: SENTRY_VARS } : card;
}

/** DEVELOPMENT_TEAM from the Xcode project; the first one set wins (flavors share a team). */
export function xcodeTeam(pbxproj: string): string | null {
  return /DEVELOPMENT_TEAM = "?([A-Z0-9]{10})"?;/.exec(pbxproj)?.[1] ?? null;
}

export function parseIdentities(out: string): string[] {
  return [...out.matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"/gm)].map((m) => m[1]);
}

async function signing(p: Project): Promise<Connection> {
  const pbx = await exists(path.join(p.root, "ios/Runner.xcodeproj/project.pbxproj"));
  if (!pbx || process.platform !== "darwin") return judgeSigning({ used: false, team: null, identities: [] });
  const out = await run("security", ["find-identity", "-v", "-p", "codesigning"]).then((r) => r.stdout, () => "");
  return judgeSigning({ used: true, team: xcodeTeam(pbx), identities: parseIdentities(out) });
}

const PROBES: Record<Connection["id"], (p: Project) => Promise<Connection>> = { github, jira, slack, firebase, sentry, signing };
export const CONNECTION_IDS = Object.keys(PROBES) as Connection["id"][];

/** One service, checked; a probe that throws becomes an error card, not a failed request. */
export function checkConnection(p: Project, id: Connection["id"]): Promise<Connection> {
  return PROBES[id](p).catch((e: Error): Connection => ({ id, name: id, health: "error", summary: "The check itself failed", details: [e.message] }));
}
