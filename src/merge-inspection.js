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

/** PEP 503: names differing only in case or in runs of -_. are one project. */
function normalizeName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, "-");
}

function projectName(requirement) {
  // A bare URL or VCS reference names its project only through #egg=.
  if (/^[A-Za-z0-9+.-]+:\/\//.test(requirement)) {
    return normalizeName(requirement.match(/[#&]egg=([A-Za-z0-9._-]+)/)?.[1] ?? "");
  }
  return normalizeName(requirement.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1] ?? "");
}

/**
 * One package required twice in one requirements file.
 *
 * Two branches adding the same package on different lines is not a textual
 * conflict, so both lines survive. Unlike a properties key this does not stay
 * quiet: pip refuses to resolve contradictory pins. What makes it worth
 * catching here is where the failure lands. Both merge requests were green,
 * and the build breaks afterwards on the default branch.
 *
 * Lines are keyed by name and environment marker together, because the same
 * package under two different markers is deliberate, not a duplicate.
 */
export function duplicateRequirements(text) {
  const seen = new Set();
  const twice = new Set();
  // A trailing backslash continues the requirement on the following line.
  for (const raw of String(text).replace(/\\\r?\n/g, " ").split("\n")) {
    // pip treats # as a comment only at the start or after whitespace, which
    // keeps the #egg= fragment of a VCS line intact.
    const line = raw.replace(/\s+#.*$/, "").trim();
    // Blank, comment, and option lines (-r, -e, --index-url) name no package.
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const semicolon = line.indexOf(";");
    const requirement = semicolon === -1 ? line : line.slice(0, semicolon);
    const marker = semicolon === -1 ? "" : line.slice(semicolon + 1).trim().replace(/\s+/g, " ");
    const name = projectName(requirement.trim());
    if (!name) continue;
    const key = `${name};${marker}`;
    if (seen.has(key)) twice.add(name);
    seen.add(key);
  }
  return [...twice];
}
/**
 * Which of a pair's conflicting paths are really the other branch being behind.
 *
 * merge-tree(A, B) uses their merge base, so a change that reached A from the
 * target branch counts as A's side. If B is old enough, every merge request cut
 * after that change conflicts with B on the same paths, and calling that a
 * collision between A and B blames the wrong branch. Re-running the merge
 * against the target branch separates the two.
 */
export function staleConflicts(pairwise, againstTarget) {
  const behind = new Set(againstTarget);
  return pairwise.filter((path) => behind.has(path));
}