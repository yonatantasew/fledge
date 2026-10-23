// Build versions: what's been seen (release tags, every version fledge built,
// the checkout's pubspec), the next one to use, and fledge's history of what
// it built as which version. The build number only ever goes up, across
// version names, so a newer build always installs over an older one; the
// name is the highest seen unless someone types a new one.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const VERSION = /^(\d+)\.(\d+)\.(\d+)\+(\d+)$/;

export interface SeenVersion {
  version: string; // 1.3.1+57
  from: "release" | "build" | "pubspec";
  label: string; // "release v1.3.1+3", "build, Oct 22", "pubspec on main"
  at?: number;
}

export interface NextVersion {
  version: string;
  name: string;
  number: string;
  after: SeenVersion | null; // what it follows
}

function parts(v: string) {
  const m = VERSION.exec(v);
  return m ? { name: [Number(m[1]), Number(m[2]), Number(m[3])] as const, number: Number(m[4]) } : null;
}

const nameAbove = (a: readonly number[], b: readonly number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The next version: the highest name seen, with a build number above every
 * one seen. basedOn "releases" counts release tags only (falling back to
 * the others when there are none).
 */
export function suggestNext(seen: SeenVersion[], basedOn: "highest" | "releases"): NextVersion {
  const valid = seen.filter((s) => parts(s.version));
  const releases = valid.filter((s) => s.from === "release");
  const pool = basedOn === "releases" && releases.length ? releases : valid;
  if (!pool.length) return { version: "1.0.0+1", name: "1.0.0", number: "1", after: null };
  let topName = parts(pool[0].version)!.name;
  let after = pool[0];
  for (const s of pool) {
    const p = parts(s.version)!;
    if (nameAbove(p.name, topName) > 0) topName = p.name;
    const a = parts(after.version)!;
    if (p.number > a.number || (p.number === a.number && nameAbove(p.name, a.name) > 0)) after = s;
  }
  const name = topName.join(".");
  const number = String(parts(after.version)!.number + 1);
  return { version: `${name}+${number}`, name, number, after };
}

/** Release tags (v1.3.1+3) as versions seen. */
export function releasesSeen(tags: { tag: string; at?: number }[]): SeenVersion[] {
  return tags.filter((t) => VERSION.test(t.tag.replace(/^v/, ""))).map((t) => ({ version: t.tag.replace(/^v/, ""), from: "release", label: `release ${t.tag}`, at: t.at }));
}

/** One version fledge built: when, from which commit, as which builds, and how it was picked. */
export interface VersionRecord {
  version: string;
  at: number;
  branch: string;
  sha: string;
  how: "auto" | "typed" | "pubspec";
  pubspecCommit?: string; // when it was also written to pubspec and committed
  builds: { id: string; environment: string; platform: string; artifact: string }[];
  deployment?: string;
}

/** fledge's history of versions per app (<home>/versions.json), newest last. */
export function versionHistory(home: string) {
  const file = path.join(home, "versions.json");
  const read = () => readFile(file, "utf8").then((t) => JSON.parse(t) as Record<string, VersionRecord[]>, () => ({}) as Record<string, VersionRecord[]>);
  return {
    async list(app: string) {
      return (await read())[app] ?? [];
    },
    async add(app: string, record: VersionRecord) {
      const all = await read();
      (all[app] ??= []).push(record);
      await mkdir(home, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(all, null, 2));
      await rename(`${file}.tmp`, file);
    },
  };
}

/** A pubspec.yaml with its version line set; null when there's no version line. */
export function withVersion(pubspec: string, version: string) {
  return /^version:\s*\S+/m.test(pubspec) ? pubspec.replace(/^version:\s*\S+/m, `version: ${version}`) : null;
}
