import { UserError, affected, now, requireName } from "./core.js";

const MAX_BODY_LENGTH = 65_536;
const MAX_DIFF_CHARS = 18_000;
const MAX_FILE_DIFF_CHARS = 3_000;
const DEFAULT_ACK_EMOJI = "eyes";
const EMOJI_PATTERN = /^[a-z0-9][a-z0-9_+-]{0,63}$/;
const REVIEW_TODO_ACTIONS = ["review_requested", "directly_addressed", "mentioned"];

function validateBaseUrl(value, allowHttp) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UserError("base_url must be a valid URL.");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new UserError("base_url cannot contain credentials, a query, or a fragment.");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new UserError("base_url must use HTTPS. Set MATTERMOST_MCP_ALLOW_HTTP=1 only for a trusted local GitLab server.");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

function validateToken(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 256) {
    throw new UserError("token must be 20-256 characters.");
  }
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new UserError("token cannot contain whitespace or control characters.");
  }
  return value;
}

function projectPath(projectId) {
  const value = String(projectId);
  if (/^\d+$/.test(value)) return value;
  if (value.length > 512 || /[?#\s]/.test(value)) throw new UserError("project_id must be a numeric id or a project path.");
  return encodeURIComponent(value);
}

function truncate(text, limit) {
  if (typeof text !== "string" || text.length <= limit) return { text: text ?? "", truncated: false };
  return { text: `${text.slice(0, limit)}\n… [truncated]`, truncated: true };
}

function person(user) {
  if (!user) return null;
  return { username: user.username ?? null, name: user.name ?? null };
}

function summarizeMergeRequest(mr) {
  return {
    projectId: Number(mr.project_id),
    mrIid: Number(mr.iid),
    reference: `!${mr.iid}`,
    title: mr.title,
    author: person(mr.author),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    webUrl: mr.web_url,
    updatedAt: mr.updated_at,
  };
}

export class GitLabService {
  constructor({ db, allowHttp, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    if (!db) throw new Error("GitLabService requires an open database handle.");
    this.db = db;
    this.allowHttp = allowHttp ?? process.env.MATTERMOST_MCP_ALLOW_HTTP === "1";
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gitlab_sites (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gitlab_review_state (
        site_id INTEGER NOT NULL REFERENCES gitlab_sites(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL,
        mr_iid INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_updated_at TEXT,
        acked_at TEXT,
        reviewed_at TEXT,
        PRIMARY KEY (site_id, project_id, mr_iid)
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(gitlab_review_state)").all();
    if (!columns.some((column) => column.name === "notified_at")) {
      this.db.exec("ALTER TABLE gitlab_review_state ADD COLUMN notified_at TEXT");
    }
  }

  createSite({ name, baseUrl, token }) {
    requireName(name, "name");
    if (this.#site(name)) throw new UserError(`GitLab site '${name}' already exists.`);
    const timestamp = now();
    this.db.prepare("INSERT INTO gitlab_sites(name, base_url, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(name, validateBaseUrl(baseUrl, this.allowHttp), validateToken(token), timestamp, timestamp);
    return this.listSites({ name })[0];
  }

  listSites({ name } = {}) {
    const sql = `SELECT name, base_url, created_at, updated_at FROM gitlab_sites ${name ? "WHERE name = ?" : ""} ORDER BY name`;
    const rows = name ? this.db.prepare(sql).all(name) : this.db.prepare(sql).all();
    return rows.map((row) => ({
      name: row.name,
      baseUrl: row.base_url,
      tokenStored: true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateSite({ name, newName, baseUrl, token }) {
    requireName(name, "name");
    if (!this.#site(name)) throw new UserError(`GitLab site '${name}' does not exist.`);
    if (newName !== undefined) requireName(newName, "new_name");
    if (newName && newName !== name && this.#site(newName)) throw new UserError(`GitLab site '${newName}' already exists.`);
    const fields = [];
    const values = [];
    if (newName !== undefined) { fields.push("name = ?"); values.push(newName); }
    if (baseUrl !== undefined) { fields.push("base_url = ?"); values.push(validateBaseUrl(baseUrl, this.allowHttp)); }
    if (token !== undefined) { fields.push("token = ?"); values.push(validateToken(token)); }
    if (!fields.length) throw new UserError("Provide new_name, base_url, or token.");
    fields.push("updated_at = ?");
    values.push(now(), name);
    this.db.prepare(`UPDATE gitlab_sites SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    return this.listSites({ name: newName ?? name })[0];
  }

  deleteSite({ name }) {
    requireName(name, "name");
    affected(this.db.prepare("DELETE FROM gitlab_sites WHERE name = ?").run(name), `GitLab site '${name}' does not exist.`);
    return { deleted: name };
  }

  async reviewInbox({ siteName, limit = 20, track = true }) {
    const site = this.#requireSite(siteName);
    const me = await this.#request(site, "user");
    const merged = await this.#request(
      site,
      `merge_requests?scope=all&state=opened&reviewer_id=${Number(me.id)}&order_by=updated_at&sort=desc&per_page=${limit}`,
    );
    const rows = Array.isArray(merged) ? merged : [];
    const items = rows.map((mr) => {
      const summary = summarizeMergeRequest(mr);
      return { ...summary, ...this.#trackState(site.id, summary, { write: track }) };
    });
    return {
      site: site.name,
      reviewer: person(me),
      count: items.length,
      newCount: items.filter((item) => item.isNew).length,
      mergeRequests: items,
    };
  }

  async todoInbox({ siteName, limit = 50, actions, includeClosed = false, track = true }) {
    const site = this.#requireSite(siteName);
    const allowed = new Set(actions?.length ? actions : REVIEW_TODO_ACTIONS);
    const rows = await this.#request(site, `todos?state=pending&per_page=${limit}`);
    const grouped = new Map();
    for (const todo of Array.isArray(rows) ? rows : []) {
      if (todo.target_type !== "MergeRequest" || !allowed.has(todo.action_name)) continue;
      const projectId = Number(todo.project?.id);
      const mrIid = Number(todo.target?.iid);
      if (!Number.isInteger(projectId) || !Number.isInteger(mrIid)) continue;
      const state = todo.target?.state ?? null;
      if (!includeClosed && state !== "opened") continue;
      const key = `${projectId}:${mrIid}`;
      const entry = grouped.get(key) ?? {
        projectId,
        mrIid,
        reference: `!${mrIid}`,
        title: todo.target?.title ?? null,
        author: person(todo.target?.author),
        state,
        webUrl: todo.target?.web_url ?? null,
        updatedAt: todo.target?.updated_at ?? null,
        projectPath: todo.project?.path_with_namespace ?? null,
        reasons: [],
        todoIds: [],
        triggeredBy: [],
      };
      if (!entry.reasons.includes(todo.action_name)) entry.reasons.push(todo.action_name);
      entry.todoIds.push(Number(todo.id));
      const by = person(todo.author);
      if (by?.username && !entry.triggeredBy.some((one) => one.username === by.username)) entry.triggeredBy.push(by);
      grouped.set(key, entry);
    }
    const items = [...grouped.values()].map((entry) => ({ ...entry, ...this.#trackState(site.id, entry, { write: track }) }));
    return {
      site: site.name,
      actions: [...allowed],
      count: items.length,
      newCount: items.filter((item) => item.isNew).length,
      mergeRequests: items,
    };
  }

  markNotified({ siteName, mergeRequests }) {
    const site = this.#requireSite(siteName);
    const timestamp = now();
    const update = this.db.prepare("UPDATE gitlab_review_state SET notified_at = ? WHERE site_id = ? AND project_id = ? AND mr_iid = ?");
    const insert = this.db.prepare("INSERT INTO gitlab_review_state(site_id, project_id, mr_iid, first_seen_at, last_updated_at, notified_at) VALUES (?, ?, ?, ?, ?, ?)");
    let marked = 0;
    for (const entry of mergeRequests) {
      const changed = update.run(timestamp, site.id, entry.projectId, entry.mrIid);
      if (Number(changed.changes) === 0) {
        insert.run(site.id, entry.projectId, entry.mrIid, timestamp, entry.updatedAt ?? null, timestamp);
      }
      marked += 1;
    }
    return { ok: true, site: site.name, marked };
  }

  async markTodoDone({ siteName, todoId }) {
    const site = this.#requireSite(siteName);
    const id = Number(todoId);
    if (!Number.isInteger(id) || id <= 0) throw new UserError("todo_id must be a positive integer.");
    try {
      await this.#request(site, `todos/${id}/mark_as_done`, { method: "POST" });
    } catch (error) {
      if (error instanceof UserError && error.message.includes("404")) {
        return { ok: true, site: site.name, todoId: id, alreadyDone: true };
      }
      throw error;
    }
    return { ok: true, site: site.name, todoId: id, alreadyDone: false };
  }

  async mergeRequestChanges({ siteName, projectId, mrIid, includeDiscussions = true }) {
    const site = this.#requireSite(siteName);
    const project = projectPath(projectId);
    const iid = Number(mrIid);
    const mr = await this.#request(site, `projects/${project}/merge_requests/${iid}`);
    const changes = await this.#diffs(site, project, iid);
    let used = 0;
    const files = changes.map((change) => {
      const remaining = Math.max(0, MAX_DIFF_CHARS - used);
      const limit = Math.min(MAX_FILE_DIFF_CHARS, remaining);
      const diff = truncate(change.diff ?? "", limit);
      used += diff.text.length;
      return {
        newPath: change.new_path,
        oldPath: change.old_path,
        newFile: Boolean(change.new_file),
        renamedFile: Boolean(change.renamed_file),
        deletedFile: Boolean(change.deleted_file),
        diff: diff.text,
        truncated: diff.truncated,
      };
    });
    const result = {
      site: site.name,
      ...summarizeMergeRequest(mr),
      description: truncate(mr.description ?? "", 4_000).text,
      diffRefs: mr.diff_refs ?? null,
      fileCount: files.length,
      files,
      diffTruncated: files.some((file) => file.truncated),
    };
    if (includeDiscussions) {
      const discussions = await this.#request(site, `projects/${project}/merge_requests/${iid}/discussions?per_page=100`);
      result.discussions = (Array.isArray(discussions) ? discussions : []).flatMap((discussion) =>
        (discussion.notes ?? [])
          .filter((note) => !note.system)
          .map((note) => ({
            discussionId: discussion.id,
            author: person(note.author),
            body: truncate(note.body ?? "", 900).text,
            filePath: note.position?.new_path ?? null,
            line: note.position?.new_line ?? null,
            resolved: Boolean(note.resolved),
            createdAt: note.created_at,
          })),
      );
    }
    return result;
  }

  async acknowledgeMergeRequest({ siteName, projectId, mrIid, emoji = DEFAULT_ACK_EMOJI }) {
    if (!EMOJI_PATTERN.test(emoji)) throw new UserError("emoji must be a GitLab award emoji name without colons.");
    const site = this.#requireSite(siteName);
    const project = projectPath(projectId);
    const iid = Number(mrIid);
    const existing = await this.#request(site, `projects/${project}/merge_requests/${iid}/award_emoji?per_page=100`);
    const me = await this.#request(site, "user");
    const mine = (Array.isArray(existing) ? existing : []).find(
      (award) => award.name === emoji && Number(award.user?.id) === Number(me.id),
    );
    if (!mine) {
      await this.#request(site, `projects/${project}/merge_requests/${iid}/award_emoji`, {
        method: "POST",
        body: { name: emoji },
      });
    }
    this.#markState(site.id, project, iid, "acked_at");
    return { ok: true, site: site.name, mrIid: iid, emoji, alreadyAcknowledged: Boolean(mine) };
  }

  async createNote({ siteName, projectId, mrIid, body, filePath, line }) {
    if (typeof body !== "string" || !body.trim()) throw new UserError("body must be a non-empty string.");
    if (body.length > MAX_BODY_LENGTH) throw new UserError(`body exceeds ${MAX_BODY_LENGTH} characters.`);
    if ((filePath === undefined) !== (line === undefined)) {
      throw new UserError("Provide both file_path and line for a line comment, or neither for a merge request comment.");
    }
    const site = this.#requireSite(siteName);
    const project = projectPath(projectId);
    const iid = Number(mrIid);
    let created;
    if (filePath === undefined) {
      created = await this.#request(site, `projects/${project}/merge_requests/${iid}/notes`, {
        method: "POST",
        body: { body },
      });
    } else {
      const mr = await this.#request(site, `projects/${project}/merge_requests/${iid}`);
      const refs = mr.diff_refs;
      if (!refs?.base_sha || !refs?.head_sha) throw new UserError("GitLab did not return diff refs for this merge request; post a merge request comment instead.");
      created = await this.#request(site, `projects/${project}/merge_requests/${iid}/discussions`, {
        method: "POST",
        body: {
          body,
          position: {
            position_type: "text",
            base_sha: refs.base_sha,
            start_sha: refs.start_sha ?? refs.base_sha,
            head_sha: refs.head_sha,
            new_path: filePath,
            old_path: filePath,
            new_line: Number(line),
          },
        },
      });
    }
    this.#markState(site.id, project, iid, "reviewed_at");
    return {
      ok: true,
      site: site.name,
      mrIid: iid,
      scope: filePath === undefined ? "merge_request" : "line",
      filePath: filePath ?? null,
      line: line === undefined ? null : Number(line),
      noteId: created?.id ?? created?.notes?.[0]?.id ?? null,
      webUrl: created?.web_url ?? null,
    };
  }

  #site(name) {
    return this.db.prepare("SELECT id, name, base_url, token FROM gitlab_sites WHERE name = ?").get(name);
  }

  #requireSite(name) {
    if (name === undefined) {
      const rows = this.db.prepare("SELECT id, name, base_url, token FROM gitlab_sites ORDER BY name").all();
      if (!rows.length) throw new UserError("No GitLab site is registered. Register one with gitlab_site_create first.");
      if (rows.length > 1) throw new UserError(`Multiple GitLab sites are registered: ${rows.map((row) => row.name).join(", ")}. Pass site_name.`);
      return rows[0];
    }
    requireName(name, "site_name");
    const site = this.#site(name);
    if (!site) throw new UserError(`GitLab site '${name}' does not exist.`);
    return site;
  }

  #trackState(siteId, summary, { write = true } = {}) {
    const state = this.db.prepare("SELECT first_seen_at, last_updated_at, acked_at, reviewed_at, notified_at FROM gitlab_review_state WHERE site_id = ? AND project_id = ? AND mr_iid = ?")
      .get(siteId, summary.projectId, summary.mrIid);
    if (write && !state) {
      this.db.prepare("INSERT INTO gitlab_review_state(site_id, project_id, mr_iid, first_seen_at, last_updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(siteId, summary.projectId, summary.mrIid, now(), summary.updatedAt ?? null);
    } else if (write) {
      this.db.prepare("UPDATE gitlab_review_state SET last_updated_at = ? WHERE site_id = ? AND project_id = ? AND mr_iid = ?")
        .run(summary.updatedAt ?? null, siteId, summary.projectId, summary.mrIid);
    }
    return {
      isNew: !state,
      acked: Boolean(state?.acked_at),
      reviewedAt: state?.reviewed_at ?? null,
      notified: Boolean(state?.notified_at),
      changedSinceReview: Boolean(state?.reviewed_at && summary.updatedAt && summary.updatedAt > state.reviewed_at),
    };
  }

  #markState(siteId, project, iid, column) {
    const projectId = /^\d+$/.test(project) ? Number(project) : null;
    if (projectId === null) return;
    const timestamp = now();
    const updated = this.db.prepare(`UPDATE gitlab_review_state SET ${column} = ? WHERE site_id = ? AND project_id = ? AND mr_iid = ?`)
      .run(timestamp, siteId, projectId, iid);
    if (Number(updated.changes) === 0) {
      this.db.prepare(`INSERT INTO gitlab_review_state(site_id, project_id, mr_iid, first_seen_at, ${column}) VALUES (?, ?, ?, ?, ?)`)
        .run(siteId, projectId, iid, timestamp, timestamp);
    }
  }

  async #diffs(site, project, iid) {
    try {
      const rows = await this.#request(site, `projects/${project}/merge_requests/${iid}/diffs?per_page=100`);
      if (Array.isArray(rows)) return rows;
    } catch (error) {
      if (!(error instanceof UserError) || !error.message.includes("404")) throw error;
    }
    const legacy = await this.#request(site, `projects/${project}/merge_requests/${iid}/changes`);
    return Array.isArray(legacy?.changes) ? legacy.changes : [];
  }

  async #request(site, path, { method = "GET", body } = {}) {
    const url = new URL(`api/v4/${path}`, site.base_url);
    let response;
    try {
      response = await this.fetch(url.toString(), {
        method,
        headers: {
          "PRIVATE-TOKEN": site.token,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new UserError("GitLab request timed out.");
      throw new UserError("GitLab request failed.");
    }
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401) throw new UserError("GitLab rejected the stored token (HTTP 401). Replace it with gitlab_site_update.");
      if (response.status === 403) throw new UserError("The stored GitLab token lacks permission for this action (HTTP 403). It needs the api scope.");
      throw new UserError(`GitLab returned HTTP ${response.status}.`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new UserError("GitLab returned a response that was not JSON.");
    }
  }
}
