import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MattermostService } from "../src/core.js";

test("CRUD, template rendering, secret redaction, and webhook delivery", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mattermost-manager-test-"));
  let received;
  const mock = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.writeHead(200).end("ok");
    });
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const { port } = mock.address();
  const service = new MattermostService({ dataDir, allowHttp: true });

  try {
    const secret = `http://127.0.0.1:${port}/hooks/super-secret-token`;
    service.createWebhook({ name: "특화-프로젝트", webhookUrl: secret });
    const listedWebhook = service.listWebhooks()[0];
    assert.equal(listedWebhook.name, "특화-프로젝트");
    assert.equal(JSON.stringify(listedWebhook).includes("super-secret-token"), false);

    service.createChannel({ name: "나에게 보내기", webhookName: "특화-프로젝트", mattermostChannel: "dev-alerts" });
    service.updateChannel({ name: "나에게 보내기", username: "Codex" });
    service.createParticipant({
      displayName: "김동혁",
      mattermostUsername: "qaz000219",
      gitlabUsername: "kdHyeok",
      isSelf: true,
    });
    service.addChannelMember({ channelName: "나에게 보내기", mattermostUsername: "qaz000219" });
    service.addChannelMember({
      channelName: "나에게 보내기",
      displayName: "리뷰 요청자",
      mattermostUsername: "reviewer.mm",
      gitlabUsername: "review-author",
    });
    service.createParticipant({ displayName: "이동혁", mattermostUsername: "other.dh" });
    const requester = service.listParticipants({ channelName: "나에게 보내기", gitlabUsername: "REVIEW-AUTHOR" })[0];
    assert.equal(requester.mention, "@reviewer.mm");
    assert.deepEqual(requester.channels, ["나에게 보내기"]);
    assert.equal(service.listParticipants({ channelName: "나에게 보내기", displayName: "리뷰 요청자" })[0].mattermostUsername, "reviewer.mm");
    assert.equal(service.listParticipants({ nameQuery: "동혁" }).length, 2);
    assert.equal(service.listParticipants({ selfOnly: true })[0].mention, "@qaz000219");
    assert.throws(() => service.createParticipant({
      displayName: "다른 본인",
      mattermostUsername: "other-self",
      isSelf: true,
    }), /self participant/);
    service.updateParticipant({ mattermostUsername: "reviewer.mm", newMattermostUsername: "requester.mm" });
    assert.equal(service.listParticipants({ gitlabUsername: "review-author" })[0].mention, "@requester.mm");
    service.removeChannelMember({ channelName: "나에게 보내기", mattermostUsername: "requester.mm" });
    assert.deepEqual(service.listParticipants({ mattermostUsername: "requester.mm" })[0].channels, []);
    service.createConvention({ name: "deploy_ok", template: "✅ {{service}} {{version}} deployed" });
    service.createConvention({
      name: "review-request",
      template: "{{mention}} :merge_please: !{{mr_number}} | [{{jira_key}}] {{message}}",
    });
    service.updateConvention({ name: "deploy_ok", description: "Successful deployment" });
    assert.deepEqual(service.listConventions({ name: "deploy_ok" })[0].variables, ["service", "version"]);
    assert.equal(service.previewMessage({ conventionName: "deploy_ok", variables: { service: "api", version: "v1" } }).text, "✅ api v1 deployed");

    const dm = await service.sendDirectMessage({
      participantId: requester.id,
      viaChannelName: "나에게 보내기",
      text: "DM hello",
    });
    assert.equal(dm.ok, true);
    assert.deepEqual(received, { text: "DM hello", channel: "@requester.mm", username: "Codex" });

    await service.sendDirectMessage({
      participantId: requester.id,
      viaChannelName: "나에게 보내기",
      text: "리뷰 회의는 오후 3시입니다.",
    });
    assert.equal(received.text, "리뷰 회의는 오후 3시입니다.");

    const reviewDm = await service.sendDirectMessage({
      participantId: requester.id,
      viaChannelName: "나에게 보내기",
      conventionName: "review-request",
      variables: {
        mention: "@requester.mm",
        mr_number: 124,
        jira_key: "S15P21C206-124",
        message: "리뷰 부탁드립니당.",
      },
    });
    assert.equal(reviewDm.ok, true);
    assert.deepEqual(received, {
      text: "@requester.mm :merge_please: !124 | [S15P21C206-124] 리뷰 부탁드립니당.",
      channel: "@requester.mm",
      username: "Codex",
    });
    await assert.rejects(
      service.sendDirectMessage({
        participantId: requester.id,
        viaChannelName: "나에게 보내기",
        conventionName: "review-request",
        variables: {
          mention: "@qaz000219",
          mr_number: 124,
          jira_key: "S15P21C206-124",
          message: "리뷰 부탁드립니당.",
        },
      }),
      /mention must match the selected participant/,
    );
    await assert.rejects(
      service.sendDirectMessage({
        participantId: requester.id,
        viaChannelName: "나에게 보내기",
        text: "성용이형, MR !124 리뷰 부탁드립니다.",
      }),
      /Review messages must use convention_name/,
    );
    assert.throws(() => service.previewMessage({
      conventionName: "review-request",
      variables: {
        mention: "성용이형",
        mr_number: 124,
        jira_key: "S15P21C206-124",
        message: "리뷰 부탁드립니당.",
      },
    }), /mention must start with @/);

    const sent = await service.sendMessage({
      channelNames: ["나에게 보내기"],
      conventionName: "deploy_ok",
      variables: { service: "api", version: "v1" },
    });
    assert.equal(sent.ok, true);
    assert.deepEqual(received, { text: "✅ api v1 deployed", channel: "dev-alerts", username: "Codex" });
    assert.throws(() => service.deleteWebhook({ name: "특화-프로젝트" }), /used by channels/);

    service.deleteChannel({ name: "나에게 보내기" });
    service.deleteParticipant({ mattermostUsername: "qaz000219" });
    service.deleteParticipant({ mattermostUsername: "requester.mm" });
    service.deleteParticipant({ mattermostUsername: "other.dh" });
    service.deleteConvention({ name: "deploy_ok" });
    service.deleteConvention({ name: "review-request" });
    service.deleteWebhook({ name: "특화-프로젝트" });
    assert.deepEqual(service.listWebhooks(), []);
  } finally {
    service.close();
    await new Promise((resolve) => mock.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
