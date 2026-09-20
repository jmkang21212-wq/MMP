import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const NAME_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u;
const PLACEHOLDER_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g;
const MAX_MESSAGE_LENGTH = 16_000;

export class UserError extends Error {}

function now() {
  return new Date().toISOString();
}

function requireName(value, label = "name") {
  if (value.length > 64 || !NAME_PATTERN.test(value)) {
    throw new UserError(`${label} must start with a Unicode letter or number and contain only letters, numbers, internal spaces, dot, underscore, or hyphen (max 64).`);
  }
}

function resolveDataDir(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.MATTERMOST_MCP_DATA_DIR) return process.env.MATTERMOST_MCP_DATA_DIR;
  const base = process.env.LOCALAPPDATA || homedir();
  return join(base, "mattermost-manager-mcp");
}

function prepareDataDir(path) {
  mkdirSync(path, { recursive: true });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows uses the current user's inherited ACLs.
  }
}

function validateWebhookUrl(value, allowHttp) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UserError("webhook_url must be a valid URL.");
  }
  if (url.username || url.password || url.hash) {
    throw new UserError("webhook_url cannot contain credentials or a fragment.");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new UserError("webhook_url must use HTTPS. Set MATTERMOST_MCP_ALLOW_HTTP=1 only for a trusted local Mattermost server.");
  }
  return url.toString();
}

function redactWebhookUrl(value) {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length) parts[parts.length - 1] = "[redacted]";
  url.pathname = `/${parts.join("/")}`;
  url.search = "";
  return url.toString();
}

function variablesIn(template) {
  return [...new Set([...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]))];
}

export function renderTemplate(template, variables = {}) {
  const missing = variablesIn(template).filter((name) => !(name in variables));
  if (missing.length) {
    throw new UserError(`Missing template variables: ${missing.join(", ")}`);
  }
  const text = template.replace(PLACEHOLDER_PATTERN, (_, name) => String(variables[name]));
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new UserError(`Rendered message exceeds ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return text;
}

function affected(result, message) {
  if (Number(result.changes) === 0) throw new UserError(message);
}

export class MattermostService {
  constructor({ dataDir, allowHttp, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.dataDir = resolveDataDir(dataDir);
    this.allowHttp = allowHttp ?? process.env.MATTERMOST_MCP_ALLOW_HTTP === "1";
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    prepareDataDir(this.dataDir);
    this.db = new DatabaseSync(join(this.dataDir, "mattermost.sqlite3"));
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE RESTRICT,
        mattermost_channel TEXT,
        username TEXT,
        icon_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conventions (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        template TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    try {
      chmodSync(join(this.dataDir, "mattermost.sqlite3"), 0o600);
    } catch {
      // Windows uses the current user's inherited ACLs.
    }
  }

  close() {
    this.db.close();
  }

  createWebhook({ name, webhookUrl }) {
    requireName(name, "name");
    if (this.#webhook(name)) throw new UserError(`Webhook '${name}' already exists.`);
    const timestamp = now();
    this.db.prepare("INSERT INTO webhooks(name, url, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(name, validateWebhookUrl(webhookUrl, this.allowHttp), timestamp, timestamp);
    return this.listWebhooks({ name })[0];
  }

  listWebhooks({ name } = {}) {
    const rows = name
      ? this.db.prepare("SELECT name, url, created_at, updated_at FROM webhooks WHERE name = ?").all(name)
      : this.db.prepare("SELECT name, url, created_at, updated_at FROM webhooks ORDER BY name").all();
    return rows.map((row) => ({
      name: row.name,
      endpoint: redactWebhookUrl(row.url),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateWebhook({ name, newName, webhookUrl }) {
    requireName(name, "name");
    if (!this.#webhook(name)) throw new UserError(`Webhook '${name}' does not exist.`);
    if (newName !== undefined) requireName(newName, "new_name");
    if (newName && newName !== name && this.#webhook(newName)) throw new UserError(`Webhook '${newName}' already exists.`);
    const fields = [];
    const values = [];
    if (newName !== undefined) { fields.push("name = ?"); values.push(newName); }
    if (webhookUrl !== undefined) { fields.push("url = ?"); values.push(validateWebhookUrl(webhookUrl, this.allowHttp)); }
    if (!fields.length) throw new UserError("Provide new_name or webhook_url.");
    fields.push("updated_at = ?");
    values.push(now(), name);
    this.db.prepare(`UPDATE webhooks SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    return this.listWebhooks({ name: newName ?? name })[0];
  }

  deleteWebhook({ name }) {
    requireName(name, "name");
    const inUse = this.db.prepare(`
      SELECT channels.name FROM channels
      JOIN webhooks ON webhooks.id = channels.webhook_id
      WHERE webhooks.name = ? ORDER BY channels.name
    `).all(name);
    if (inUse.length) {
      throw new UserError(`Webhook '${name}' is used by channels: ${inUse.map((row) => row.name).join(", ")}. Delete or move them first.`);
    }
    affected(this.db.prepare("DELETE FROM webhooks WHERE name = ?").run(name), `Webhook '${name}' does not exist.`);
    return { deleted: name };
  }

  createChannel({ name, webhookName, mattermostChannel = null, username = null, iconUrl = null, enabled = true }) {
    requireName(name, "name");
    const webhook = this.#webhook(webhookName);
    if (!webhook) throw new UserError(`Webhook '${webhookName}' does not exist.`);
    if (this.#channel(name)) throw new UserError(`Channel '${name}' already exists.`);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO channels(name, webhook_id, mattermost_channel, username, icon_url, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, webhook.id, mattermostChannel, username, iconUrl, enabled ? 1 : 0, timestamp, timestamp);
    return this.listChannels({ name })[0];
  }

  listChannels({ name } = {}) {
    const sql = `
      SELECT channels.name, webhooks.name AS webhook_name, channels.mattermost_channel,
             channels.username, channels.icon_url, channels.enabled,
             channels.created_at, channels.updated_at
      FROM channels JOIN webhooks ON webhooks.id = channels.webhook_id
      ${name ? "WHERE channels.name = ?" : ""}
      ORDER BY channels.name
    `;
    const rows = name ? this.db.prepare(sql).all(name) : this.db.prepare(sql).all();
    return rows.map((row) => ({
      name: row.name,
      webhookName: row.webhook_name,
      mattermostChannel: row.mattermost_channel,
      username: row.username,
      iconUrl: row.icon_url,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateChannel({ name, newName, webhookName, mattermostChannel, username, iconUrl, enabled }) {
    requireName(name, "name");
    if (!this.#channel(name)) throw new UserError(`Channel '${name}' does not exist.`);
    if (newName !== undefined) requireName(newName, "new_name");
    if (newName && newName !== name && this.#channel(newName)) throw new UserError(`Channel '${newName}' already exists.`);
    const fields = [];
    const values = [];
    if (newName !== undefined) { fields.push("name = ?"); values.push(newName); }
    if (webhookName !== undefined) {
      const webhook = this.#webhook(webhookName);
      if (!webhook) throw new UserError(`Webhook '${webhookName}' does not exist.`);
      fields.push("webhook_id = ?"); values.push(webhook.id);
    }
    if (mattermostChannel !== undefined) { fields.push("mattermost_channel = ?"); values.push(mattermostChannel); }
    if (username !== undefined) { fields.push("username = ?"); values.push(username); }
    if (iconUrl !== undefined) { fields.push("icon_url = ?"); values.push(iconUrl); }
    if (enabled !== undefined) { fields.push("enabled = ?"); values.push(enabled ? 1 : 0); }
    if (!fields.length) throw new UserError("Provide at least one channel field to update.");
    fields.push("updated_at = ?");
    values.push(now(), name);
    this.db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    return this.listChannels({ name: newName ?? name })[0];
  }

  deleteChannel({ name }) {
    requireName(name, "name");
    affected(this.db.prepare("DELETE FROM channels WHERE name = ?").run(name), `Channel '${name}' does not exist.`);
    return { deleted: name };
  }

  createConvention({ name, template, description = null }) {
    requireName(name, "name");
    if (this.#convention(name)) throw new UserError(`Convention '${name}' already exists.`);
    if (template.length > MAX_MESSAGE_LENGTH) throw new UserError(`template exceeds ${MAX_MESSAGE_LENGTH} characters.`);
    const timestamp = now();
    this.db.prepare("INSERT INTO conventions(name, description, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(name, description, template, timestamp, timestamp);
    return this.listConventions({ name })[0];
  }

  listConventions({ name } = {}) {
    const rows = name
      ? this.db.prepare("SELECT name, description, template, created_at, updated_at FROM conventions WHERE name = ?").all(name)
      : this.db.prepare("SELECT name, description, template, created_at, updated_at FROM conventions ORDER BY name").all();
    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      template: row.template,
      variables: variablesIn(row.template),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateConvention({ name, newName, template, description }) {
    requireName(name, "name");
    if (!this.#convention(name)) throw new UserError(`Convention '${name}' does not exist.`);
    if (newName !== undefined) requireName(newName, "new_name");
    if (newName && newName !== name && this.#convention(newName)) throw new UserError(`Convention '${newName}' already exists.`);
    if (template !== undefined && template.length > MAX_MESSAGE_LENGTH) throw new UserError(`template exceeds ${MAX_MESSAGE_LENGTH} characters.`);
    const fields = [];
    const values = [];
    if (newName !== undefined) { fields.push("name = ?"); values.push(newName); }
    if (template !== undefined) { fields.push("template = ?"); values.push(template); }
    if (description !== undefined) { fields.push("description = ?"); values.push(description); }
    if (!fields.length) throw new UserError("Provide at least one convention field to update.");
    fields.push("updated_at = ?");
    values.push(now(), name);
    this.db.prepare(`UPDATE conventions SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    return this.listConventions({ name: newName ?? name })[0];
  }

  deleteConvention({ name }) {
    requireName(name, "name");
    affected(this.db.prepare("DELETE FROM conventions WHERE name = ?").run(name), `Convention '${name}' does not exist.`);
    return { deleted: name };
  }

  previewMessage({ conventionName, variables = {} }) {
    const convention = this.#convention(conventionName);
    if (!convention) throw new UserError(`Convention '${conventionName}' does not exist.`);
    return { conventionName, text: renderTemplate(convention.template, variables) };
  }

  async sendMessage({ channelNames, conventionName, variables = {}, text }) {
    if (new Set(channelNames).size !== channelNames.length) throw new UserError("channel_names cannot contain duplicates.");
    const rendered = conventionName ? this.previewMessage({ conventionName, variables }).text : text;
    if (!rendered) throw new UserError("Provide convention_name or text.");
    if (rendered.length > MAX_MESSAGE_LENGTH) throw new UserError(`Message exceeds ${MAX_MESSAGE_LENGTH} characters.`);
    const results = await Promise.all(channelNames.map(async (channelName) => {
      const channel = this.#channelForSend(channelName);
      if (!channel) return { channel: channelName, ok: false, error: "Channel does not exist." };
      if (!channel.enabled) return { channel: channelName, ok: false, error: "Channel is disabled." };
      const payload = { text: rendered };
      if (channel.mattermost_channel) payload.channel = channel.mattermost_channel;
      if (channel.username) payload.username = channel.username;
      if (channel.icon_url) payload.icon_url = channel.icon_url;
      try {
        await this.#post(channel.url, payload);
        return { channel: channelName, ok: true };
      } catch (error) {
        return { channel: channelName, ok: false, error: error instanceof UserError ? error.message : "Mattermost request failed." };
      }
    }));
    return { ok: results.every((result) => result.ok), text: rendered, results };
  }

  #webhook(name) {
    return this.db.prepare("SELECT id, name, url FROM webhooks WHERE name = ?").get(name);
  }

  #channel(name) {
    return this.db.prepare("SELECT id, name FROM channels WHERE name = ?").get(name);
  }

  #convention(name) {
    return this.db.prepare("SELECT id, name, template FROM conventions WHERE name = ?").get(name);
  }

  #channelForSend(name) {
    return this.db.prepare(`
      SELECT channels.name, channels.mattermost_channel, channels.username,
             channels.icon_url, channels.enabled, webhooks.url
      FROM channels JOIN webhooks ON webhooks.id = channels.webhook_id
      WHERE channels.name = ?
    `).get(name);
  }

  async #post(url, payload) {
    let response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new UserError("Mattermost request timed out.");
      throw new UserError("Mattermost request failed.");
    }
    await response.body?.cancel();
    if (!response.ok) throw new UserError(`Mattermost returned HTTP ${response.status}.`);
  }
}
