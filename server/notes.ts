// Pure helpers for the Release tab: parse the merge range, read ticket keys,
// suggest the next version, and render the house-format notes. No I/O here, so
// every rule is covered by notes.test.ts.

export interface MergedPr {
  number: number;
  title: string;
  author: string; // GitHub login
  dri: string; // display name for the note
  slack?: string; // the DRI's Slack member ID, when the team config has one
  branch: string;
  mergeSha: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  tickets: string[];
  versionBump: boolean;
  stackedOn: number[]; // PR numbers whose branch this PR's branch contains
}

export interface Ticket {
  key: string;
  summary: string;
  status: string;
  assignee?: string;
}

export interface ReleaseFacts {
  repo: string;
  channel: string;
  // sha: the tagged (bump) commit; base: where that build left the base branch.
  previous: { tag: string; sha: string; base: string; version: string; date: string } | null;
  head: { ref: string; sha: string };
  version: string; // x.y.z+n being cut
  date: string; // "Oct 16, 2026"
  prerelease: boolean;
  prs: MergedPr[];
  tickets: Record<string, Ticket>;
  jiraSite: string;
}

/** `git log --first-parent --format=%H%x09%s` → merged PR numbers, oldest first. */
export function parseMerges(log: string): { number: number; sha: string; branch?: string }[] {
  const out: { number: number; sha: string; branch?: string }[] = [];
  for (const line of log.split("\n")) {
    const [sha, subject = ""] = line.split("\t");
    if (!sha) continue;
    const merge = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
    const squash = /\(#(\d+)\)\s*$/.exec(subject);
    if (merge) out.push({ number: Number(merge[1]), sha, branch: merge[2] });
    else if (squash) out.push({ number: Number(squash[1]), sha });
  }
  return out.reverse();
}

/** Unique ticket keys in order of appearance; KEY-0 / KEY-0000 means "no ticket". */
export function ticketKeys(project: string, ...texts: string[]): string[] {
  const re = new RegExp(`(?<![A-Za-z0-9])${project}-(\\d+)(?![0-9])`, "g");
  const keys: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(re)) {
      const n = Number(m[1]);
      const key = `${project}-${n}`;
      if (n !== 0 && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

export const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)\+(\d+)$/;

/** Next build of the same version name: v1.3.1+2 → 1.3.1+3. Falls back to pubspec when there is no tag. */
export function nextVersion(previousTag: string | null, pubspec: string): string {
  const prev = previousTag ? VERSION_RE.exec(previousTag.replace(/^v/, "")) : null;
  const pub = VERSION_RE.exec(pubspec);
  if (!prev) return pub ? pubspec : "1.0.0+1";
  const [, a, b, c, n] = prev;
  // If pubspec already moved past the last tag (someone bumped it), respect that.
  if (pub && compareVersions(pubspec, `${a}.${b}.${c}+${n}`) > 0) return pubspec;
  return `${a}.${b}.${c}+${Number(n) + 1}`;
}

export function compareVersions(x: string, y: string): number {
  const p = (v: string) => (VERSION_RE.exec(v) ?? []).slice(1).map(Number);
  const [a, b] = [p(x), p(y)];
  for (let i = 0; i < 4; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/**
 * Values for the version-bump templates in fledge.json. `versionSlug` has no
 * dots or plus (1.3.1+3 → 1-3-1-3), since many repos refuse dots in branch names.
 */
export function bumpValues(f: Pick<ReleaseFacts, "version" | "date" | "head" | "prerelease">, bumpSha = ""): Record<string, string> {
  return {
    version: f.version,
    tag: `v${f.version}`,
    versionSlug: f.version.replace(/[.+]/g, "-"),
    date: f.date,
    baseBranch: f.head.ref,
    headShort: short(f.head.sha),
    bumpShort: short(bumpSha),
    releaseKind: f.prerelease ? "pre-release" : "release",
  };
}

/** A template as a pattern that matches any filled-in version of it, to spot earlier bump PRs. */
export function templateRegex(template: string): RegExp {
  const parts = template.split(/\{\w+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".+")}$`, "i");
}

export function formatDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Strips the "PROJ-1234: " prefix a PR title carries; the note puts the key at the end instead. */
export function cleanTitle(title: string, keys: string[]) {
  let t = title;
  for (const k of keys) t = t.replace(new RegExp(`^\\s*${k}\\s*[:\\-–]\\s*`, "i"), "");
  t = t.replace(/^\s*[A-Z][A-Z0-9]+-0+\s*[:\-–]\s*/, ""); // "PROJ-0000: " = no ticket
  // Leave words like "iOS" or "eSIM" alone; only a plain lowercase first word is capitalised.
  return /^[a-z][a-z']*\b/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function items(f: ReleaseFacts) {
  return f.prs.filter((p) => !p.versionBump);
}

function short(sha: string) {
  return sha.slice(0, 8);
}

/** The Slack/channel note, in the format the team already posts. */
export function templateSlack(f: ReleaseFacts): string {
  const list = items(f);
  const lines = [f.channel, ""];
  list.forEach((p, i) => {
    const keys = p.tickets.length ? p.tickets.join(", ") : `PR #${p.number}`;
    lines.push(`${i + 1}. ${cleanTitle(p.title, p.tickets)} — ${keys}`);
    lines.push(`   DRI: @${p.dri}`);
  });
  const prList = list.map((p) => `#${p.number}`).join(", ");
  lines.push(
    "",
    `Deployment date: ${f.date}`,
    `Tickets: ${list.length}`,
    `Build: ${f.head.ref} @ ${short(f.head.sha)}, version ${f.version}`,
    `Commit range: ${f.previous ? short(f.previous.base) : "(first release)"} → ${f.head.ref} @ ${short(f.head.sha)} (PRs ${prList}).`,
    "",
    ...rollback(f),
  );
  return lines.join("\n");
}

function rollback(f: ReleaseFacts): string[] {
  const list = items(f);
  const lines = ["Rollback"];
  lines.push(
    f.previous
      ? `- Full rollback: redeploy the previous staging build (${f.previous.version}, ${f.previous.tag} @ ${short(f.previous.sha)}).`
      : "- Full rollback: no previous release to return to.",
  );
  const stacked = list.filter((p) => p.stackedOn.length);
  lines.push(
    stacked.length
      ? "- Any single item: revert its merge commit. Each ticket is its own PR, except the stacked ones below."
      : "- Any single item: revert its merge commit. Each ticket is its own PR and none is stacked on another, so each can be reverted alone.",
  );
  for (const p of stacked) {
    lines.push(`- #${p.number} builds on ${p.stackedOn.map((n) => `#${n}`).join(", ")}: reverting those means reverting #${p.number} too.`);
  }
  return lines;
}

/** GitHub release body, in the format of v1.2.15+55 / v1.3.1+2. */
export function templateGithub(f: ReleaseFacts): string {
  const list = items(f);
  const lines = [
    `Release ${f.version} for the ${f.date} deployment.`,
    "",
    `**Base:** \`${f.head.ref}\` @ \`${short(f.head.sha)}\`, commit range \`${f.previous ? short(f.previous.base) : "start"}\` → \`${short(f.head.sha)}\` (PRs ${list.map((p) => `#${p.number}`).join(", ")}), plus the version bump.`,
    "",
    "## Tickets",
  ];
  list.forEach((p, i) => {
    const keys = p.tickets.length ? p.tickets.join(", ") : `PR #${p.number}`;
    lines.push(`${i + 1}. ${cleanTitle(p.title, p.tickets)} — ${keys}`);
  });
  lines.push("", "## Rollback", ...rollback(f).slice(1));
  return lines.join("\n");
}

export function jiraComment(tag: string, url: string, prerelease: boolean, moved: { from: string; to: string } | null, status: string, toStatus: string) {
  const kind = prerelease ? "pre-release" : "release";
  return moved
    ? `Included in ${kind} ${tag} (${url}); moved ${moved.from} -> ${moved.to}.`
    : `Included in ${kind} ${tag} (${url}). Status is ${status}, so it was not moved to ${toStatus}; please check it.`;
}

/** What a deploy is: its route, builds and where its changes start. */
export interface DeployNoteFacts {
  app: string;
  label: string; // the route's label, or "Deploy" for a one-off
  version: string;
  builds: { environment: string; mode: string; platform: "android" | "ios"; output: string }[];
  branch: string;
  sha: string;
  since: string | null; // the last deploy's commit, or null for the first
  prs: MergedPr[];
  commits: string[]; // subjects, when there are no PRs to show (no release setup)
}

/**
 * A deploy's message, Slack formatting: the builds, then what changed since
 * the route's last deploy, one numbered item per PR like the channel note.
 * The files are added when it's posted.
 */
export function templateDeploy(d: DeployNoteFacts): string {
  const byKind = new Map<string, string[]>();
  for (const b of d.builds) {
    const kind = `${b.environment} ${b.mode}`;
    byKind.set(kind, [...(byKind.get(kind) ?? []), `${b.platform === "ios" ? "iOS" : "Android"} ${b.output}`]);
  }
  const lines = [
    `*${d.app}* · ${d.label} · ${d.version}`,
    `${[...byKind].map(([k, outs]) => `${k} (${outs.join(", ")})`).join(" · ")} · ${d.branch} @ ${short(d.sha)}`,
    "",
  ];
  const since = d.since ? `since the last deploy (${short(d.since)})` : "since the last release";
  if (d.prs.length) {
    lines.push(`Changes ${since}:`);
    d.prs.forEach((p, i) => {
      lines.push(`${i + 1}. ${cleanTitle(p.title, p.tickets)} — ${p.tickets.length ? p.tickets.join(", ") : `PR #${p.number}`}`);
      // fledge posts this one itself, so a member ID becomes a real mention.
      lines.push(`   DRI: ${p.slack ? `<@${p.slack}>` : `@${p.dri}`}`);
    });
  } else if (d.commits.length) {
    lines.push(`Commits ${since}:`);
    for (const c of d.commits) lines.push(`• ${c}`);
  } else {
    lines.push(`No changes ${since}.`);
  }
  return lines.join("\n");
}
