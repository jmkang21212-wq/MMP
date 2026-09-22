import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MattermostService } from "../src/core.js";
import { GitLabService } from "../src/gitlab.js";

const TOKEN = "glpat-0123456789abcdefghij";
const FIRST = "a".repeat(40);
const SECOND = "b".repeat(40);

function open() {
  const dataDir = mkdtempSync(join(tmpdir(), "mmp-findings-"));
  const mattermost = new MattermostService({ dataDir, allowHttp: true });
  const gitlab = new GitLabService({ db: mattermost.db, allowHttp: true, fetchImpl: async () => {
    throw new Error("the ledger must not reach the network");
  } });
  gitlab.createSite({ name: "ssafy", baseUrl: "https://gitlab.test", token: TOKEN });
  return { gitlab, close: () => { mattermost.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("an objection survives the session that raised it, with the head and paths to diff later", () => {
  const { gitlab, close } = open();
  try {
    const recorded = gitlab.recordFindings({
      siteName: "ssafy", projectId: 42, mrIid: 184, headSha: FIRST,
      findings: [
        {
          summary: "completedWithoutPlanets가 공개 기준 개수로 뒤집힌다",
          paths: ["apps/backend/src/.../PublicSkyRepository.java", "apps/frontend/src/features/public-sky/contracts.ts"],
          blocking: true,
        },
        { summary: "지문 비용이 소유자 전체 규모에 비례한다", paths: [] },
      ],
    });
    assert.equal(recorded.recorded, 2);

    const before = gitlab.listFindings({ siteName: "ssafy", projectId: 42, mrIid: 184 });
    assert.equal(before.openCount, 2);
    assert.equal(before.blockingCount, 1, "only the blocking one counts as blocking");
    // The pair a re-review needs: what to diff from, and what to intersect with.
    assert.equal(before.findings[0].headSha, FIRST);
    assert.deepEqual(before.findings[0].paths, [
      "apps/backend/src/.../PublicSkyRepository.java",
      "apps/frontend/src/features/public-sky/contracts.ts",
    ]);
    // An objection about the merge request itself has no paths and cannot be
    // checked by diffing. It is still worth remembering.
    assert.deepEqual(before.findings[1].paths, []);

    const resolved = gitlab.resolveFindings({ siteName: "ssafy", ids: [before.findings[0].id], headSha: SECOND });
    assert.equal(resolved.resolved, 1);

    const after = gitlab.listFindings({ siteName: "ssafy", projectId: 42, mrIid: 184 });
    assert.equal(after.openCount, 1);
    assert.equal(after.blockingCount, 0);
    assert.deepEqual(after.findings.map((item) => item.summary), ["지문 비용이 소유자 전체 규모에 비례한다"]);

    const all = gitlab.listFindings({ siteName: "ssafy", projectId: 42, mrIid: 184, includeResolved: true });
    assert.equal(all.findings.length, 2);
    assert.equal(all.findings[0].resolvedHeadSha, SECOND, "the commit that closed it stays checkable");
  } finally {
    close();
  }
});

test("resolving twice does not count twice and other merge requests are untouched", () => {
  const { gitlab, close } = open();
  try {
    const mine = gitlab.recordFindings({
      siteName: "ssafy", projectId: 42, mrIid: 184, headSha: FIRST,
      findings: [{ summary: "first" }],
    });
    gitlab.recordFindings({
      siteName: "ssafy", projectId: 42, mrIid: 185, headSha: FIRST,
      findings: [{ summary: "other merge request" }],
    });

    assert.equal(gitlab.resolveFindings({ siteName: "ssafy", ids: mine.ids }).resolved, 1);
    const again = gitlab.resolveFindings({ siteName: "ssafy", ids: mine.ids });
    assert.equal(again.resolved, 0, "already closed");
    assert.equal(again.requested, 1, "the caller still learns what it asked for");

    assert.equal(gitlab.listFindings({ siteName: "ssafy", projectId: 42, mrIid: 185 }).openCount, 1);
  } finally {
    close();
  }
});

test("a finding cannot be recorded against something other than a commit", () => {
  const { gitlab, close } = open();
  try {
    const base = { siteName: "ssafy", projectId: 42, mrIid: 184, findings: [{ summary: "x" }] };
    for (const headSha of ["", "HEAD", "main", "zzzz", "a".repeat(65)]) {
      assert.throws(() => gitlab.recordFindings({ ...base, headSha }), /head_sha must be/);
    }
    assert.throws(
      () => gitlab.recordFindings({ ...base, headSha: FIRST, findings: [] }),
      /non-empty array/,
    );
    for (const summary of ["", "   ", "x".repeat(501)]) {
      assert.throws(
        () => gitlab.recordFindings({ ...base, headSha: FIRST, findings: [{ summary }] }),
        /summary of 1-500/,
      );
    }
    assert.throws(
      () => gitlab.recordFindings({ ...base, headSha: FIRST, findings: [{ summary: "x", paths: ["  "] }] }),
      /must be repository paths/,
    );
    assert.throws(
      () => gitlab.recordFindings({ ...base, headSha: FIRST, findings: [{ summary: "x", paths: "one.ts" }] }),
      /must be repository paths/,
    );
  } finally {
    close();
  }
});

test("one site cannot close another site's findings", () => {
  const { gitlab, close } = open();
  try {
    gitlab.createSite({ name: "other", baseUrl: "https://other.test", token: TOKEN });
    const mine = gitlab.recordFindings({
      siteName: "ssafy", projectId: 42, mrIid: 184, headSha: FIRST,
      findings: [{ summary: "belongs to ssafy" }],
    });
    assert.equal(gitlab.resolveFindings({ siteName: "other", ids: mine.ids }).resolved, 0);
    assert.equal(gitlab.listFindings({ siteName: "ssafy", projectId: 42, mrIid: 184 }).openCount, 1);
  } finally {
    close();
  }
});
