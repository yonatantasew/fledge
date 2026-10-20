// Release tab: gather facts from git, GitHub and Jira; describe the notes for
// a model to draft; then cut the release (bump PR, tag, GitHub release, Jira
// moves).
//
// Credentials are the ones already on this Mac — `gh` (the configured work
// account) and `acli` (Jira) — so the console stores none.
// Every outward action happens only in publish(), which the UI gates behind a
// typed confirmation, and runs in a throwaway worktree so no checkout moves.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  bumpValues,
  formatDate,
  jiraComment,
  nextVersion,
  parseMerges,
  templateRegex,
  ticketKeys,
  VERSION_RE,
  type MergedPr,
  type ReleaseFacts,
  type Ticket,
} from "./notes.ts";
import { fill, type ReleaseConfig } from "./config.ts";
import type { Project } from "./projects.ts";
import type { ToolDef } from "./ai/types.ts";

const run = promisify(execFile);
/** The app's release settings; release actions stop with a clear message without them. */
function rel(p: Project): ReleaseConfig {
  if (!p.config) throw new Error(p.error ?? `${p.name} has no fledge config yet`);
  if (!p.config.release) throw new Error(`${p.configFile} has no "release" section, so releases aren't set up for ${p.name}`);
  return p.config.release;
}

function jira(p: Project): NonNullable<ReleaseConfig["jira"]> {
  const j = rel(p).jira;
  if (!j) throw new Error(`${p.configFile} has no "release.jira" section`);
  return j;
}

async function git(p: Project, ...args: string[]) {
  return (await run("git", ["-C", p.root, ...args], { maxBuffer: 32 << 20 })).stdout.trim();
}

const ghTokens = new Map<string, Promise<string>>();
async function gh(p: Project, args: string[], cwd = p.root) {
  // With several gh accounts logged in, the active one may not have access to
  // the app's repo; release.github.account picks the one that does.
  const account = rel(p).github.account;
  let token: string | undefined;
  if (account) {
    if (!ghTokens.has(account)) ghTokens.set(account, run("gh", ["auth", "token", "--user", account]).then((r) => r.stdout.trim()));
    token = await ghTokens.get(account);
  }
  const env = { ...process.env, GH_REPO: rel(p).github.repo, ...(token ? { GH_TOKEN: token } : {}) };
  return (await run("gh", args, { cwd, env, maxBuffer: 32 << 20 })).stdout.trim();
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

// ------------------------------------------------------------------ sources

export interface ReleaseRef {
  tag: string;
  prerelease: boolean;
  createdAt: string;
}

export async function releases(p: Project): Promise<ReleaseRef[]> {
  const list = JSON.parse(
    await gh(p, ["release", "list", "--limit", "20", "--json", "tagName,isPrerelease,isDraft,createdAt"]),
  ) as { tagName: string; isPrerelease: boolean; isDraft: boolean; createdAt: string }[];
  return list.filter((r) => !r.isDraft).map((r) => ({ tag: r.tagName, prerelease: r.isPrerelease, createdAt: r.createdAt }));
}

export interface StatusReport {
  github: { ok: boolean; login?: string; error?: string };
  jira: { ok: boolean; email?: string; error?: string };
}

export async function connections(p: Project): Promise<StatusReport> {
  const [github, jira] = await Promise.all([
    (p.config?.release ? gh(p, ["api", "user", "-q", ".login"]) : Promise.reject(new Error("releases aren't set up (no release section in fledge.json)"))).then(
      (login) => ({ ok: true, login }),
      (e: Error) => ({ ok: false, error: e.message.split("\n")[0] }),
    ),
    !p.config?.release?.jira
      ? Promise.resolve({ ok: false, error: "not set up for this app (release.jira in fledge.json)" })
      : run("acli", ["jira", "auth", "status"]).then(
      (r) => {
        const email = /Email:\s*(\S+)/.exec(r.stdout)?.[1];
        return /Authenticated/.test(r.stdout) ? { ok: true, email } : { ok: false, error: "acli is not authenticated" };
      },
      () => ({ ok: false, error: "acli not found or not authenticated (acli jira auth login)" }),
    ),
  ]);
  return { github, jira };
}

async function jiraTickets(keys: string[]): Promise<Record<string, Ticket>> {
  if (!keys.length) return {};
  const out: Record<string, Ticket> = {};
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const { stdout } = await run(
      "acli",
      ["jira", "workitem", "search", "--jql", `key in (${chunk.join(",")})`, "--fields", "key,summary,status,assignee", "--json", "--limit", "50"],
      { maxBuffer: 16 << 20 },
    );
    for (const it of JSON.parse(stdout) as { key: string; fields: { summary: string; status: { name: string }; assignee?: { displayName?: string } } }[]) {
      out[it.key] = {
        key: it.key,
        summary: it.fields.summary,
        status: it.fields.status.name,
        assignee: it.fields.assignee?.displayName,
      };
    }
  }
  return out;
}

/**
 * Everything merged to the base branch since `baseTag`. The range is
 * `baseTag..origin/main` on first-parent history: a release tag sits on its
 * bump commit, whose parent is the main commit that was built, so the range
 * starts right after the last build.
 */
export async function gatherFacts(p: Project, baseTag: string | null, prerelease: boolean): Promise<ReleaseFacts> {
  await git(p, "fetch", "--quiet", "--tags", "origin", rel(p).github.baseBranch);
  const headRef = `origin/${rel(p).github.baseBranch}`;
  const headSha = await git(p, "rev-parse", headRef);

  let previous: ReleaseFacts["previous"] = null;
  if (baseTag) {
    const sha = await git(p, "rev-parse", `${baseTag}^{commit}`);
    const date = await git(p, "log", "-1", "--format=%cI", sha);
    const base = await git(p, "merge-base", sha, headSha);
    previous = { tag: baseTag, sha, base, version: baseTag.replace(/^v/, ""), date: formatDate(new Date(date)) };
  }

  const log = await git(p, "log", "--first-parent", "--format=%H%x09%s", previous ? `${previous.sha}..${headSha}` : `-50`, ...(previous ? [] : [headSha]));
  const merges = parseMerges(log);

  const prs = await pool(merges, 6, async (m): Promise<MergedPr> => {
    const d = JSON.parse(
      await gh(p, ["pr", "view", String(m.number), "--json", "number,title,author,headRefName,url,additions,deletions,changedFiles"]),
    ) as { number: number; title: string; author: { login: string }; headRefName: string; url: string; additions: number; deletions: number; changedFiles: number };
    const branch = m.branch ?? d.headRefName;
    return {
      number: d.number,
      title: d.title,
      author: d.author.login,
      dri: rel(p).team[d.author.login] ?? d.author.login,
      branch,
      mergeSha: m.sha,
      url: d.url,
      additions: d.additions,
      deletions: d.deletions,
      changedFiles: d.changedFiles,
      tickets: rel(p).tickets ? ticketKeys(rel(p).tickets!.project, d.title, branch) : [],
      versionBump: isBump(p, branch, d.title),
      stackedOn: [],
    };
  });

  // Stacked PRs: B's branch contained A's branch at merge time, and A was not
  // already on main when B was merged. Only real merge commits have a ^2.
  const heads = await Promise.all(prs.map((pr) => git(p, "rev-parse", "--verify", "-q", `${pr.mergeSha}^2`).catch(() => "")));
  for (let b = 0; b < prs.length; b++) {
    for (let a = 0; a < prs.length; a++) {
      if (a === b || !heads[a] || !heads[b] || prs[a].versionBump) continue;
      const inB = await run("git", ["-C", p.root, "merge-base", "--is-ancestor", heads[a], heads[b]]).then(() => true, () => false);
      if (!inB) continue;
      const onMain = await run("git", ["-C", p.root, "merge-base", "--is-ancestor", heads[a], `${prs[b].mergeSha}^1`]).then(() => true, () => false);
      if (!onMain) prs[b].stackedOn.push(prs[a].number);
    }
  }

  const keys = [...new Set(prs.flatMap((pr) => pr.tickets))];
  const pubspec = /^version:\s*(\S+)/m.exec(await git(p, "show", `${headSha}:pubspec.yaml`))?.[1] ?? "";

  return {
    repo: rel(p).github.repo,
    channel: rel(p).channel,
    previous,
    head: { ref: rel(p).github.baseBranch, sha: headSha },
    version: nextVersion(baseTag, pubspec),
    date: formatDate(new Date()),
    prerelease,
    prs,
    tickets: await jiraTickets(keys).catch(() => ({})),
    jiraSite: (rel(p).jira?.site ?? ""),
  };
}

/** An earlier version-bump PR, recognised by the configured branch or title template. */
function isBump(p: Project, branch: string, title: string) {
  const b = rel(p).versionBump;
  return templateRegex(b.branch).test(branch) || templateRegex(b.prTitle).test(title);
}

// ------------------------------------------------------------------- drafting

const NOTES_SCHEMA: ToolDef["schema"] = {
  type: "object",
  properties: {
    slack: { type: "string", description: "The channel note, plain text" },
    github: { type: "string", description: "The GitHub release body, Markdown" },
    warnings: { type: "array", items: { type: "string" }, description: "Things the release manager must check before posting" },
  },
  required: ["slack", "github", "warnings"],
  additionalProperties: false,
};

const style = (p: Project) => `You write the release notes for a Flutter app's test builds. Work only from the JSON facts given; never invent tickets, PRs, people, SHAs or versions.

Produce two texts, each a rewrite of the TEMPLATE drafts that follow, keeping their exact structure:
1. "slack": the channel note. Header line, a blank line, then one numbered item per PR (version-bump PRs are excluded):
   "N. <what changed, for a tester> — <ticket keys, or PR #n when there is none>"
   "   DRI: @<dri>"
   then the Deployment date / Tickets / Build / Commit range lines, then the Rollback section.
2. "github": the GitHub release body (Markdown): first line, **Base:** line, "## Tickets" numbered list, "## Rollback".

How to write each item title:
- Start from the PR title; use the Jira summary when it says better what a tester will see. Plain, specific, imperative or descriptive, at most ~14 words. No ticket-key prefix (like "PROJ-1234:") inside the title. No marketing words.
- Keep the order of the template.
- Keep every SHA, PR number, version and date exactly as given.

Rollback: keep the template's lines. Add one line per real risk you can see in the facts: a very large PR (changedFiles > 40) is worth naming with its size; PRs that touch the same feature (same words in titles/tickets) should be flagged as related; stacked PRs are already listed.

Context that is correct by design, so never warn about it:
- The version-bump commit does not exist yet. Publishing creates it on top of head.sha, and the release is tagged on that commit, so the PR list never contains it.
- previous.base is where the previous build left the base branch (its tag sits on a bump commit off main), so the commit range starting at previous.base is intended.

warnings (short, specific): PRs with no ticket; a DRI that looks like a GitHub login rather than a name; ${rel(p).jira ? `tickets whose Jira status is not "${rel(p).jira!.fromStatus}" (they will not be moved automatically), naming the status; ` : ""} anything in the facts that contradicts itself. Empty array if nothing.`;

/** What a model needs to draft the notes: instructions, the facts and templates, and the shape of the answer. */
export function notesRequest(p: Project, facts: ReleaseFacts, templates: { slack: string; github: string }) {
  return {
    system: style(p),
    prompt: `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nTEMPLATE slack:\n${templates.slack}\n\nTEMPLATE github:\n${templates.github}\n`,
    tool: { name: "submit_notes", description: "Hand in the drafted notes.", schema: NOTES_SCHEMA } satisfies ToolDef,
  };
}

// ------------------------------------------------------------------ publish

export interface PublishRequest {
  facts: ReleaseFacts;
  githubNotes: string;
  prerelease: boolean;
  updateJira: boolean;
  dryRun: boolean;
}

export function validatePublish(body: unknown): PublishRequest | { error: string } {
  const b = body as Partial<PublishRequest> | null;
  if (!b?.facts || typeof b.githubNotes !== "string") return { error: "facts and githubNotes are required" };
  if (!VERSION_RE.test(b.facts.version)) return { error: "version must look like 1.3.1+3" };
  if (!/^[0-9a-f]{40}$/.test(b.facts.head?.sha ?? "")) return { error: "head sha must be a full commit sha" };
  if (b.githubNotes.length > 100_000) return { error: "notes too long" };
  return {
    facts: b.facts,
    githubNotes: b.githubNotes,
    prerelease: b.prerelease !== false,
    updateJira: b.updateJira === true,
    dryRun: b.dryRun === true,
  };
}

export interface PublishResult {
  tag: string;
  branch: string;
  bumpSha: string;
  prUrl?: string;
  releaseUrl?: string;
  jira: { key: string; result: string }[];
}

/**
 * Cuts the release. Order matters: everything that can fail without leaving a
 * trace (tag exists, branch exists, sha moved) is checked before the first push.
 */
export async function publish(p: Project, req: PublishRequest, log: (line: string) => void): Promise<PublishResult> {
  const { facts } = req;
  const tag = `v${facts.version}`;
  const bump = rel(p).versionBump;
  const branch = fill(bump.branch, bumpValues(facts));
  await git(p, "check-ref-format", "--branch", branch).catch(() => {
    throw new Error(`release.versionBump.branch gives "${branch}", which isn't a valid branch name`);
  });
  const result: PublishResult = { tag, branch, bumpSha: "", jira: [] };

  log(`Checking that ${tag} and ${branch} are free…`);
  await git(p, "fetch", "--quiet", "--tags", "origin", rel(p).github.baseBranch);
  if (await git(p, "ls-remote", "--tags", "origin", `refs/tags/${tag}`)) throw new Error(`tag ${tag} already exists`);
  if (await git(p, "ls-remote", "--heads", "origin", branch)) throw new Error(`branch ${branch} already exists on origin`);
  await git(p, "cat-file", "-e", `${facts.head.sha}^{commit}`);

  const dir = await mkdtemp(path.join(tmpdir(), "fledge-bump-"));
  try {
    log(`Creating ${branch} at ${facts.head.sha.slice(0, 8)} in a temporary worktree…`);
    await git(p, "worktree", "add", "--quiet", "-b", branch, dir, facts.head.sha);
    const wt = (...a: string[]) => run("git", ["-C", dir, ...a]).then((r) => r.stdout.trim());

    const pubspecPath = path.join(dir, "pubspec.yaml");
    const pubspec = await readFile(pubspecPath, "utf8");
    if (!/^version:\s*\S+$/m.test(pubspec)) throw new Error("pubspec.yaml has no version line");
    await writeFile(pubspecPath, pubspec.replace(/^version:\s*\S+$/m, `version: ${facts.version}`));
    await wt("add", "pubspec.yaml");
    const message = fill(bump.commitMessage, bumpValues(facts));
    await wt("commit", "--quiet", "-m", message);
    result.bumpSha = await wt("rev-parse", "HEAD");
    const values = bumpValues(facts, result.bumpSha);
    const prTitle = fill(bump.prTitle, values);
    log(`Committed ${result.bumpSha.slice(0, 8)} “${message}”.`);

    if (req.dryRun) {
      const kind = req.prerelease ? "--prerelease" : "--latest";
      log(`Dry run — stopping before anything leaves this Mac. Would run:`);
      log(`  git push origin HEAD:refs/heads/${branch}`);
      log(`  gh pr create --base ${rel(p).github.baseBranch} --head ${branch} --title "${prTitle}"`);
      log(`  gh release create ${tag} --target ${result.bumpSha.slice(0, 8)} --title ${tag} ${kind} --notes-file <GitHub notes, ${req.githubNotes.length} chars>`);
      if (req.updateJira && rel(p).jira) {
        const keys = [...new Set(facts.prs.filter((pr) => !pr.versionBump).flatMap((pr) => pr.tickets))];
        const current = await jiraTickets(keys);
        const move = keys.filter((k) => current[k]?.status === jira(p).fromStatus);
        log(`  acli: move ${move.length} of ${keys.length} tickets ${jira(p).fromStatus} → ${jira(p).toStatus}: ${move.join(", ") || "none"}`);
        log(`  acli: comment the release link on all ${keys.length}`);
      }
      log("Dry run done. The temporary branch and commit were discarded.");
      return result;
    }

    log(`Pushing ${branch}…`);
    await wt("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    const remote = (await git(p, "ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0];
    if (remote !== result.bumpSha) throw new Error(`push landed ${remote} instead of ${result.bumpSha}`);

    log("Opening the version-bump PR…");
    const bodyFile = path.join(dir, ".pr-body.md");
    await writeFile(bodyFile, bump.prBody.map((line) => fill(line, values)).join("\n"));
    result.prUrl = await gh(p, ["pr", "create", "--base", rel(p).github.baseBranch, "--head", branch, "--title", prTitle, "--body-file", bodyFile]);
    log(`PR: ${result.prUrl}`);

    log(`Creating the GitHub ${req.prerelease ? "pre-release" : "release"} ${tag}…`);
    const notesFile = path.join(dir, ".release-notes.md");
    await writeFile(notesFile, req.githubNotes);
    result.releaseUrl = await gh(p, [
      "release", "create", tag,
      "--target", result.bumpSha,
      "--title", tag,
      "--notes-file", notesFile,
      ...(req.prerelease ? ["--prerelease"] : ["--latest"]),
    ]);
    log(`Release: ${result.releaseUrl}`);
  } finally {
    await git(p, "worktree", "remove", "--force", dir).catch(() => rm(dir, { recursive: true, force: true }));
    // The branch lives on origin now (or was a dry run); don't leave a local copy behind.
    await git(p, "branch", "-D", branch).catch(() => {});
  }

  if (req.updateJira && rel(p).jira) {
    const keys = [...new Set(facts.prs.filter((pr) => !pr.versionBump).flatMap((pr) => pr.tickets))];
    log(`Updating ${keys.length} Jira tickets…`);
    const current = await jiraTickets(keys);
    for (const key of keys) {
      const status = current[key]?.status ?? "unknown";
      try {
        let moved: { from: string; to: string } | null = null;
        if (status === jira(p).fromStatus) {
          await run("acli", ["jira", "workitem", "transition", "--key", key, "--status", jira(p).toStatus, "--yes"]);
          moved = { from: status, to: jira(p).toStatus };
        }
        const text = jiraComment(tag, result.releaseUrl ?? "", req.prerelease, moved, status, jira(p).toStatus);
        await run("acli", ["jira", "workitem", "comment", "create", "--key", key, "--body", text]);
        const r = moved ? `${moved.from} → ${moved.to}` : `stays ${status}`;
        result.jira.push({ key, result: r });
        log(`  ${key}: ${r}`);
      } catch (e) {
        result.jira.push({ key, result: `failed: ${(e as Error).message.split("\n")[0]}` });
        log(`  ${key}: failed — ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  log("Done.");
  return result;
}
