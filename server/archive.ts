// Listing a build's folder (build/fledge/<time>-<platform>-<flavor>-<mode>/)
// one level at a time, for the Files layout. Paths come from the page, so
// every one is resolved inside the build's folder or refused; symlinks are
// shown, never followed.

import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface ArchiveEntry {
  name: string;
  path: string; // relative to the build's folder
  kind: "dir" | "package" | "file" | "link";
  size?: number; // files only
  items?: number; // folders: how many entries inside
  modified: number;
}

// macOS folders that act as one thing (they can still be opened).
const PACKAGES = /\.(xcarchive|app|dSYM|framework|bundle|appex)$/;
const MAX = 500;

/** The folder's absolute path, if `rel` stays inside `root`. */
export function inside(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const target = path.resolve(base, rel || ".");
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

export async function listArchive(root: string, rel = ""): Promise<{ entries: ArchiveEntry[]; truncated: boolean }> {
  const named = inside(root, rel);
  // Checked again after resolving links: a link inside could point anywhere.
  const realRoot = await realpath(root);
  const dir = named && inside(realRoot, path.relative(realRoot, await realpath(named)));
  if (!dir) throw new Error("that path is outside the build's folder");
  const names = (await readdir(dir)).filter((n) => !n.startsWith(".")); // .DS_Store and friends
  const entries = await Promise.all(
    names.slice(0, MAX).map(async (name): Promise<ArchiveEntry> => {
      const full = path.join(dir, name);
      const st = await lstat(full);
      const relPath = path.relative(realRoot, full);
      if (st.isSymbolicLink()) return { name, path: relPath, kind: "link", modified: st.mtimeMs };
      if (st.isDirectory()) {
        const items = (await readdir(full).catch(() => [])).filter((n) => !n.startsWith(".")).length;
        return { name, path: relPath, kind: PACKAGES.test(name) ? "package" : "dir", items, modified: st.mtimeMs };
      }
      return { name, path: relPath, kind: "file", size: st.size, modified: st.mtimeMs };
    }),
  );
  // Folders first, then files; each by name.
  entries.sort((a, b) => Number(a.kind === "file" || a.kind === "link") - Number(b.kind === "file" || b.kind === "link") || a.name.localeCompare(b.name));
  return { entries, truncated: names.length > MAX };
}
