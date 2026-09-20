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
    service.createConvention({ name: "deploy_ok", template: "✅ {{service}} {{version}} deployed" });
    service.updateConvention({ name: "deploy_ok", description: "Successful deployment" });
    assert.deepEqual(service.listConventions({ name: "deploy_ok" })[0].variables, ["service", "version"]);
    assert.equal(service.previewMessage({ conventionName: "deploy_ok", variables: { service: "api", version: "v1" } }).text, "✅ api v1 deployed");

    const sent = await service.sendMessage({
      channelNames: ["나에게 보내기"],
      conventionName: "deploy_ok",
      variables: { service: "api", version: "v1" },
    });
    assert.equal(sent.ok, true);
    assert.deepEqual(received, { text: "✅ api v1 deployed", channel: "dev-alerts", username: "Codex" });
    assert.throws(() => service.deleteWebhook({ name: "특화-프로젝트" }), /used by channels/);

    service.deleteChannel({ name: "나에게 보내기" });
    service.deleteConvention({ name: "deploy_ok" });
    service.deleteWebhook({ name: "특화-프로젝트" });
    assert.deepEqual(service.listWebhooks(), []);
  } finally {
    service.close();
    await new Promise((resolve) => mock.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
