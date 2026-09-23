import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MattermostService } from "../src/core.js";
import { GitLabService } from "../src/gitlab.js";
import {
  conflictPaths,
  duplicateKeys,
  duplicateRequirements,
  duplicateVersions,
} from "../src/merge-inspection.js";

const TOKEN = "glpat-0123456789abcdefghij";

// Real merge-tree output from the pair that motivated this check: one file git
// reported, and one it merged cleanly while breaking the setting inside it.
const MERGE_TREE_OUTPUT = `968d5733f46368e41f498de57d9c3e19a0e1295c
apps/backend/docs/oauth-setup.md
infra/service/README.md

Auto-merging apps/backend/docs/oauth-setup.md
CONFLICT (content): Merge conflict in apps/backend/docs/oauth-setup.md
Auto-merging apps/backend/src/main/resources/application.properties
Auto-merging docs/changes/2026-09-W4/README.md
Auto-merging infra/service/README.md
CONFLICT (content): Merge conflict in infra/service/README.md
`;

// What that clean auto-merge actually produced. Both branches added the key, on
// different lines, with different comments. Nothing reported it.
const MERGED_PROPERTIES = `spring.sql.init.mode=never
# Cloudflare Tunnel to nginx is plaintext, so relative redirects break OAuth return.
server.forward-headers-strategy=framework
management.endpoints.web.exposure.include=health
server.servlet.session.timeout=30m
# Enable only after the proxy sanitises forwarded headers.
server.forward-headers-strategy=none
server.servlet.session.cookie.name=SESSION
`;

test("git's own verdict names only the files it refused to merge", () => {
  assert.deepEqual(conflictPaths(MERGE_TREE_OUTPUT), [
    "apps/backend/docs/oauth-setup.md",
    "infra/service/README.md",
  ]);
  assert.deepEqual(conflictPaths("abc123\n\nAuto-merging only/this.md\n"), []);
});

test("a key added twice on different lines is found even though the merge was clean", () => {
  // The regression this check exists for. application.properties is absent from
  // conflictPaths above and still carries a contradiction.
  assert.deepEqual(duplicateKeys(MERGED_PROPERTIES), ["server.forward-headers-strategy"]);
  assert.ok(!conflictPaths(MERGE_TREE_OUTPUT).some((p) => p.endsWith("application.properties")));
});

test("properties parsing ignores comments and accepts both separators", () => {
  assert.deepEqual(duplicateKeys("# a=1\n\n  ! a=2\na=3\n"), [], "commented duplicates are not duplicates");
  assert.deepEqual(duplicateKeys("a=1\na: 2\n"), ["a"], "= and : name the same key");
  assert.deepEqual(duplicateKeys("a=1\nb=2\n"), []);
  assert.deepEqual(duplicateKeys("a=1\na=2\na=3\n"), ["a"], "three definitions are reported once");
});

test("two files claiming one Flyway version are found, one file is not", () => {
  const base = "apps/backend/src/main/resources/db/migration/";
  assert.deepEqual(
    duplicateVersions([`${base}V22__reopen_event_grants.sql`, `${base}V22__statistics.sql`]),
    ["22"],
  );
  assert.deepEqual(
    duplicateVersions([`${base}V22__reopen_event_grants.sql`, `${base}V23__other.sql`]),
    [],
  );
  assert.deepEqual(
    duplicateVersions([`${base}V22__a.sql`, `${base}V22__a.sql`]),
    [],
    "the same path seen twice is one migration, not two",
  );
  assert.deepEqual(duplicateVersions(["docs/V22__notes.md", "README.md"]), [], "only migrations count");
});

test("open merge requests carry the head sha the virtual merge needs", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mmp-cross-test-"));
  const mattermost = new MattermostService({ dataDir, allowHttp: true });
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(new URL(url).pathname + new URL(url).search);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          { project_id: 42, iid: 184, title: "MR 184", sha: "a".repeat(40), source_branch: "feat/a" },
          { project_id: 42, iid: 104, title: "MR 104", sha: "b".repeat(40), source_branch: "feat/b" },
        ]),
    };
  };

  try {
    const gitlab = new GitLabService({ db: mattermost.db, allowHttp: true, fetchImpl });
    gitlab.createSite({ name: "ssafy", baseUrl: "https://gitlab.test", token: TOKEN });

    const open = await gitlab.listOpenMergeRequests({ siteName: "ssafy", projectId: 42 });
    assert.equal(open.count, 2);
    assert.deepEqual(
      open.mergeRequests.map((item) => item.headSha),
      ["a".repeat(40), "b".repeat(40)],
    );
    assert.deepEqual(open.mergeRequests.map((item) => item.mrIid), [184, 104]);
    assert.match(requested[0], /^\/api\/v4\/projects\/42\/merge_requests\?state=opened/);

    // reviewInbox only sees what the token owner reviews, which is why this exists.
    assert.notEqual(gitlab.listOpenMergeRequests, gitlab.reviewInbox);

    for (const limit of [0, 101, 2.5, "many"]) {
      await assert.rejects(
        gitlab.listOpenMergeRequests({ siteName: "ssafy", projectId: 42, limit }),
        /limit must be an integer/,
      );
    }
  } finally {
    mattermost.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// The shape that motivated this rule: !194 moved Airflow to 3.2.2 and pinned the
// Airflow 3 SSH provider; !159, open at the same time, added the Airflow 2 one.
// git did conflict on this particular pair, because both edits landed in the
// same few lines of a four-line file. Appended a few lines apart it would have
// merged clean and pip would have been handed two pins for one package.
const MERGED_REQUIREMENTS = `apache-airflow==3.2.2
apache-airflow-providers-fab==3.6.4
apache-airflow-providers-ssh==5.0.2
apache-airflow-providers-standard==1.13.1
apache-airflow-providers-ssh==4.1.6
`;

test("one package pinned twice in a merged requirements file is found", () => {
  assert.deepEqual(duplicateRequirements(MERGED_REQUIREMENTS), ["apache-airflow-providers-ssh"]);
  // The neighbouring pins share a prefix and must not be mistaken for it.
  assert.deepEqual(
    duplicateRequirements("apache-airflow==3.2.2\napache-airflow-providers-ssh==5.0.2\n"),
    [],
  );
});

test("packages are compared the way pip compares them, not as written", () => {
  assert.deepEqual(duplicateRequirements("Apache_Airflow==3.2.2\napache-airflow==3.0.0\n"), [
    "apache-airflow",
  ], "case and -_. runs do not make two projects");
  assert.deepEqual(duplicateRequirements("pkg[ssh]==1.0\npkg>=2,<3\n"), ["pkg"], "extras and ranges still name pkg");
  assert.deepEqual(duplicateRequirements("pkg @ https://example.test/pkg.whl\npkg==1.0\n"), ["pkg"]);
  assert.deepEqual(duplicateRequirements("pkg==1.0\npkg==1.0\npkg==1.0\n"), ["pkg"], "reported once");
});

test("the same package under two environment markers is deliberate", () => {
  const text = 'pkg==1.0; sys_platform == "win32"\npkg==2.0; sys_platform == "linux"\n';
  assert.deepEqual(duplicateRequirements(text), [], "different markers select different machines");
  const same = 'pkg==1.0; python_version < "3.11"\npkg==2.0; python_version   <   "3.11"\n';
  assert.deepEqual(duplicateRequirements(same), ["pkg"], "the same marker, respaced, is the same condition");
});

test("comments, options and blank lines name no package", () => {
  const text = [
    "# pinned by the platform team",
    "",
    "-r base.txt",
    "--index-url https://example.test/simple",
    "-e .",
    "pkg==1.0  # keep until the resolver lands",
    "pkg==2.0",
  ].join("\n");
  assert.deepEqual(duplicateRequirements(text), ["pkg"]);
  assert.deepEqual(duplicateRequirements("# pkg==1.0\n# pkg==2.0\n"), [], "commented pins are not pins");
});

test("VCS and URL lines are only duplicates when they name the same project", () => {
  const text = "git+https://example.test/a.git#egg=alpha\ngit+https://example.test/b.git#egg=beta\n";
  assert.deepEqual(duplicateRequirements(text), [], "two checkouts are not one package called git");
  assert.deepEqual(
    duplicateRequirements("git+https://example.test/a.git#egg=alpha\nalpha==1.0\n"),
    ["alpha"],
  );
});

test("a hash continuation does not hide the package on the following line", () => {
  const text = "pkg==1.0 \\n    --hash=sha256:aaa\nother==2.0\npkg==3.0\n";
  assert.deepEqual(duplicateRequirements(text), ["pkg"]);
});
