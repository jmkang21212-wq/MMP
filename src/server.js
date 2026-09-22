import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { MattermostService, UserError } from "./core.js";
import { GitLabService } from "./gitlab.js";

const service = new MattermostService();
const gitlab = new GitLabService({ db: service.db });
const server = new McpServer({ name: "mmp", version: "0.2.5" });

const name = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u);
const nullableText = (max) => z.string().trim().min(1).max(max).nullable().optional();
const variables = z.record(z.string().max(64), z.union([z.string(), z.number(), z.boolean()]));
const username = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutate = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const remove = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function result(data, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError };
}

function messageFor(error) {
  if (error instanceof UserError) return error.message;
  if (String(error?.message).includes("UNIQUE constraint failed")) return "An item with that name already exists.";
  return "The Mattermost manager could not complete the request.";
}

const projectId = z.union([z.int().positive(), z.string().trim().min(1).max(512)]);
const mrIid = z.int().positive();
const siteName = name.optional();
const network = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const networkRead = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function register(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return result({ error: messageFor(error) }, true);
    }
  });
}

register("storage_info", {
  description: "Show the resolved local data directory and saved item counts for diagnosing shared Codex/Claude storage.",
  inputSchema: z.object({}), annotations: readOnly,
}, () => ({
  dataDir: service.dataDir,
  counts: {
    webhooks: service.listWebhooks().length,
    channels: service.listChannels().length,
    participants: service.listParticipants().length,
    conventions: service.listConventions().length,
  },
}));

register("webhook_create", {
  description: "Register a Mattermost incoming webhook. The secret URL is stored locally and never returned by read tools.",
  inputSchema: z.object({ name, webhook_url: z.url().max(2048) }), annotations: mutate,
}, ({ name, webhook_url }) => service.createWebhook({ name, webhookUrl: webhook_url }));

register("webhook_list", {
  description: "List registered webhook names and redacted endpoints.",
  inputSchema: z.object({ name: name.optional() }), annotations: readOnly,
}, (args) => service.listWebhooks(args));

register("webhook_update", {
  description: "Rename a registered webhook or replace its secret URL.",
  inputSchema: z.object({ name, new_name: name.optional(), webhook_url: z.url().max(2048).optional() })
    .refine((value) => value.new_name !== undefined || value.webhook_url !== undefined, "Provide new_name or webhook_url."),
  annotations: mutate,
}, ({ name, new_name, webhook_url }) => service.updateWebhook({ name, newName: new_name, webhookUrl: webhook_url }));

register("webhook_delete", {
  description: "Delete an unused webhook. Move or delete linked logical channels first.",
  inputSchema: z.object({ name }), annotations: remove,
}, (args) => service.deleteWebhook(args));

register("channel_create", {
  description: "Create a logical destination backed by a registered webhook. mattermost_channel overrides the webhook's default channel.",
  inputSchema: z.object({
    name,
    webhook_name: name,
    mattermost_channel: nullableText(128),
    username: nullableText(64),
    icon_url: z.url().max(2048).nullable().optional(),
    enabled: z.boolean().optional().default(true),
  }), annotations: mutate,
}, ({ name, webhook_name, mattermost_channel, username, icon_url, enabled }) => service.createChannel({
  name, webhookName: webhook_name, mattermostChannel: mattermost_channel, username, iconUrl: icon_url, enabled,
}));

register("channel_list", {
  description: "List logical Mattermost destinations. Omit name to list all.",
  inputSchema: z.object({ name: name.optional() }), annotations: readOnly,
}, (args) => service.listChannels(args));

register("channel_update", {
  description: "Update a logical Mattermost destination. Use null to clear an optional override.",
  inputSchema: z.object({
    name,
    new_name: name.optional(),
    webhook_name: name.optional(),
    mattermost_channel: nullableText(128),
    username: nullableText(64),
    icon_url: z.url().max(2048).nullable().optional(),
    enabled: z.boolean().optional(),
  }).refine((value) => Object.keys(value).some((key) => key !== "name"), "Provide at least one field to update."),
  annotations: mutate,
}, ({ name, new_name, webhook_name, mattermost_channel, username, icon_url, enabled }) => service.updateChannel({
  name, newName: new_name, webhookName: webhook_name, mattermostChannel: mattermost_channel, username, iconUrl: icon_url, enabled,
}));

register("channel_delete", {
  description: "Delete a logical Mattermost destination. This does not delete the Mattermost channel or webhook.",
  inputSchema: z.object({ name }), annotations: remove,
}, (args) => service.deleteChannel(args));

register("participant_create", {
  description: "Register a person for exact GitLab-to-Mattermost mention mapping. Usernames must omit @. Mark only the local user as is_self.",
  inputSchema: z.object({
    display_name: name,
    mattermost_username: username,
    gitlab_username: username.nullable().optional(),
    is_self: z.boolean().optional().default(false),
  }), annotations: mutate,
}, ({ display_name, mattermost_username, gitlab_username, is_self }) => service.createParticipant({
  displayName: display_name, mattermostUsername: mattermost_username, gitlabUsername: gitlab_username, isSelf: is_self,
}));

register("participant_list", {
  description: "List global participants and exact mentions. name_query performs a literal partial display-name match and may return multiple candidates.",
  inputSchema: z.object({
    channel_name: name.optional(),
    display_name: name.optional(),
    name_query: name.optional(),
    gitlab_username: username.optional(),
    mattermost_username: username.optional(),
    self_only: z.boolean().optional().default(false),
  }), annotations: readOnly,
}, ({ channel_name, display_name, name_query, gitlab_username, mattermost_username, self_only }) => service.listParticipants({
  channelName: channel_name, displayName: display_name, nameQuery: name_query, gitlabUsername: gitlab_username,
  mattermostUsername: mattermost_username, selfOnly: self_only,
}));

register("participant_update", {
  description: "Update a participant identity mapping. Use null to clear the GitLab username.",
  inputSchema: z.object({
    mattermost_username: username,
    display_name: name.optional(),
    new_mattermost_username: username.optional(),
    gitlab_username: username.nullable().optional(),
    is_self: z.boolean().optional(),
  }).refine((value) => Object.keys(value).some((key) => key !== "mattermost_username"), "Provide at least one field to update."),
  annotations: mutate,
}, ({ mattermost_username, display_name, new_mattermost_username, gitlab_username, is_self }) => service.updateParticipant({
  mattermostUsername: mattermost_username, displayName: display_name, newMattermostUsername: new_mattermost_username,
  gitlabUsername: gitlab_username, isSelf: is_self,
}));

register("participant_delete", {
  description: "Delete a participant identity mapping and its logical channel memberships.",
  inputSchema: z.object({ mattermost_username: username }), annotations: remove,
}, ({ mattermost_username }) => service.deleteParticipant({ mattermostUsername: mattermost_username }));

register("channel_member_add", {
  description: "Assign a global participant to a logical channel. If absent globally, display_name is required and the participant is created first. This does not change Mattermost server membership.",
  inputSchema: z.object({
    channel_name: name,
    mattermost_username: username,
    display_name: name.optional(),
    gitlab_username: username.nullable().optional(),
  }), annotations: mutate,
}, ({ channel_name, mattermost_username, display_name, gitlab_username }) => service.addChannelMember({
  channelName: channel_name, mattermostUsername: mattermost_username, displayName: display_name, gitlabUsername: gitlab_username,
}));

register("channel_member_remove", {
  description: "Remove a participant from a logical channel's local directory. This does not change Mattermost server membership.",
  inputSchema: z.object({ channel_name: name, mattermost_username: username }), annotations: remove,
}, ({ channel_name, mattermost_username }) => service.removeChannelMember({ channelName: channel_name, mattermostUsername: mattermost_username }));

register("convention_create", {
  description: "Create a reusable message template. Variables use {{variable_name}} syntax.",
  inputSchema: z.object({ name, template: z.string().min(1).max(16_000), description: nullableText(500) }), annotations: mutate,
}, (args) => service.createConvention(args));

register("convention_list", {
  description: "List message conventions and their required variable names. Omit name to list all.",
  inputSchema: z.object({ name: name.optional() }), annotations: readOnly,
}, (args) => service.listConventions(args));

register("convention_update", {
  description: "Update or rename a message convention. Use null to clear its description.",
  inputSchema: z.object({
    name,
    new_name: name.optional(),
    template: z.string().min(1).max(16_000).optional(),
    description: nullableText(500),
  }).refine((value) => Object.keys(value).some((key) => key !== "name"), "Provide at least one field to update."),
  annotations: mutate,
}, ({ name, new_name, template, description }) => service.updateConvention({ name, newName: new_name, template, description }));

register("convention_delete", {
  description: "Delete a message convention.",
  inputSchema: z.object({ name }), annotations: remove,
}, (args) => service.deleteConvention(args));

register("message_preview", {
  description: "Render a convention without sending it. Reserved review conventions enforce the canonical one-line mention format.",
  inputSchema: z.object({ convention_name: name, variables: variables.optional().default({}) }), annotations: readOnly,
}, ({ convention_name, variables }) => service.previewMessage({ conventionName: convention_name, variables }));

register("message_send", {
  description: "Send one rendered convention or direct text to saved logical channels. Review requests/completions must use review-request/review-complete, never direct text.",
  inputSchema: z.object({
    channel_names: z.array(name).min(1).max(20),
    convention_name: name.optional(),
    variables: variables.optional().default({}),
    text: z.string().min(1).max(16_000).optional(),
  }).refine((value) => Boolean(value.convention_name) !== Boolean(value.text), "Provide exactly one of convention_name or text."),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ channel_names, convention_name, variables, text }) => {
  const sent = await service.sendMessage({ channelNames: channel_names, conventionName: convention_name, variables, text });
  return sent;
});

register("message_send_dm", {
  description: "Send to one saved participant by id through a logical channel webhook. Review messages must use a review convention and the rendered body must still begin with the participant's @mention; the DM destination alone is not a mention.",
  inputSchema: z.object({
    participant_id: z.int().positive(),
    via_channel_name: name,
    convention_name: name.optional(),
    variables: variables.optional().default({}),
    text: z.string().min(1).max(16_000).optional(),
  }).refine((value) => Boolean(value.convention_name) !== Boolean(value.text), "Provide exactly one of convention_name or text."),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, ({ participant_id, via_channel_name, convention_name, variables, text }) => service.sendDirectMessage({
  participantId: participant_id,
  viaChannelName: via_channel_name,
  conventionName: convention_name,
  variables,
  text,
}));

register("gitlab_site_create", {
  description: "Register a GitLab instance and its personal access token (api scope). The token is stored locally and never returned by read tools.",
  inputSchema: z.object({ name, base_url: z.url().max(2048), token: z.string().min(20).max(256) }), annotations: mutate,
}, ({ name, base_url, token }) => gitlab.createSite({ name, baseUrl: base_url, token }));

register("gitlab_site_list", {
  description: "List registered GitLab instances. Tokens are never returned.",
  inputSchema: z.object({ name: name.optional() }), annotations: readOnly,
}, (args) => gitlab.listSites(args));

register("gitlab_site_update", {
  description: "Rename a GitLab instance, change its base URL, or replace an expired personal access token.",
  inputSchema: z.object({
    name,
    new_name: name.optional(),
    base_url: z.url().max(2048).optional(),
    token: z.string().min(20).max(256).optional(),
  }).refine((value) => Object.keys(value).some((key) => key !== "name"), "Provide new_name, base_url, or token."),
  annotations: mutate,
}, ({ name, new_name, base_url, token }) => gitlab.updateSite({ name, newName: new_name, baseUrl: base_url, token }));

register("gitlab_site_delete", {
  description: "Delete a registered GitLab instance and its local review tracking state.",
  inputSchema: z.object({ name }), annotations: remove,
}, (args) => gitlab.deleteSite(args));

register("gitlab_review_inbox", {
  description: "List open merge requests where the token owner is a reviewer. Marks each as new on first sight and reports whether it changed since the last review note.",
  inputSchema: z.object({ site_name: siteName, limit: z.int().min(1).max(100).optional().default(20) }),
  annotations: network,
}, ({ site_name, limit }) => gitlab.reviewInbox({ siteName: site_name, limit }));

register("gitlab_todo_inbox", {
  description: "List pending GitLab todos on merge requests: review requests, @mentions in a description, and @mentions in comments. Groups several todos on the same merge request and marks each as new on first sight. Closed and merged merge requests are excluded unless include_closed is set.",
  inputSchema: z.object({
    site_name: siteName,
    limit: z.int().min(1).max(100).optional().default(50),
    actions: z.array(z.enum(["review_requested", "directly_addressed", "mentioned", "assigned", "marked", "build_failed", "approval_required", "unmergeable"])).min(1).optional(),
    include_closed: z.boolean().optional().default(false),
  }), annotations: network,
}, ({ site_name, limit, actions, include_closed }) => gitlab.todoInbox({
  siteName: site_name, limit, actions, includeClosed: include_closed,
}));

register("gitlab_todo_done", {
  description: "Mark one GitLab todo as done so it stops appearing in the inbox. Use the todo ids returned by gitlab_todo_inbox after the merge request is handled.",
  inputSchema: z.object({ site_name: siteName, todo_id: z.int().positive() }), annotations: network,
}, ({ site_name, todo_id }) => gitlab.markTodoDone({ siteName: site_name, todoId: todo_id }));

register("gitlab_mr_changes", {
  description: "Fetch one merge request's metadata, diff, and existing discussions. Large diffs are truncated and flagged.",
  inputSchema: z.object({
    site_name: siteName,
    project_id: projectId,
    mr_iid: mrIid,
    include_discussions: z.boolean().optional().default(true),
  }), annotations: networkRead,
}, ({ site_name, project_id, mr_iid, include_discussions }) => gitlab.mergeRequestChanges({
  siteName: site_name, projectId: project_id, mrIid: mr_iid, includeDiscussions: include_discussions,
}));

register("gitlab_mr_ack", {
  description: "Add an award emoji to a merge request as the token owner, signalling the review was picked up. Safe to repeat.",
  inputSchema: z.object({
    site_name: siteName,
    project_id: projectId,
    mr_iid: mrIid,
    emoji: z.string().trim().min(1).max(64).optional().default("eyes"),
  }), annotations: network,
}, ({ site_name, project_id, mr_iid, emoji }) => gitlab.acknowledgeMergeRequest({
  siteName: site_name, projectId: project_id, mrIid: mr_iid, emoji,
}));

register("gitlab_note_create", {
  description: "Post a review comment on a merge request, visible to everyone with project access. Provide file_path and line together for a diff line comment. Only call this after the user approves the exact body.",
  inputSchema: z.object({
    site_name: siteName,
    project_id: projectId,
    mr_iid: mrIid,
    body: z.string().min(1).max(65_536),
    file_path: z.string().trim().min(1).max(1024).optional(),
    line: z.int().positive().optional(),
  }).refine((value) => (value.file_path === undefined) === (value.line === undefined), "Provide both file_path and line, or neither."),
  annotations: network,
}, ({ site_name, project_id, mr_iid, body, file_path, line }) => gitlab.createNote({
  siteName: site_name, projectId: project_id, mrIid: mr_iid, body, filePath: file_path, line,
}));

process.once("SIGINT", () => { service.close(); process.exit(0); });
process.once("SIGTERM", () => { service.close(); process.exit(0); });
void serveStdio(() => server);
