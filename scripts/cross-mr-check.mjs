import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { MattermostService, UserError } from "../src/core.js";
import { GitLabService } from "../src/gitlab.js";
import { conflictPaths, duplicateKeys, duplicateVersions } from "../src/merge-inspection.js";

// One merge request checked against every other one open in the same project.
//
// Two classes of breakage hide here and only the first is git's job to report.
//
//   class 1  git says CONFLICT. Somebody has to look, so it rarely ships broken.
//   class 2  git merges cleanly and the result is wrong anyway. Two branches that
//            add the same properties key on different lines are not a textual
//            conflict, so both lines survive and the later one silently wins.
//
// Class 2 is why this exists. Reading merge-tree's verdict is not enough; the
// merged tree itself has to be inspected. The rules in src/merge-inspection.js
// are the cases this team has actually been bitten by — the list grows by being
// bitten, not by guessing.
//
// Nothing here touches the working tree, the index, or any branch. merge-tree
// builds a tree object and we read blobs out of it.

const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_CANNOT_RUN = 2;

const { values } = parseArgs({
  options: {
    site: { type: "string" },
    project: { type: "string" },
    mr: { type: "string" },
    repo: { type: "string", default: process.cwd() },
    limit: { type: "string", default: "50" },
    "no-fetch": { type: "boolean", default: false },
  },
});

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: values.repo,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // merge-tree exits 1 on conflict and still prints the tree we need.
    if (allowFailure && typeof error.stdout === "string") return error.stdout;
    throw new UserError(`git ${args[0]} failed: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
  }
}

function present(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function inspect(tree) {
  const files = git(["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean);
  const found = [];
  for (const path of files.filter((name) => name.endsWith(".properties"))) {
    const keys = duplicateKeys(git(["show", `${tree}:${path}`]));
    if (keys.length) found.push(`${path} defines ${keys.join(", ")} twice`);
  }
  for (const version of duplicateVersions(files)) {
    found.push(`two migrations claim V${version}`);
  }
  return found;
}

// Everything that makes the run impossible throws; the caller maps that to one
// exit code. Nothing in here calls process.exit, because an exit inside the try
// skips the finally that closes the database and Node aborts on the open handle.
async function run(gitlab) {
  const target = Number(values.mr);
  if (!Number.isInteger(target) || target <= 0) throw new UserError("--mr must be the merge request iid to check.");
  if (!values.project) throw new UserError("--project must be the numeric project id or path.");

  const raw = git(["--version"]).trim();
  const [major, minor] = (raw.match(/\d+\.\d+/)?.[0] ?? "0.0").split(".").map(Number);
  // --write-tree landed in 2.38. Older git has a merge-tree that means something else.
  if (major < 2 || (major === 2 && minor < 38)) {
    throw new UserError(`${raw} is too old. git 2.38+ is required for merge-tree --write-tree.`);
  }

  const open = await gitlab.listOpenMergeRequests({
    siteName: values.site,
    projectId: values.project,
    limit: Number(values.limit),
  });
  const mine = open.mergeRequests.find((item) => item.mrIid === target);
  if (!mine) throw new UserError(`!${target} is not open in this project.`);
  const others = open.mergeRequests.filter((item) => item.mrIid !== target);
  if (!others.length) {
    process.stdout.write(`!${target}: nothing else is open.\n`);
    return EXIT_CLEAN;
  }

  if (!values["no-fetch"]) {
    // Remote-tracking refs only. No branch, index, or working tree is touched.
    git(["fetch", "--quiet", "origin", ...[mine, ...others].map((item) => item.sourceBranch)], {
      allowFailure: true,
    });
  }

  const missing = [mine, ...others].filter((item) => !item.headSha || !present(item.headSha));
  if (missing.length) {
    throw new UserError(
      `these heads are not in ${values.repo}: ${missing.map((item) => `!${item.mrIid}`).join(", ")}. ` +
        `Fetch them first, or drop --no-fetch.`,
    );
  }

  const findings = [];
  for (const other of others) {
    const output = git(["merge-tree", "--write-tree", "--name-only", mine.headSha, other.headSha], {
      allowFailure: true,
    });
    const tree = output.split("\n")[0].trim();
    for (const path of conflictPaths(output)) {
      findings.push(`[conflict] !${other.mrIid} ${path}`);
    }
    if (!/^[0-9a-f]{40}$/.test(tree)) continue;
    for (const note of inspect(tree)) {
      findings.push(`[silent]   !${other.mrIid} ${note}`);
    }
  }

  if (!findings.length) {
    process.stdout.write(`!${target} vs ${others.length} open: clean.\n`);
    return EXIT_CLEAN;
  }
  process.stdout.write(`${findings.join("\n")}\n`);
  return EXIT_FINDINGS;
}

const mattermost = new MattermostService();
let code;
try {
  code = await run(new GitLabService({ db: mattermost.db }));
} catch (error) {
  process.stderr.write(`${error instanceof UserError ? error.message : "Unexpected cross-check error."}\n`);
  code = EXIT_CANNOT_RUN;
} finally {
  mattermost.close();
}
// Not process.exit. Exiting immediately after close() aborts on Windows with a
// libuv UV_HANDLE_CLOSING assertion: the database handle is still closing when
// the process tears down. review-watcher.mjs never hits this because its fail()
// path leaves the handle open. Nothing keeps the loop alive here, so setting the
// code lets the process end once the close finishes.
process.exitCode = code;
