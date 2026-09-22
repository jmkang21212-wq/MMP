import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MattermostService } from "../src/core.js";
import { GitLabService } from "../src/gitlab.js";

const TOKEN = "glpat-0123456789abcdefghij";

function fakeGitLab() {
  const calls = [];
  const awards = [];
  const notes = [];
  const respond = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  });
  const fetchImpl = async (url, options = {}) => {
    const { pathname, search } = new URL(url);
    const path = pathname.replace("/api/v4/", "");
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, search, method, token: options.headers?.["PRIVATE-TOKEN"] });

    if (path === "user") return respond(200, { id: 7, username: "kdHyeok", name: "김동혁" });
    if (path === "merge_requests") {
      return respond(200, [{
        id: 900, iid: 124, project_id: 42, title: "feat: add review flow",
        author: { username: "yunsy", name: "윤성용" }, source_branch: "feat/x", target_branch: "develop",
        draft: false, web_url: "https://gitlab.test/g/p/-/merge_requests/124", updated_at: "2026-09-22T00:00:00Z",
      }]);
    }
    if (path === "projects/42/merge_requests/124") {
      return respond(200, {
        id: 900, iid: 124, project_id: 42, title: "feat: add review flow",
        author: { username: "yunsy", name: "윤성용" }, source_branch: "feat/x", target_branch: "develop",
        web_url: "https://gitlab.test/g/p/-/merge_requests/124", updated_at: "2026-09-22T00:00:00Z",
        description: "MR body",
        diff_refs: { base_sha: "base1", start_sha: "start1", head_sha: "head1" },
      });
    }
    if (path === "projects/42/merge_requests/124/diffs") {
      return respond(200, [
        { new_path: "src/a.js", old_path: "src/a.js", diff: "@@ -1 +1 @@\n-old\n+new\n" },
        { new_path: "src/big.js", old_path: "src/big.js", diff: "x".repeat(20_000) },
      ]);
    }
    if (path === "projects/42/merge_requests/124/discussions" && method === "GET") {
      return respond(200, [{
        id: "d1",
        notes: [
          { id: 1, system: true, body: "changed title", author: { username: "yunsy" } },
          { id: 2, system: false, body: "여기 확인 부탁", author: { username: "yunsy" }, resolved: false, created_at: "2026-09-21T00:00:00Z", position: { new_path: "src/a.js", new_line: 3 } },
        ],
      }]);
    }
    if (path === "projects/42/merge_requests/124/discussions" && method === "POST") {
      notes.push(body);
      return respond(201, { id: "d2", notes: [{ id: 33, web_url: "https://gitlab.test/note/33" }] });
    }
    if (path === "projects/42/merge_requests/124/award_emoji" && method === "GET") {
      return respond(200, awards.slice());
    }
    if (path === "projects/42/merge_requests/124/award_emoji" && method === "POST") {
      awards.push({ id: awards.length + 1, name: body.name, user: { id: 7, username: "kdHyeok" } });
      return respond(201, awards.at(-1));
    }
    if (path === "projects/42/merge_requests/124/notes" && method === "POST") {
      notes.push(body);
      return respond(201, { id: 55, web_url: "https://gitlab.test/note/55" });
    }
    if (path === "projects/42/merge_requests/999") return respond(404, { message: "404 Not found" });
    if (path === "projects/42/merge_requests/401") return respond(401, { message: "401 Unauthorized" });
    return respond(404, { message: `unexpected ${method} ${path}` });
  };
  return { fetchImpl, calls, awards, notes };
}

test("GitLab review inbox, ack, diff fetch, and note posting", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mmp-gitlab-test-"));
  const mattermost = new MattermostService({ dataDir, allowHttp: true });
  const fake = fakeGitLab();
  const gitlab = new GitLabService({ db: mattermost.db, fetchImpl: fake.fetchImpl });

  try {
    const site = gitlab.createSite({ name: "ssafy", baseUrl: "https://gitlab.test", token: TOKEN });
    assert.equal(site.baseUrl, "https://gitlab.test/");
    assert.equal(JSON.stringify(gitlab.listSites()).includes(TOKEN), false);
    assert.equal(gitlab.listSites()[0].tokenStored, true);
    assert.throws(() => gitlab.createSite({ name: "http", baseUrl: "http://gitlab.test", token: TOKEN }), /must use HTTPS/);
    assert.throws(() => gitlab.createSite({ name: "short", baseUrl: "https://gitlab.test", token: "abc" }), /20-256 characters/);

    const first = await gitlab.reviewInbox({});
    assert.equal(first.reviewer.username, "kdHyeok");
    assert.equal(first.newCount, 1);
    assert.equal(first.mergeRequests[0].isNew, true);
    assert.equal(first.mergeRequests[0].acked, false);
    assert.equal(first.mergeRequests[0].reference, "!124");
    assert.equal(fake.calls.at(-1).token, TOKEN);

    const second = await gitlab.reviewInbox({});
    assert.equal(second.newCount, 0);
    assert.equal(second.mergeRequests[0].isNew, false);

    const acked = await gitlab.acknowledgeMergeRequest({ projectId: 42, mrIid: 124 });
    assert.equal(acked.alreadyAcknowledged, false);
    assert.deepEqual(fake.awards.map((award) => award.name), ["eyes"]);
    const again = await gitlab.acknowledgeMergeRequest({ projectId: 42, mrIid: 124 });
    assert.equal(again.alreadyAcknowledged, true);
    assert.equal(fake.awards.length, 1);
    assert.equal((await gitlab.reviewInbox({})).mergeRequests[0].acked, true);

    const changes = await gitlab.mergeRequestChanges({ projectId: 42, mrIid: 124 });
    assert.equal(changes.fileCount, 2);
    assert.equal(changes.files[0].diff.includes("+new"), true);
    assert.equal(changes.files[1].truncated, true);
    assert.equal(changes.diffTruncated, true);
    assert.equal(changes.diffRefs.head_sha, "head1");
    assert.equal(changes.discussions.length, 1);
    assert.equal(changes.discussions[0].line, 3);

    const note = await gitlab.createNote({ projectId: 42, mrIid: 124, body: "전반적으로 좋습니다." });
    assert.equal(note.scope, "merge_request");
    assert.equal(note.noteId, 55);
    const lineNote = await gitlab.createNote({ projectId: 42, mrIid: 124, body: "null 체크가 필요합니다.", filePath: "src/a.js", line: 3 });
    assert.equal(lineNote.scope, "line");
    assert.equal(fake.notes.at(-1).position.head_sha, "head1");
    assert.equal(fake.notes.at(-1).position.new_line, 3);
    await assert.rejects(
      gitlab.createNote({ projectId: 42, mrIid: 124, body: "x", filePath: "src/a.js" }),
      /Provide both file_path and line/,
    );

    const reviewed = await gitlab.reviewInbox({});
    assert.equal(typeof reviewed.mergeRequests[0].reviewedAt, "string");
    assert.equal(reviewed.mergeRequests[0].changedSinceReview, false);

    await assert.rejects(gitlab.mergeRequestChanges({ projectId: 42, mrIid: 999 }), /HTTP 404/);
    await assert.rejects(gitlab.mergeRequestChanges({ projectId: 42, mrIid: 401 }), /rejected the stored token/);

    gitlab.createSite({ name: "second", baseUrl: "https://other.test", token: TOKEN });
    await assert.rejects(gitlab.reviewInbox({}), /Multiple GitLab sites/);
    await assert.rejects(gitlab.reviewInbox({ siteName: "missing" }), /does not exist/);

    gitlab.updateSite({ name: "second", token: `${TOKEN}-rotated` });
    gitlab.deleteSite({ name: "second" });
    assert.equal(gitlab.listSites().length, 1);
  } finally {
    mattermost.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
