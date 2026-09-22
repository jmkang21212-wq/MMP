// What to look for in a merge result that git already called clean.
//
// These are pure string functions on purpose. The git calls live in
// scripts/cross-mr-check.mjs so the judgement can be pinned by tests without a
// repository, and so a fix to a rule can be proven without arranging two
// branches that collide.

/** Paths git reported as conflicted in `merge-tree` output. */
export function conflictPaths(output) {
  return String(output)
    .split("\n")
    .filter((line) => line.startsWith("CONFLICT"))
    .map((line) => line.replace(/.*Merge conflict in /, "").trim())
    .filter(Boolean);
}

/**
 * Keys defined more than once in one properties file.
 *
 * Two branches adding the same key on different lines is not a textual conflict,
 * so git keeps both and the later definition wins. Nothing reports it.
 * Comments and blank lines are dropped first; `=` and `:` both separate a key.
 */
export function duplicateKeys(text) {
  const seen = new Set();
  const twice = new Set();
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const key = line.split(/[=:]/)[0].trim();
    if (!key) continue;
    if (seen.has(key)) twice.add(key);
    seen.add(key);
  }
  return [...twice];
}

/**
 * Flyway versions claimed by two different files.
 *
 * Each branch passes its own version check because the other file is not on it
 * yet. The second one to merge is the one that breaks, and it breaks the default
 * branch rather than the merge request.
 */
export function duplicateVersions(paths) {
  const owner = new Map();
  const twice = new Set();
  for (const path of paths) {
    const version = String(path).match(/\/db\/migration\/V(\d+)__/)?.[1];
    if (!version) continue;
    if (owner.has(version) && owner.get(version) !== path) twice.add(version);
    else owner.set(version, path);
  }
  return [...twice];
}
