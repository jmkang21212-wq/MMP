import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { MattermostService, UserError } from "./core.js";

const service = new MattermostService();
const server = new McpServer({ name: "mattermost-manager", version: "0.1.0" });

const name = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u);
const nullableText = (max) => z.string().trim().min(1).max(max).nullable().optional();
const variables = z.record(z.string().max(64), z.union([z.string(), z.number(), z.boolean()]));
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

function register(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return result({ error: messageFor(error) }, true);
    }
  });
}

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
  description: "Render a convention without sending it. Fails when a required variable is missing.",
  inputSchema: z.object({ convention_name: name, variables: variables.optional().default({}) }), annotations: readOnly,
}, ({ convention_name, variables }) => service.previewMessage({ conventionName: convention_name, variables }));

register("message_send", {
  description: "Send one rendered convention or direct text to one or more saved logical channels. Returns a per-channel result.",
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

process.once("SIGINT", () => { service.close(); process.exit(0); });
process.once("SIGTERM", () => { service.close(); process.exit(0); });
void serveStdio(() => server);
