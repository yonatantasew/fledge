// Grouping the builds list: by version, day, branch or environment. Pure, so
// node:test covers it (build-groups.test.ts).

import type { Job } from "./api";

export type GroupBy = "none" | "version" | "date" | "branch" | "env";

export interface BuildGroup {
  key: string;
  label: string;
  builds: Job[];
}

/** The version a build is or was going to be: read back from the file, else as queued, else from its command. */
export function versionOf(j: Job): string | null {
  if (j.verified?.version) return j.verified.version;
  if (j.version) return j.version;
  const name = /--build-name=(\S+)/.exec(j.command)?.[1];
  const number = /--build-number=(\S+)/.exec(j.command)?.[1];
  return name && number ? `${name}+${number}` : null;
}

/** Newest version first: 1.3.10+2 after 1.3.9+40, by name then build number. */
export function compareVersionsDesc(a: string, b: string) {
  const parts = (v: string) => v.split(/[.+]/).map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

function dayKey(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(t: number, now = Date.now()) {
  const key = dayKey(t);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86_400_000)) return "Yesterday";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * Splits builds (already in display order) into groups, keeping that order
 * inside each. Versions and days go newest first; branches and environments
 * by their newest build. Builds with no known version go last.
 */
export function groupBuilds(builds: Job[], by: GroupBy, envLabel: (flavor: string) => string = (f) => f, now = Date.now()): BuildGroup[] {
  if (by === "none") return [{ key: "all", label: "", builds }];
  // A build that never got far enough to have a version (queued before fledge
  // recorded them) borrows one from other builds of the same commit, when
  // they all agree and none overrode it. They can disagree: pubspec edited
  // without committing.
  const overrides = (j: Job) => /--build-(name|number)=/.test(j.command);
  const byCommit = new Map<string, Set<string>>();
  for (const j of builds) {
    const v = versionOf(j);
    const key = `${j.checkout}@${j.sha}`;
    if (v && !overrides(j)) byCommit.set(key, (byCommit.get(key) ?? new Set()).add(v));
  }
  const borrowed = (j: Job) => {
    const found = overrides(j) ? undefined : byCommit.get(`${j.checkout}@${j.sha}`);
    return found?.size === 1 ? [...found][0] : null;
  };
  const keyOf = (j: Job): [string, string] => {
    if (by === "version") {
      const v = versionOf(j) ?? borrowed(j);
      return v ? [v, v] : ["", "Version unknown"];
    }
    if (by === "date") return [dayKey(j.createdAt), dayLabel(j.createdAt, now)];
    if (by === "branch") return [j.branch, j.branch];
    return [j.flavor, envLabel(j.flavor)];
  };
  const groups = new Map<string, BuildGroup & { newest: number }>();
  for (const j of builds) {
    const [key, label] = keyOf(j);
    const g = groups.get(key) ?? { key, label, builds: [], newest: 0 };
    g.builds.push(j);
    g.newest = Math.max(g.newest, j.createdAt);
    groups.set(key, g);
  }
  const list = [...groups.values()];
  list.sort((a, b) => {
    if (by === "version") return !a.key ? 1 : !b.key ? -1 : compareVersionsDesc(a.key, b.key);
    if (by === "date") return b.key.localeCompare(a.key);
    return b.newest - a.newest;
  });
  return list.map(({ newest: _, ...g }) => g);
}
