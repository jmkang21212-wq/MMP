import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MattermostService } from "../src/core.js";
import { GitLabService } from "../src/gitlab.js";

const TOKEN = "glpat-0123456789abcdefghij";

function todo(id, action, iid, state = "opened", author = "tmdtkr") {
  return {
    id,
    action_name: action,
    target_type: "MergeRequest",
    project: { id: 42, path_with_namespace: "g/p" },
    author: { username: author, name: author },
    target: {
      iid,
      title: `MR ${iid}`,
      state,
      web_url: `https://gitlab.test/g/p/-/merge_requests/${iid}`,
      updated_at: "2026-09-22T00:00:00Z",
      author: { username: "tmdtkr", name: "백승학" },
    },
  };
}

function fakeGitLab(todos) {
  const done = [];
  const respond = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  });
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname.replace("/api/v4/", "");
    const method = options.method ?? "GET";
    if (path === "todos") return respond(200, todos);
    if (path === "todos/901/mark_as_done" && method === "POST") {
      done.push(901);
      return respond(200, { id: 901, state: "done" });
    }
    if (path === "todos/999/mark_as_done") return respond(404, { message: "404 Not found" });
    return respond(404, { message: `unexpected ${method} ${path}` });
  };
  return { fetchImpl, done };
}

test("todo inbox groups reasons, skips closed merge requests, and tracks notification separately", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mmp-todo-test-"));
  const mattermost = new MattermostService({ dataDir, allowHttp: true });
  const fake = fakeGitLab([
    todo(901, "review_requested", 170),
    todo(902, "directly_addressed", 170),
    todo(903, "mentioned", 169),
    todo(904, "review_requested", 132, "merged"),
    todo(905, "assigned", 120),
    { id: 906, action_name: "mentioned", target_type: "Issue", project: { id: 42 }, target: { iid: 5, state: "opened" } },
  ]);
  const gitlab = new GitLabService({ db: mattermost.db, fetchImpl: fake.fetchImpl });

  try {
    gitlab.createSite({ name: "ssafy", baseUrl: "https://gitlab.test", token: TOKEN });

    const inbox = await gitlab.todoInbox({});
    assert.equal(inbox.count, 2, "merged MR, assigned todo, and issue todo are excluded");
    const first = inbox.mergeRequests.find((item) => item.mrIid === 170);
    assert.deepEqual(first.reasons, ["review_requested", "directly_addressed"], "two todos on one MR collapse into one entry");
    assert.deepEqual(first.todoIds, [901, 902]);
    assert.equal(first.isNew, true);
    assert.equal(first.notified, false);
    assert.equal(inbox.newCount, 2);

    const merged = await gitlab.todoInbox({ includeClosed: true });
    assert.equal(merged.count, 3, "include_closed brings the merged MR back");

    const filtered = await gitlab.todoInbox({ actions: ["mentioned"] });
    assert.deepEqual(filtered.mergeRequests.map((item) => item.mrIid), [169]);

    // The watcher polls with track:false so a later session still reports isNew.
    const untracked = new GitLabService({ db: mattermost.db, fetchImpl: fake.fetchImpl });
    const peeked = await untracked.todoInbox({ siteName: "ssafy", track: false });
    assert.equal(peeked.mergeRequests.every((item) => item.notified === false), true);
    untracked.markNotified({ siteName: "ssafy", mergeRequests: peeked.mergeRequests });
    const afterNotify = await untracked.todoInbox({ siteName: "ssafy", track: false });
    assert.equal(afterNotify.mergeRequests.every((item) => item.notified), true, "notified survives");
    assert.equal(afterNotify.mergeRequests.every((item) => item.isNew === false), true);

    const doneResult = await gitlab.markTodoDone({ todoId: 901 });
    assert.equal(doneResult.alreadyDone, false);
    assert.deepEqual(fake.done, [901]);
    const repeat = await gitlab.markTodoDone({ todoId: 999 });
    assert.equal(repeat.alreadyDone, true, "a todo already cleared elsewhere is not an error");
    await assert.rejects(gitlab.markTodoDone({ todoId: -1 }), /positive integer/);
  } finally {
    mattermost.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("watcher notification text survives the free-text review guard", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mmp-watcher-test-"));
  const service = new MattermostService({ dataDir, allowHttp: true });
  let received;
  const sent = [];
  service.fetch = async (url, options) => {
    received = JSON.parse(options.body);
    sent.push(received);
    return { ok: true, status: 200, body: null };
  };

  try {
    service.createWebhook({ name: "hook", webhookUrl: "http://127.0.0.1:1/hooks/secret-token" });
    service.createChannel({ name: "alerts", webhookName: "hook" });
    const self = service.createParticipant({
      displayName: "강재민",
      mattermostUsername: "jmkang21212",
      gitlabUsername: "jmkang21212",
      isSelf: true,
    });

    // Mirrors notificationText() in scripts/review-watcher.mjs.
    const text = ":eyes: 리뷰 대기 2건\n\n!170 백승학 [리뷰어 지정] 통계 API\nhttps://gitlab.test/g/p/-/merge_requests/170";
    const dm = await service.sendDirectMessage({ participantId: self.id, viaChannelName: "alerts", text });
    assert.equal(dm.ok, true);
    assert.equal(received.channel, "@jmkang21212");
    assert.equal(received.text.includes("리뷰 대기"), true);

    // The guard exists so review requests always go through a convention.
    await assert.rejects(
      service.sendDirectMessage({ participantId: self.id, viaChannelName: "alerts", text: ":eyes: 새 리뷰 요청 2건" }),
      /Review messages must use convention_name/,
      "wording that reads as a review request must stay blocked",
    );
  } finally {
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
