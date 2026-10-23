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
| Responsibility | Get Step | Returns a step with its predecessors, successors, parent and child steps, responsible, deciding and accountable roles (with their holders), and policies. | MCP OAuth2 |
| Responsibility | Get Decider | Returns the `DECIDES_ON` role. If there is none, it returns the `ACCOUNTABLE_FOR` role. | MCP OAuth2 |
| Responsibility | Check Approver | **Fail-closed.** Is the acting person filling the deciding role? Only persons count; agents never do. | MCP OAuth2 |
| Responsibility | Check Responsibility | Is one of the agent's roles responsible for this step? | MCP OAuth2 |
| Responsibility | Get Role Holders | Returns the persons (with address) and agents filling a role. | MCP OAuth2 |
| Prompt | Build System Prompt | Builds the system prompt from the bundle, the step, the duties and the trigger. Event data is passed as data, never as instructions. | – |
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

Gates (approvals) follow this order: **Get Decider → Check Approver → Approval Seal: Sign**. The channel that sends runs **Approval Seal: Verify** first.

## Security notes

- Every check is fail-closed. If roleALPHA cannot be read, the result is "not allowed".
- Agents never approve. Check Approver ignores agents that fill the deciding role.
- The prompt marks trigger payloads as data. Guardrails take precedence over event content.
- Keep `requireActive` and `requireGuardrails` on in production.

## Build and install (self-hosted)

```bash
npm install
npm run build
npm test
npm pack                     # → n8n-nodes-rolealpha-0.1.0.tgz
# on the n8n host (custom extensions folder, e.g. ~/.n8n/custom):
npm install /path/to/n8n-nodes-rolealpha-0.1.0.tgz
# restart n8n
```

The package is marked `private`. It is not published to the npm registry.
