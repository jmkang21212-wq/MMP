---
name: mattermost-review-message
description: Use mattermost-manager for natural-language mm/Mattermost review messages and lightweight webhook or channel CRUD. Remember an approved default channel only within the current Codex task.
---

# Mattermost Manager

Use the `mattermost-manager` MCP. Never hard-code or assume a channel name.

## Session Default Channel

- A session means the current Codex task. Do not persist its default channel to SQLite or reuse it in another task.
- Start with no session default. On the first send without an explicit channel, call `channel_list` and show the registered logical channel names before asking which one to use. Ask even when exactly one channel is registered; never select it automatically.
- Only enabled channels are selectable for sending. If the user chooses a disabled channel, ask whether to enable it with `channel_update` before sending.
- Show the exact pending message with the channel choices. Selecting a channel authorizes sending that displayed message there. After a successful send, remember the selected channel as this task's default.
- If no enabled channel is registered, do not discard the pending message:
  1. Call `webhook_list`.
  2. If a webhook exists, explain that a logical channel must be added and ask only for its logical name, webhook choice when there are multiple, and optional Mattermost channel name or URL.
  3. If no webhook exists, explain that a named incoming webhook URL must be registered first, then guide the user to add a logical channel.
  4. Create nothing until the user supplies the required configuration. After creation, ask whether to use the new channel for the pending message and as this task's default.
- Once a session default exists, an explicit send request such as `mm 보내줘` authorizes sending to that channel. Do not ask for the channel or repeat a send-confirmation step. Ask only for message data that cannot be resolved safely.
- If the user explicitly sets a session default channel, remember it without sending a message.
- If the user says `이번에만 <channel>에 mm 보내줘` or otherwise names a channel different from the session default:
  1. Verify the logical channel with `channel_list`.
  2. Send to that channel as requested without changing the current default first.
  3. After a successful send, ask whether to change this task's default to that channel. Keep the old default unless the user agrees.
- If a named channel is not registered, do not guess or silently create it. Ask whether the user wants to register it and request only the missing configuration.

## Review Messages

Classify natural variants such as `리뷰 요청 mm에 보내줘`, `리뷰요청 mm으로 보내줘`, or `리뷰 완료 Mattermost에 보내줘`:

- A review request uses convention `review-request`.
- A completed review uses convention `review-complete`.

Resolve the Mattermost mention, MR number, and Jira key from the current conversation, checked-out branch, and current MR. Do not guess. A GitLab username is not a confirmed Mattermost mention unless the mapping is already established. If a value is unresolved, ask only for the missing value or values and never send placeholders.

The rendered result must be exactly one line:

`<mention> <status emoji> !<MR number> | [<Jira key>] <short message>`

Use `:merge_please:` for a review request and `:review_complete_shake:` for a completed review. Keep the message natural and concise for the current context. Default to `리뷰 부탁드립니당.` or `리뷰 완료 했습니다.` when no more specific wording is needed. Add code-change summaries or verification details only when explicitly requested.

Call `message_send` with the selected logical channel, the matching convention, and these variables:

- `mention`: includes `@`
- `mr_number`: numeric value without `!`
- `jira_key`: without brackets
- `message`: final short message

If the user asks only to draft or preview, do not send. Treat delivery as complete only when the selected channel's result has `ok: true`; otherwise report the failure without claiming delivery.

## Natural Webhook CRUD

Map ordinary Korean requests directly to these tools without requiring the user to name them:

- Register a named incoming webhook URL: `webhook_create`.
- Show registered webhooks: `webhook_list`.
- Rename a webhook or replace its URL: `webhook_update`.
- Delete an unused webhook: `webhook_delete`.

A webhook URL is secret. Never repeat it in chat or expose it through diagnostics. Ask only for a missing name or URL. Verify create/update/delete results with the redacted `webhook_list`. If deletion is blocked by linked channels, report those channel names and do not cascade-delete them.

## Natural Channel CRUD

Map ordinary Korean requests directly to these tools:

- Register a logical channel linked to a saved webhook: `channel_create`.
- Show one or all logical channels: `channel_list`.
- Rename, enable/disable, move to another webhook, or change Mattermost overrides: `channel_update`.
- Delete a logical channel mapping: `channel_delete`.

For channel creation, resolve the logical name and webhook name. `mattermost_channel` is optional; when the user supplies a Mattermost URL containing `/channels/<value>`, use the final path value. Ask only for required missing fields. Do not send a message merely because channel or webhook configuration changed. Verify mutations with the corresponding list tool.
