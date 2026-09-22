import { parseArgs } from "node:util";
import { MattermostService, UserError } from "../src/core.js";
import { GitLabService } from "../src/gitlab.js";

const REASON_LABELS = new Map([
  ["review_requested", "리뷰어 지정"],
  ["directly_addressed", "멘션"],
  ["mentioned", "언급"],
]);

const { values } = parseArgs({
  options: {
    site: { type: "string" },
    via: { type: "string" },
    interval: { type: "string", default: "300" },
    once: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const intervalSeconds = Number(values.interval);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 30) {
  fail("--interval must be at least 30 seconds.");
}

const mattermost = new MattermostService();
const gitlab = new GitLabService({ db: mattermost.db });

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function resolveSelf() {
  const self = mattermost.listParticipants({ selfOnly: true })[0];
  if (!self) fail("No self participant is registered. Register yourself with participant_create first.");
  return self;
}

function resolveChannel() {
  if (values.via) return values.via;
  const enabled = mattermost.listChannels().filter((channel) => channel.enabled);
  if (!enabled.length) fail("No enabled logical channel is registered. Pass --via or register one first.");
  if (enabled.length > 1) {
    fail(`Several channels are enabled: ${enabled.map((channel) => channel.name).join(", ")}. Pass --via to choose one.`);
  }
  return enabled[0].name;
}

function resolveSite() {
  if (values.site) return values.site;
  const sites = gitlab.listSites();
  if (!sites.length) fail("No GitLab site is registered. Register one with gitlab_site_create first.");
  if (sites.length > 1) {
    fail(`Several GitLab sites are registered: ${sites.map((site) => site.name).join(", ")}. Pass --site to choose one.`);
  }
  return sites[0].name;
}

// Deliberately avoids the words that core.js blocks in free-text messages so the
// notification is never mistaken for a review request. See the guard test.
function notificationText(items) {
  const lines = items.map((item) => {
    const reasons = item.reasons.map((reason) => REASON_LABELS.get(reason) ?? reason).join(", ");
    const author = item.author?.name ?? item.author?.username ?? "작성자 미상";
    return `!${item.mrIid} ${author} [${reasons}] ${item.title ?? ""}\n${item.webUrl ?? ""}`;
  });
  return `:eyes: 리뷰 대기 ${items.length}건\n\n${lines.join("\n\n")}`;
}

async function tick(siteName, viaChannel, self) {
  const items = (await gitlab.reviewQueue({ siteName, track: false })).mergeRequests;
  const pending = items.filter((item) => !item.notified);
  if (!pending.length) {
    log(`no new merge requests (${items.length} open, all already notified)`);
    return;
  }
  const text = notificationText(pending);
  if (values["dry-run"]) {
    log(`dry run, would notify @${self.mattermostUsername} via '${viaChannel}':\n${text}`);
    return;
  }
  await mattermost.sendDirectMessage({ participantId: self.id, viaChannelName: viaChannel, text });
  gitlab.markNotified({ siteName, mergeRequests: pending });
  log(`notified @${self.mattermostUsername} about ${pending.length} merge request(s): ${pending.map((item) => `!${item.mrIid}`).join(", ")}`);
}

const site = resolveSite();
const via = resolveChannel();
const me = resolveSelf();
log(`watching GitLab '${site}' todos, notifying @${me.mattermostUsername} via '${via}' every ${intervalSeconds}s`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    log("stopping");
    mattermost.close();
    process.exit(0);
  });
}

while (!stopping) {
  try {
    await tick(site, via, me);
  } catch (error) {
    const message = error instanceof UserError ? error.message : "Unexpected watcher error.";
    log(`error: ${message}`);
    if (error instanceof UserError && error.message.includes("token")) {
      mattermost.close();
      fail("Stopping: the stored GitLab token was rejected. Replace it with gitlab_site_update.");
    }
  }
  if (values.once) break;
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
}

mattermost.close();
