# n8n-nodes-rolealpha

<p align="center"><b>AI agents that know only themselves.</b><br>
Roles, duties, deciders and guardrails come from roleALPHA, at run time, every time.</p>

<p align="center">
  <a href="https://github.com/roleALPHA/n8n-nodes-rolealpha"><b>GitHub</b></a> &nbsp;·&nbsp;
  <a href="#installation-self-hosted-n8n">Installation</a> &nbsp;·&nbsp;
  <a href="#nodes">Node reference</a> &nbsp;·&nbsp;
  <a href="#security">Security</a> &nbsp;·&nbsp;
  <a href="LICENSE">Licence</a>
</p>

<p align="center">
  <a href="package.json"><img
    alt="Version"
    src="https://img.shields.io/github/package-json/v/roleALPHA/n8n-nodes-rolealpha?label=version&color=7c3aed"></a>
  <a href="LICENSE"><img
    alt="Licence: MIT"
    src="https://img.shields.io/badge/licence-MIT-7c3aed"></a>
  <a href="https://docs.n8n.io/integrations/community-nodes/"><img
    alt="n8n community nodes"
    src="https://img.shields.io/badge/n8n-community%20nodes-7c3aed?logo=n8n&logoColor=white"></a>
</p>

You know the moment: somebody new takes over approvals, a role is cut in two, a process gets
one more step. Then every agent that has a name, an e-mail address or a process ID baked
into its prompt or its workflow is wrong, and nobody notices until something goes to the
wrong person. These nodes are built so that this cannot happen. An agent knows its own
identity and nothing else. What it does, who it hands over to, who decides and which rules
bind it, it reads from roleALPHA on every run. Change the organisation in roleALPHA, and the
next run follows. You don't edit code and you don't republish anything.

## At a glance

- **One runner for every agent.** A single n8n workflow runs any agent on any step. A new
  agent runs as soon as it is `active` in roleALPHA. The scheduler picks it up on its next
  tick.
- **Nothing hard-coded.** No persons, no roles, no process IDs in workflows or prompts. Only
  technology stays fixed: systems, collections, fields, status values and step custom IDs.
- **Fail-closed.** If roleALPHA cannot be read, or nobody fills the deciding role, the answer
  is "not allowed". It never falls back to a fixed person.
- **Agents never approve.** Approvals are checked against the person filling the deciding
  role and sealed. The channel that sends verifies the seal right before anything leaves.
- **Teams of agents on one step.** Several roles share a step. Each agent does its own part,
  waits for what it needs and is woken when it arrives. Agents that hang are escalated to
  the role that leads their circle.
- **Limits you can change without republishing.** Retries, wait times, run time and tool
  calls come from a settings table and are clamped to fixed bounds.

> **In use, not on npm.** The package runs in production on a self-hosted n8n. It is marked
> `private` and installed from a tarball. See [Installation](#installation-self-hosted-n8n).

## Why it works

**The graph is the job description.** The runner starts with an agent and a step. It reads
the agent's roles (`AGENT_FULFILLS_ROLE`) and the steps those roles are `RESPONSIBLE_FOR`.
It reads the step's predecessors and successors (`DEPENDS_ON`), and who decides on it
(`DECIDES_ON`, else `ACCOUNTABLE_FOR`). From that it builds the system prompt. The agent
itself carries only identity and technology. Its work comes from the purpose and
accountabilities of its roles. Change the role, and the work changes.

**The role first, then the person.** Who decides is a role. Who fills it, a person
(`EXECUTES`) or an agent, is read only after that. Only persons can approve. An agent that
fills a deciding role is ignored on purpose. The address a person signs in with must match
their e-mail in roleALPHA. A display name or a claim by the model never counts.

**Each agent does only its own part.** One step can hold many tasks: research, text, visual,
hand-over. Before a run, **Share** asks a model which of the step's tasks belong to this
agent's roles. **Share → Check** then keeps only duties that really are accountabilities of
those roles, and needs on roles that really sit on the step. The agent gets its part, a
list of what is not its part, and the rules for waiting.

**Waiting is part of the job.** If the text is not there yet, the visual cannot be drawn.
The agent does what it can, records a wait and stops. When the role it waited for finishes
a run, **Wait → Plan After Run** wakes it again. A duty that closes the step waits only on
the deliveries it needs: a result that is named, stored in data and needed for the task.
Informing people or asking them for feedback is no delivery, so a role that only
communicates never holds a hand-over up.

**No double runs, no double wake-ups.** Every run takes a lease first. A second start for
the same agent, step and records is queued, not run. Every wake-up claims its row before it
fires, so two runs that plan at the same moment never wake an agent twice. If a run fails
or dies, its lease is released, and the queued start runs.

**Nobody waits forever.** The scheduler finds waits that nobody answered and wakes them
again. At the attempt limit it stops waking and escalates once to the role that leads the
circle. The message names that role first, then the people filling it.

**Event data is data.** Whatever a trigger delivers (a status change, a comment, a message)
goes into the prompt marked as data, never as instructions. Guardrails take precedence over
event content, and texts that one agent leaves for another are cut to fixed sizes.

## How a run works

```
Scheduler (cron)                        Event router (one webhook)
 └ roleALPHA: List Agents                └ map (collection, status) → step custom ID
   └ roleALPHA: Get Duties                 └ roleALPHA: Get Step → responsible role → active agent
     └ roleALPHA: Is Due (last runs)         ┘
       └──────────────► Runner(agentUuid, step, trigger, event)
                          ├ roleALPHA: Start Run            (run token of the agent, agent:run)
                          ├ roleALPHA: Get Context          (active + guardrails, fail-closed)
                          ├ roleALPHA: Check Responsibility (fail-closed)
                          ├ roleALPHA: Get Step
                          ├ Settings: Resolve               (limits from the settings table)
                          ├ Wait: Check Start               (lease, duplicate-run guard)
                          ├ Share: Build Input → model → Share: Check (cached)
                          ├ roleALPHA: Build System Prompt
                          ├ AI Agent (+ data tool limited to the domains of the agent's roles,
                          │           + roleALPHA: Tool, read only, as the agent)
                          └ Wait: Plan After Run            (done row, wake-ups, lease released)

Scheduler, every tick
 └ Wait: Find Stale Waits → wake (claimed) · remove dead leases · escalate → Get Circle Lead
```

**Every read is the agent's own.** With **Connect As: Agent** the node swaps the function
account token for a run token of the agent (roleALPHA `agent:run`, RFC 8693, 15 minutes).
Context, step, roles and the read tool of the model then see exactly what the agent may
see, without admin rights and without a key per agent in n8n. **Start Run** swaps first and
returns a refusal as data (`code`, `reaction`): an agent that is paused, over budget or not
bound to the account does not run. There is no fallback to the view of the account.

Approval gates follow this order: **Get Decider → Check Approver → Approval Seal: Sign**. The
workflow that sends runs **Approval Seal: Verify** first and stops if the content changed.

## Nodes

### roleALPHA (`roleAlpha`)

| Resource | Operation | What it does | Credential |
|---|---|---|---|
| Agent | Get Context | Reads an agent's context bundle (identity, roles, guardrails). Fails if the agent is not `active` or has no policy, unless you switch that off. Over MCP it reads the `agent` view by default, exactly what the agent gets over its own key. | MCP OAuth2 (default) or roleALPHA Agent Keys API |
| Agent | Get Context Version | Change check. Cheap and not audited with agent keys; over MCP it reads the bundle. | MCP OAuth2 or roleALPHA Agent Keys API |
| Agent | Start Run | Swaps the function account token for a run token of the agent (`agent:run`). Returns `started`, or `code` and `reaction` of the refusal (`pause`, `pauseUntilNextPeriod`, `informAdmin`, `retryLater`, …). The token never appears in the output. | MCP OAuth2 with client credentials |
| Agent | List Agents | Over MCP: every agent of the organisation, paged. With agent keys: one item per key. By default it skips agents that are not active. | MCP OAuth2 or roleALPHA Agent Keys API |
| Responsibility | Get Duties | Lists the steps the agent's roles are `RESPONSIBLE_FOR`, with the circle. | MCP OAuth2 |
| Responsibility | Find Step by Custom ID | Looks up a step by an exact custom ID. | MCP OAuth2 |
| Responsibility | Get Step | Returns a step with its predecessors, successors, parent and child steps, responsible, deciding and accountable roles (with their holders), and policies. With **Role Details** also purpose, accountabilities and domains of each responsible role. | MCP OAuth2 |
| Responsibility | Get Decider | Returns the `DECIDES_ON` role. If there is none, it returns the `ACCOUNTABLE_FOR` role. | MCP OAuth2 |
| Responsibility | Check Approver | **Fail-closed.** Is the acting person filling the deciding role? Only persons count; agents never do. | MCP OAuth2 |
| Responsibility | Check Responsibility | Is one of the agent's roles responsible for this step? | MCP OAuth2 |
| Responsibility | Get Circle Lead | One item per circle of the agent's roles: the role that leads the circle and its holders, e.g. to escalate to. Recognised from a lead flag on the role, else "Lead Link" in its purpose, else a custom ID ending in `:lead`, else the role that decides on or is accountable for the circle. `lead` is null when none is found. | MCP OAuth2 |
| Responsibility | Get Role Holders | Returns the persons (with address) and agents filling a role. | MCP OAuth2 |
| Tool | Call Tool / List Tools | Calls one roleALPHA MCP tool from an allow list, e.g. as the read tool of an AI agent. Tool name `list` returns the allowed tools with their arguments; the organisation is added. Errors come back as data, a refused run ends it. | MCP OAuth2 |
| Prompt | Build System Prompt | Builds the system prompt from the bundle, the step, the duties and the trigger. Event data is passed as data, never as instructions. With a **Share** it adds the agent's part, what is not its part, the rules for waiting within the step, and returns `task` as the user message. | – |
| Share | Build Input | Prepares the model call that decides the agent's part of a step: only the accountabilities of its own roles count, the other responsible roles of the step are listed with theirs. Returns `systemMessage`, `prompt` and `schema` for a structured output parser. Needs Get Step with Role Details. | – |
| Share | Check | Checks the model answer against roleALPHA: drops duties that are no accountability of the agent and needs on roles that are not on the step. Returns `duties` (with `needs`), `notMine`, `waitsFor` and `waitRoleUuids`. | – |
| Wait | Plan After Run | Decides what follows a run on a step from the stored wait rows: the `done` row to add, which waiting agents of the same step to wake (their awaited role just delivered), which rows to remove, and which waits are stuck at the attempt limit. Covers a result that arrived while the agent was deciding to wait. | – |
| Wait | Check Start | Duplicate-run guard. After the runner added a lease row for its run (`state = running`), the oldest live lease of the same agent, step and records wins. A later start does not run; it returns a `queueRow` that runs when the busy run ends. Leases older than the run timeout are dead and released. Fail-closed when the own lease is missing. | – |
| Wait | Find Stale Waits | For a scheduler: waits nobody answered in time (e.g. a person fills the awaited role), queued starts whose busy run died, dead leases, expired rows, and waits at the attempt limit to escalate (`escalate`, reported once). | – |
| Settings | Resolve | Runner limits from defaults and a settings table (`scope, target, key, value`): default < global < step < agent. Every value is clamped to fixed bounds; unknown keys and unusable values are reported in `settingProblems` and never applied. | – |
| Schedule | Is Due | Decides from the step `frequency` (and `termin` / due date) whether a run is due in the current period. | – |

### Approval Seal (`approvalSeal`)

`Sign` seals exactly the approved content together with the approver. Use it after **Check
Approver**. `Verify` recomputes the seal right before anything is sent and stops the
workflow if the content changed.

- **v3** (current): `HMAC-SHA256(key, canonicalJson(['v3', type, fields, approver]))`. The key
  must have at least 32 characters.
- **v2** (legacy): the hash that older code nodes wrote. It is only verified, never signed.
  Set **Legacy Key**, and remove it once no v2 seal is open.

### roleALPHA Trigger (`roleAlphaTrigger`)

Receives `context.changed` webhooks. It checks `X-RA-Signature: sha256=<hmac>` against the raw
body and answers `401` if the signature is wrong. Register the production URL in roleALPHA
under the agent → *Context & Access*.

## Credentials

| Credential | Content |
|---|---|
| **MCP OAuth2** (n8n built-in) | Access to the roleALPHA MCP endpoint for one organisation. Used for agents (default source) and for every traversal. The `agent` view needs admin rights on the tenant. For **Connect As: Agent** it must be a roleALPHA function account (grant type Client Credentials) whose role has `agent:run` and that may run the agent ("May run these agents"). |
| **roleALPHA Agent Keys API** | Optional, for the `Agent Keys` source. `baseUrl` of the data node, and `keys`: `{"<agent uuid>": "agt_…"}`, or a list of `{agentUuid, key, label}`. An agent key reads only its own agent, so it cannot traverse. |
| **roleALPHA Webhook API** | One signing secret, a JSON list of secrets, or a map from agent UUID to secret. |
| **Approval Seal API** | `key` (sign and verify) and optionally `legacyKey` (verify v2 only). |

Agent keys and webhook secrets are issued in the roleALPHA interface and shown only once.
Store them nowhere except in these credentials.

## Settings

The runner reads its limits from a table with the columns `scope, target, key, value`. A row
with `scope = global` applies to every run. `step` (target: step UUID or custom ID) and
`agent` (target: agent UUID) narrow it down. The order is default < global < step < agent.

| Setting | Default | Bounds | Meaning |
|---|---|---|---|
| `maxWaitMinutes` | 60 | 5–10080 | A wait nobody answered is started again by the scheduler after this time |
| `maxAttempts` | 5 | 1–20 | Wake-ups per wait; at the limit the wait is escalated and never woken again by itself |
| `keepDoneHours` | 168 | 1–2160 | How long `done` and `escalated` rows are kept |
| `maxIterations` | 15 | 1–50 | Tool calls of the agent per run |
| `runTimeoutMinutes` | 15 | 1–120 | A run older than this counts as dead; its lease is released |
| `escalate` | true | – | Report stuck waits to the role that leads the circle |
| `shareCacheHours` | 24 | 0–720 | Reuse a share decision while step, roles and trigger kind stay the same (0 = never) |

A row with a value outside the bounds is clamped and reported. A wrong row can make the
runner more careful, never unbounded.

Wait rows live in any store of the workflow, for example an n8n data table with the columns
`state, step_uuid, step_custom_id, agent_uuid, agent_name, roles, waits_for, reason,
record_keys, event, run_id, attempts, progress, at`.

## Security

- Every check is fail-closed. If roleALPHA cannot be read, the result is "not allowed".
- Agents never approve. Check Approver ignores agents that fill the deciding role.
- Runs act as their agent: the run token carries the agent's view, writes only drafts, and is
  never written to node output. A refused swap stops the run; there is no fallback.
- Rights go into the tools from the check, never from the model. The data tool sees only the
  collections in the domains of the agent's roles.
- The prompt marks trigger payloads as data. Guardrails take precedence over event content.
- Keep `requireActive` and `requireGuardrails` on in production.
- Settings are clamped to fixed bounds.
- Duplicate runs are blocked by leases, and wake-ups are claimed before they fire.
- No credentials are kept in wait, settings or cache rows. The share cache key holds no
  record content, and a cached answer is checked again like a fresh one.

Found a security problem? Please do not describe it in a public issue. Open an issue that only
asks for a contact, and roleALPHA GmbH will get back to you.

## Installation (self-hosted n8n)

### Requirements

- A self-hosted n8n with access to its custom extensions folder
- A roleALPHA organisation and an MCP OAuth2 credential for it
- Node.js and npm to build the package

### Build and install

```bash
git clone https://github.com/roleALPHA/n8n-nodes-rolealpha.git
cd n8n-nodes-rolealpha
npm install
npm run build
npm test
npm pack                     # → n8n-nodes-rolealpha-<version>.tgz

# on the n8n host (custom extensions folder, e.g. ~/.n8n/custom):
npm install /path/to/n8n-nodes-rolealpha-<version>.tgz
# restart n8n
```

### Updating

Build and pack the new version, install the tarball over the old one in the same folder,
and restart n8n. Workflows keep their nodes. New parameters start with their defaults.

## Things that trip people up

**1. The `agent` view needs admin rights.** **Get Context** reads, by default, exactly what the
agent would receive over its own key. That view needs admin rights on the tenant. Without
them, switch to the `caller` view, and know that it shows what the connection may see, not
what the agent sees.

**2. An agent key cannot traverse.** It reads its own agent and nothing else. Every
Responsibility operation needs the MCP OAuth2 credential.

**3. Keep `runTimeoutMinutes` at or above the workflow timeout.** If a lease counts as dead
before the run really ends, a queued start can run while the first one is still busy.

**4. The circle lead must be recognisable.** **Get Circle Lead** looks for a lead flag, "Lead
Link" in the purpose, a custom ID ending in `:lead`, or the role that decides on or is
accountable for the circle. If none fits, `lead` is null, and the escalation names the
circle instead of a role.

**5. Write status values exactly.** Steps are mapped to records by step custom ID and status
value. Those are the technical values that may stay fixed, so a typo in one of them is
not caught by the graph.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Agent … is not active in roleALPHA` | The agent's status in roleALPHA is not `active`. Expected: it does not run. |
| `Agent … is bound by no policy` | No policy binds the agent. Bind one, or switch off `requireGuardrails` for tests only. |
| `None of the roles is responsible for this step` | None of the agent's roles is `RESPONSIBLE_FOR` the step. Check the role, not the agent. |
| A start returns `queueRow` instead of running | Another run of the same agent, step and records holds the lease. The queued start runs when that run ends. |
| `No lease of this run was found; refusing to start` | The runner did not add its lease row before **Check Start**, or the store did not return it. |
| The agent stops with a max-iterations error | The agent needed more tool calls than `maxIterations`. Raise it for that step with a `step` row in the settings table. |
| A wait is never woken | Nobody of the awaited role ran on the same records. The scheduler wakes it after `maxWaitMinutes`, and escalates at `maxAttempts`. |
| `settingProblems` is not empty | A row in the settings table has an unknown key or scope, or a value outside the bounds. The message names the row. |
| `roleALPHA refused the run: agent_nicht_gebunden` | The function account may not run this agent. Add the agent under "May run these agents" of the account. |
| `roleALPHA refused the run: kein_agent_run_recht` | No role of the function account has `agent:run`. |
| `Acting as an agent needs a function account` | The MCP OAuth2 credential uses another grant type. Use the client ID and secret of a function account. |
| `MCP initialize failed with HTTP 429` | Many runs started at once and roleALPHA turned some away. The client repeats a call turned away with 429 or 503 up to four times (Retry-After, else 1, 2, 4, 8 s). If it still fails, start fewer runs at once. |
| `Empty MCP response` | The server answered with no body. Reading calls are repeated; a writing tool is not, so it cannot run twice. |
| `Cannot access "arguments" due to security concerns` | n8n blocks the name `arguments` in expressions and in `$fromAI`. Name the tool input `toolArgs` or `args`. |
| Webhook answers `401` | The `X-RA-Signature` does not match. Check the secret in **roleALPHA Webhook API**. |

## Licence

**MIT.** The terms are in [LICENSE](LICENSE). Use it, change it, build on it, commercially
too. roleALPHA itself is a separate product and not covered by this licence.

## Contributing

```bash
npm install
npm run build
npm test
```

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist` and copy the node icons |
| `npm test` | Compile the tests and run them with Node's test runner (`test/*.test.ts`) |
| `npm run lint` | `tsc --noEmit` |

The logic lives in `lib/` and is tested without n8n. The node files in `nodes/` only map
parameters to it. Keep it that way: a rule that decides who may act belongs in `lib/` with
a test.
