# Feishu Channel Runtime

This directory owns the Feishu channel adapter for the algorithm digital employee MVP.

## Responsibility

- `inbound-turn.mjs` normalizes the current Feishu event into the shared turn contract and owns Feishu-specific broadcast-mention detection.
- `bot-identity.mjs` resolves the current app bot's structured `open_id` from Feishu `/bot/v3/info`; group activation fails closed when that identity is unavailable.
- `group-ingress-policy.mjs` applies the exact group allowlist and current-bot mention gate before transcript, task, Provider, Tool, or resource download work.
- `event-gateway.mjs` enforces channel guards and dedupe, derives the session key, hands the turn to the dispatcher, adds/removes source-message reactions, delivers the reply, and records task-answer feedback callbacks.
- `turn-dispatcher.mjs` admits authenticated turns for an enabled employee and wires governed asset lookup into the shared modules under `server/agent-runtime/`. Feishu does not select or allowlist models and does not reuse Control Plane invocation policy as a conversation gate; Provider leases and per-Tool authorization remain Runtime concerns.
- `algorithm-agent-runtime.mjs` is a temporary Feishu composition adapter. It receives dispatcher-approved runtime context, selects the governed employee lease, passes a plain-text response profile and declared material Tools, then delegates Prompt policy and model/Tool execution to `server/agent-runtime/digital-employee-agent-prompt.mjs` and `responses-agent-runner.mjs`. It must not become a second employee Runtime.
- `connection-test.mjs` owns backend connection-test delivery, target masking, roundtrip status, and rapid-click cooldown checks.
- `connection-draft.mjs` owns connection-form draft metadata, App console links, callback URL derivation, and worker-binding summary construction.
- `long-connection-worker.mjs` runs the Feishu/Lark websocket long-connection client with `@larksuiteoapi/node-sdk`.
- `server/feishu-integration-routes.mjs` remains the HTTP API surface for access application, connection configuration, status, and the advanced HTTPS callback endpoint.

The channel gateway is not the digital employee runtime. It must not classify ordinary natural-language intent, assemble prompts, or execute Tools. After deterministic channel/auth checks, normal non-empty text enters the bound Agent session loop. Conversation admission does not approve execution: every Tool call is checked again from its structured Tool/action/risk/scope fields, and remote actions or writeback still need subsystem-local RBAC, resource leases, quality gates, and human review.

Group material intake is intentionally two-part because Feishu sends a standalone attachment and the later instruction as separate events. In an exact allowlisted group, the first material-only event is held in the bounded in-memory coalescer by employee/account, group, and sender without creating a task. A later message from the same sender must structurally mention the current bot `open_id`; only then is the pending material sealed into the canonical task. Ordinary unmentioned group text and every non-allowlisted group event are ignored before session persistence. Receiving the first standalone material event requires `im:message.group_msg`; that transport scope does not grant business authorization.

## Runtime Report Artifacts

Feishu material tasks may return governed workspace artifacts when the mounted Skill declares a report-style output contract. Keep the channel layer business-neutral:

- Use `write_workspace_text` for small text or single-file HTML outputs.
- Use `write_report_bundle` for image-heavy static HTML reports. The runtime writes a zip containing `index.html` plus relative `assets/` files, and resolves declared `visual-evidence://...` placeholders from `export_visual_evidence` into bundle-local asset paths.
- `export_visual_evidence` may return Skill-declared presentation metadata such as `pairId` and `evidenceKind`; the channel only passes this through so the Agent can follow the mounted Skill's `reportProfile`, not a channel-owned business template.
- Do not emit `file://` links, external image URLs, undeclared local paths, or manually inlined Base64. The Agent may choose the report structure from Skill/profile guidance, but asset access and export must still go through declared Tools.

## Binding Model

The worker is managed as a channel process, then bound to a governed digital employee through the Feishu connection state:

```text
Feishu app bot event
  -> server/channels/feishu/long-connection-worker.mjs
  -> server/channels/feishu/event-gateway.mjs
  -> server/agent-runtime/turn-dispatcher.mjs
  -> server/agent-runtime/runtime-adapter-registry.mjs
  -> encrypted SQLite Session Foundation transcript + compaction checkpoint
  -> ignored data/local/feishu-integration-state.json for connection/task summaries only
  -> workerBinding.employeeId = <configured-employee-id>
```

`connection.workerBinding` records the safe binding metadata:

- `employeeId` / `employeeName`
- `applicationId` / `capabilityRequestId`
- target user and department summary
- selected channel intents and Skill ids
- allowed-chat count, route key, and worker status

This binding lets the console show which digital employee the Feishu process serves without moving process management into the employee definition itself.

## Running Locally

After an approved Feishu application has saved App ID/App Secret in the backend credential flow:

```bash
pnpm feishu:worker
```

Restart the managed local worker after changing reply/event code:

```bash
pnpm feishu:worker:restart
```

For LAN testing with `screen`, start this command from the repository root and keep stdout/stderr in an ignored local log such as `/tmp/digital_workforce_feishu_worker.screen.log`.

The worker updates `lastConnectionTest` and `workerBinding.status` as it starts, reconnects, receives a real `im.message.receive_v1` event, and adds a Feishu message reaction marker under the source message. The management UI should only turn the connection test green after a real message event and marker delivery are recorded as `message_roundtrip_tested`.

To collect task-answer quality feedback, subscribe to `card.action.trigger` in the same selected receive mode. Successful runtime task answers use Feishu's interactive-message transport internally, but users only see `质量 OK` and `存在问题`. Conversation-only replies remain plain messages without a task feedback card. Positive feedback is a safe acknowledgement. Negative feedback creates a scrubbed `quality-event.v1` review draft and eval candidate through the control-plane store.

## Privacy Boundary

Do not log or return raw App Secret, tenant access token, verification token, encrypt key, webhook URL secret, raw message text, raw prompt, model trace, execution payload, customer data, private algorithm payloads, or employee PII. For the LAN continuity MVP only, session user/assistant text may be persisted as AES-256-GCM ciphertext in the ignored local store; it must never enter Git, logs, management APIs, or UI summaries.

Allowed persistent data is limited to masked ids, timestamps, status, safe target summaries, route ids, delivery/error summaries, and the encrypted local session transcript. Production must replace this single-host file store with RBAC-controlled managed storage, retention/deletion policy, audit, and KMS-backed encryption.

## Troubleshooting

- Worker online but no standalone group-file event: confirm the Feishu app uses long-connection event subscription, subscribes to `im.message.receive_v1`, has `im:message.group_msg`, is installed in the exact allowlisted group, and a new app version containing the permission is published and tenant-authorized. The later instruction must still @ the current bot.
- Reply works but quality actions do not acknowledge: confirm `card.action.trigger` is subscribed in the same receive mode, then send a fresh message and click one answer action.
- Event received but the status marker did not appear: check `im:message.reactions:write_only` or `im:message`, tenant token validation, and whether the bot can react to the source message.
- Test button sent a message but stayed pending: the button only proves outbound test delivery. The final pass requires the user to reply in Feishu so the worker sees the inbound event and adds the source-message marker.
