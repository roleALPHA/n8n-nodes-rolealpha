# n8n-nodes-rolealpha

n8n nodes for **generic agent runners**. One workflow runs every agent. Each agent's identity, roles, duties, deciders and guardrails are read from roleALPHA at run time. Nothing about persons, roles or process steps is hard-coded in n8n.

> Principle: an agent knows only itself. Everything else is found by traversing the graph. Look up the role first, then the person filling it.

## Nodes

### roleALPHA (`roleAlpha`)

| Resource | Operation | What it does | Credential |
|---|---|---|---|
| Agent | Get Context | Reads an agent's context bundle (identity, roles, guardrails). Fails if the agent is not `active` or has no policy, unless you switch that off. Over MCP it reads the `agent` view by default, exactly what the agent gets over its own key. | MCP OAuth2 (default) or roleALPHA Agent Keys API |
| Agent | Get Context Version | Change check. Cheap and not audited with agent keys; over MCP it reads the bundle. | MCP OAuth2 or roleALPHA Agent Keys API |
| Agent | List Agents | Over MCP: every agent of the organisation, paged. With agent keys: one item per key. By default it skips agents that are not active. | MCP OAuth2 or roleALPHA Agent Keys API |
| Responsibility | Get Duties | Lists the steps the agent's roles are `RESPONSIBLE_FOR`, with the circle. | MCP OAuth2 |
| Responsibility | Find Step by Custom ID | Looks up a step by an exact custom ID. | MCP OAuth2 |
| Responsibility | Get Step | Returns a step with its predecessors, successors, parent and child steps, responsible, deciding and accountable roles (with their holders), and policies. With **Role Details** also purpose and accountabilities of each responsible role. | MCP OAuth2 |
| Responsibility | Get Decider | Returns the `DECIDES_ON` role. If there is none, it returns the `ACCOUNTABLE_FOR` role. | MCP OAuth2 |
| Responsibility | Check Approver | **Fail-closed.** Is the acting person filling the deciding role? Only persons count; agents never do. | MCP OAuth2 |
| Responsibility | Check Responsibility | Is one of the agent's roles responsible for this step? | MCP OAuth2 |
| Responsibility | Get Circle Lead | One item per circle of the agent's roles: the role that leads the circle and its holders, e.g. to escalate to. Recognised from a lead flag on the role, else "Lead Link" in its purpose, else a custom ID ending in `:lead`, else the role that decides on or is accountable for the circle. `lead` is null when none is found. | MCP OAuth2 |
| Responsibility | Get Role Holders | Returns the persons (with address) and agents filling a role. | MCP OAuth2 |
| Prompt | Build System Prompt | Builds the system prompt from the bundle, the step, the duties and the trigger. Event data is passed as data, never as instructions. With a **Share** it adds the agent's part, what is not its part, the rules for waiting within the step, and returns `task` as the user message. | – |
| Share | Build Input | Prepares the model call that decides the agent's part of a step: only the accountabilities of its own roles count, the other responsible roles of the step are listed with theirs. Returns `systemMessage`, `prompt` and `schema` for a structured output parser. Needs Get Step with Role Details. | – |
| Share | Check | Checks the model answer against roleALPHA: drops duties that are no accountability of the agent and needs on roles that are not on the step. Returns `duties` (with `needs`), `notMine`, `waitsFor` and `waitRoleUuids`. | – |
| Wait | Plan After Run | Decides what follows a run on a step from the stored wait rows: the `done` row to add, which waiting agents of the same step to wake (their awaited role just delivered), which rows to remove, and which waits are stuck at the attempt limit. Covers a result that arrived while the agent was deciding to wait. | – |
| Wait | Check Start | Duplicate-run guard. After the runner added a lease row for its run (`state = running`), the oldest live lease of the same agent, step and records wins. A later start does not run; it returns a `queueRow` that runs when the busy run ends. Leases older than the run timeout are dead and released. Fail-closed when the own lease is missing. | – |
| Wait | Find Stale Waits | For a scheduler: waits nobody answered in time (e.g. a person fills the awaited role), queued starts whose busy run died, dead leases, expired rows, and waits at the attempt limit to escalate (`escalate`, reported once). | – |
| Settings | Resolve | Runner limits from defaults and a settings table (`scope, target, key, value`): default < global < step < agent. Every value is clamped to fixed bounds; unknown keys and unusable values are reported in `settingProblems` and never applied. | – |
| Schedule | Is Due | Decides from the step `frequency` (and `termin` / due date) whether a run is due in the current period. | – |

### Approval Seal (`approvalSeal`)

`Sign` seals exactly the approved content together with the approver. Use it after **Check Approver**. `Verify` recomputes the seal right before anything is sent and stops the workflow if the content changed.

- **v3** (new): `HMAC-SHA256(key, canonicalJson(['v3', type, fields, approver]))`. The key must have at least 32 characters.
- **v2** (legacy): the hash the older code nodes wrote. It is only verified, never signed. Set **Legacy Key**, and remove it once no v2 seal is open.

### roleALPHA Trigger (`roleAlphaTrigger`)

Receives `context.changed` webhooks. It checks `X-RA-Signature: sha256=<hmac>` against the raw body and answers `401` if the signature is wrong. Register the production URL in roleALPHA under agent → *Context & Access*.

## Credentials

| Credential | Content |
|---|---|
| **roleALPHA Agent Keys API** | Optional, for the `Agent Keys` source. `baseUrl` of the data node, and `keys`: `{"<agent uuid>": "agt_…"}`, or a list of `{agentUuid, key, label}`. |
| **roleALPHA Webhook API** | One signing secret, a JSON list of secrets, or a map from agent UUID to secret. |
| **Approval Seal API** | `key` (sign and verify) and optionally `legacyKey` (verify v2 only). |
| **MCP OAuth2** (n8n built-in) | Access to the roleALPHA MCP endpoint for one organisation. Used for agents (default source) and traversal. **A new agent runs as soon as it is `active` in roleALPHA**: the scheduler finds it on its next tick. The `agent` view needs admin rights on the tenant. An agent key can read only its own agent, so it cannot traverse. |

Agent keys and webhook secrets are issued in the roleALPHA UI and shown only once. Store them nowhere except in these credentials.

## Generic runner (outline)

```
Scheduler (cron)                        Event router (one webhook)
 └ roleALPHA: List Agents                └ map (collection, status) → step custom ID
   └ roleALPHA: Get Duties                 └ roleALPHA: Get Step → responsible role → active agent
     └ roleALPHA: Is Due (last runs)         ┘
       └──────────────► Runner(agentUuid, step, trigger, event)
                          ├ roleALPHA: Get Context          (active + guardrails, fail-closed)
                          ├ roleALPHA: Check Responsibility (fail-closed)
                          ├ roleALPHA: Get Step
                          ├ roleALPHA: Build System Prompt
                          └ AI Agent (+ data tool limited to the role's domains)
```

### Dependencies within a step

A step can hold many tasks shared by several roles, and their parts can depend on each other (a visual needs the text, the hand-over needs all parts). The runner asks **Share** for the agent's part and what it needs. The agent checks the data before a dependent task; if the result is missing it does what it can, records a wait (`wait_for` tool: a row with `state = waiting`, `waits_for` = role UUIDs) and ends. After every run, **Wait → Plan After Run** adds a `done` row, wakes the agents of the same step that wait on one of the finished run's roles (same records), and the runner is called again for them with `event.wake = {attempt, wokenBy}`. Rows live in any store of the workflow, e.g. an n8n data table with the columns `state, step_uuid, step_custom_id, agent_uuid, agent_name, roles, waits_for, reason, record_keys, event, run_id, attempts, progress, at`.

### Robustness and limits

| Setting | Default | Bounds | Meaning |
|---|---|---|---|
| `maxWaitMinutes` | 60 | 5–10080 | A wait nobody answered is started again by the scheduler after this time |
| `maxAttempts` | 5 | 1–20 | Wake-ups per wait; at the limit the wait is escalated and never woken again by itself |
| `keepDoneHours` | 168 | 1–2160 | How long `done` and `escalated` rows are kept |
| `maxIterations` | 15 | 1–50 | Tool calls of the agent per run |
| `runTimeoutMinutes` | 15 | 1–120 | A run older than this counts as dead; its lease is released |
| `escalate` | true | – | Report stuck waits to the role that leads the circle |
| `shareCacheHours` | 24 | 0–720 | Reuse a share decision while step, roles and trigger kind stay the same (0 = never) |

Every wake-up names one row (`claimId`). The runner deletes that row first and wakes only if the delete removed it, so two runs that plan at the same time never wake an agent twice. Texts that one agent leaves for another (`reason`, `event`) are cut to fixed sizes and passed as data. A duty marked `handover` (it closes the step) always waits on every other filled role of the step.

Gates (approvals) follow this order: **Get Decider → Check Approver → Approval Seal: Sign**. The channel that sends runs **Approval Seal: Verify** first.

## Security notes

- Every check is fail-closed. If roleALPHA cannot be read, the result is "not allowed".
- Agents never approve. Check Approver ignores agents that fill the deciding role.
- The prompt marks trigger payloads as data. Guardrails take precedence over event content.
- Keep `requireActive` and `requireGuardrails` on in production.
- Settings from a table are clamped to fixed bounds: a wrong row can make the runner more careful, never unbounded.
- Duplicate runs are blocked by leases; wake-ups are claimed before they fire.
- No credentials are kept in wait, settings or cache rows.

## Build and install (self-hosted)

```bash
npm install
npm run build
npm test
npm pack                     # → n8n-nodes-rolealpha-0.3.0.tgz
# on the n8n host (custom extensions folder, e.g. ~/.n8n/custom):
npm install /path/to/n8n-nodes-rolealpha-0.3.0.tgz
# restart n8n
```

The package is marked `private`. It is not published to the npm registry.
