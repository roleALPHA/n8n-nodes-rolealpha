# @rolealpha/n8n-nodes-rolealpha

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
- **Workflows that follow the organisation.** When a step is created or changed in roleALPHA,
  or an entity a workflow is bound to changes or is removed, a model proposes what that means for the n8n workflows. The
  proposal becomes an inactive draft, and only a person filling the deciding role can apply it.
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

## Workflows that follow the organisation

Most changes in roleALPHA need no workflow change at all: the runner reads roles, duties and
deciders on every run. What roleALPHA cannot know is technology: a new step needs a trigger, a
schedule or a mapping of (collection, status) to its custom ID. The **roleALPHA Workflow
Builder** closes that gap without letting a model change production on its own.

```
Scheduler (every 15 min)
 └ Workflow Builder: Detect Changes          list_changes since the last run: new / changed
   │                                         steps, changed / removed bound entities
   └ per change: Workflow Builder: Propose    rule first, else ← chat model; checks the answer
                    ├ Create Draft            inactive, tagged rolealpha-draft, with what changes
                    │ └ roleALPHA: Get Decider (governing step; for Code nodes the code step)
                    │   └ per person: Issue Approval Tokens → e-mail with approve / reject link
                    └ nothing usable → e-mail to the same people; model away → again next run

Approval link (GET)  → Verify Approval Token → page with a confirm button
Confirm button (POST)
 └ Verify Approval Token → Read Draft → roleALPHA: Check Approver (that step, fail-closed)
   ├ approve → Workflow Builder: Apply Draft   only with the hash in the token
   └ reject  → Workflow Builder: Discard Draft
```

**Detect** asks roleALPHA's `list_changes` what changed effectively since the last run:
approved drafts and every relationship change, fanned out to each end. That is one call per
run, whatever the size of the organisation. It keeps the cursor in the workflow's static data,
so no table is needed; the first run starts now and reports nothing from before. What counts:

- new and changed entities of the watched types (default: steps), and
- changed entities a managed workflow is bound to, whatever their type.

What does not: relationships the runner reads at run time (who decides, is accountable,
responsible, consulted or informed, who holds a role, which policy applies). A new holder or a new decider changes no workflow, so it costs no model
call. A change names what changed, not the old values: the model compares the entity as it is
now with what the workflows do. **Skip Own Changes** also leaves out what the connection's
account proposed or approved (`ownChange`); use it only with an account of its own, since with
a personal login it would leave out that person's approvals too.

A deleted entity does not appear in the feed itself; its neighbours get a relationship whose
other end is gone. Then, and when the cursor was lost, Detect asks for every bound entity
whether it still exists. Only "not found" counts as removed; an entity it cannot tell is asked
for again next run. A failed read of the feed fails the run and keeps the old cursor.

**Propose decides clear cases itself**, with the same result every time and no model call
(`decidedBy: rule`, and `rule` says which):

| `rule` | When, and only if no workflow depends on the step |
|---|---|
| `own_step` | The custom ID starts with one of **Own Step Prefixes** (default `automation:`). This one applies even if a workflow depends on it. |
| `draft_waiting` | A draft already covers this change. `list_changes` delivers at least once. This one too. |
| `decision` | The step is a gate: a person decides, and the approval reads who at run time. |
| `grouping` | The process only groups other steps; they get their own proposals. |
| `scheduled` | The step has a frequency and the generic scheduler starts it (**Scheduler Covers Frequency**, on by default; switch it off without such a scheduler). |
| `retired` | The step is archived or retired. |

**For the rest it asks the model**, and gives it the change, the entity as roleALPHA shows it now
(a step with its roles, never persons), the managed workflows, which of them the change
affects (bound to the entity, or to a step right before, after, above or below it), the
credentials they use, all other workflows with their triggers (to read, not to change) and the
runner with its inputs. An update for a neighbouring step leaves the binding as it is: the
workflow does not become bound to the neighbour.

**Templates** cover what most steps need: a trigger, then the agents responsible for the step,
then the runner. The model only answers `template: schedule` with a cron expression, or
`template: event` for a step another system starts over a webhook. The builder writes the
workflow, so it looks the same every time, and maps the inputs from what **Runner Workflow**
declares. Agents and step are read at run time. The webhook needs a Header Auth credential, and
the sender has to be set up in the other system; the mail says so. Anything else the model
writes itself.

**Its answer is checked**, and a failed check goes back to the model once more with the problems:

- only node types from the allow list; nodes that run commands or unreadable code never,
- no e-mail address and no UUID in any parameter: those are read from roleALPHA at run time,
- no expression that reaches `$env`, `$secrets`, `$vars`, `process`, `require` or `constructor`,
  or reads a node that is not in the workflow,
- only credentials already used by managed workflows, plus the roleALPHA credential of Propose
  itself; a node that stays keeps its own credentials, IDs and webhook IDs,
- updates and deactivations only of managed workflows, connections only between existing nodes,
- a trigger, and every node connected to it,
- a sub-workflow call only to a workflow that exists, with inputs it declares,
- no second workflow with the same name or webhook path, and none for a step another workflow
  already names.

What was approved before stays as it is: a node the model returns unchanged is not checked again.

**Nothing gets lost.** If the model or roleALPHA is away, Propose returns `ok: false, retry: true`
and *Detect Changes* brings the change back in the next runs, up to five tries in all. What
cannot be proposed in the end, or fails the check twice, goes by e-mail to the people who decide
(`Needs attention?` in the example). A later change of an entity replaces its waiting draft;
the links of the older draft then do nothing.

**Code nodes** are off by default. With **Allow Code Nodes** the model may use them for data
shaping, and each new or changed one has to pass:

1. **The environment is closed.** With `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` every Code node is
   refused, because it could read the secrets of the container.
2. **The code check**, an allow list on the syntax tree: `$input`, `$json`, `$('Node')` of this
   workflow, and `JSON`, `Math`, `Date`, `Array`, `Object`, `String`, `Number`, `Boolean`,
   `RegExp`, `Map`, `Set`, `Error`. No `this`, `await`, classes, `$env`, network or modules, no
   way to `constructor`, and no dynamic keys like `row[key]`: they are the way around any list
   of forbidden names, and `new Map(Object.entries(row)).get(key)` does the same safely.
3. **Its own tests.** The model has to deliver test cases, and they run before anyone sees the
   draft. A failed test goes back to the model.
4. **A step of its own.** The mail shows the code word for word and goes to the role deciding
   on `codeGoverningStep`, so it can be a different role than for other changes. Which step
   applies is read from the draft, not from the link. **Apply Draft** refuses changed code
   without **Code Approved**, so an older approval workflow fails closed.

The check and the tests are one layer, not a sandbox: run Code nodes in external task runners
(`N8N_RUNNERS_MODE=external`) with `NODE_FUNCTION_ALLOW_BUILTIN` and
`NODE_FUNCTION_ALLOW_EXTERNAL` empty. The node can only test code, not run the whole workflow:
n8n's API has no test run, so read the draft before approving it.

**Drafts** show what they change: `diff` and `reviewHtml` list new, changed and removed nodes and
connections, and any new code. They carry everything Apply needs in a sticky note named `roleALPHA binding`: the action,
the target, the target's version and the content hash. **Apply** refuses when the draft no
longer has the approved hash or the target changed after the draft was made. A managed workflow
is one with that note and the tag `rolealpha-managed`; nothing else is ever touched.

**Approval links** carry a token signed with the Approval Seal key: `at1.<claims>.<HMAC>`. It
names the draft, its content hash, one person and one decision, and it expires (7 days by
default, at most 30). Nobody can make or change one without the key, so the approval webhook
can be public and needs no single sign-on. A link works once: Apply and Discard remove the
draft, and a second use finds none. Whether the person may decide is checked when they
confirm, not when the mail was sent, so a link of somebody who left the role does nothing.
Opening a link only shows a confirm page; mail scanners that open links decide nothing.

### Setting it up

Two ready workflows are in [`examples/`](examples). Installing the package does not set them
up: n8n runs no code of a community package at install, so the credentials have to be created
once by hand. No data table is needed; *Detect Changes* keeps its cursor in the workflow.

1. **Release the modules for AI in roleALPHA** (*AI settings → data release*). Without a
   released module `list_changes` fails instead of reporting nothing.
2. **Create the credentials** (see [Credentials](#credentials)):
   - **MCP OAuth2** for roleALPHA. It sees what its access may see: steps hidden from it are
     neither watched nor reported.
   - **n8n API** with an API key from *Settings → n8n API*. *Detect Changes* uses it too, to
     read which entities the managed workflows are bound to. When `/api` is not reachable from
     outside, use `http://localhost:5678/api/v1` as base URL.
   - **Approval Seal API** with a random key of at least 32 characters. It signs the approval
     links; keep it secret, anybody with it can make links.
   - A chat model (e.g. **Anthropic**) and **SMTP** for the approval e-mails.
3. **Import both workflows**, `workflows-follow-the-organisation.json` and
   `approve-workflow-drafts.json`, and pick the credentials on every node that asks for one.
4. **Fill in Settings** in both workflows: `endpointUrl` and `organisation` of roleALPHA,
   `governingStep`, and in the first one `n8nUrl`, `approvalUrl` (`<n8nUrl>/webhook/rolealpha-workflow-approval`)
   and `mailFrom`. On *Propose* set **Runner Workflow** to the name or ID of your runner, and
   **Extra Rules** to your systems. Without a runner the model gets no templates. In the
   second workflow also set `governingStep` and `codeGoverningStep`.
5. **Set up the governing step in roleALPHA**, as described in the next section. Without it
   nobody may approve, and every draft stays a draft.
6. **Activate** *Approve workflow drafts* first, then *Workflows follow the organisation*. The
   first run starts now and only checks that the bound entities still exist; changes are
   reported from the second run on. The cursor is kept only by runs of the active workflow:
   a manual test run starts afresh each time.

### The governing step in roleALPHA

Who may approve a workflow change is not set in n8n but in roleALPHA, on one step. The
workflows find it by its custom ID (`governingStep` in Settings) and ask roleALPHA for its
deciding role on every mail and on every click.

1. **Create the step.** Add a process entity (entity type *Value Creation*) with:

   | Field | Value |
   |---|---|
   | Name | e.g. *Workflow-Änderungen freigeben* |
   | Custom ID | `automation:workflow-changes`, exactly as in `governingStep` |
   | Subtype | `gate` (a decision by a person) |
   | Frequency | `event_driven` |
   | Description | What is decided: drafts of the Workflow Builder, applied only after approval |
   | Criteria | What the approver checks, e.g. the draft fits the change, uses only existing credentials, holds no names, addresses or IDs, touches no other workflows |

2. **Name the deciding role.** Draw `DECIDES_ON` from the role that decides to the step
   (source = role, target = step), e.g. from *IT-Administration*. Get Decider reads
   `DECIDES_ON` first and falls back to `ACCOUNTABLE_FOR`; drawing both, from the same role,
   is clearest. More than one deciding role is allowed.
3. **Fill the role with people.** Each person who fills the role (`EXECUTES` from person to
   role) needs an e-mail address in roleALPHA. Every one of them gets their own mail with
   their own links; the first who confirms decides, and the others' links then do nothing.
   Agents that fill the role get no mail and can never approve.
4. **Approve the drafts in roleALPHA.** Writes through MCP are drafts; the step and its edges
   count only after a person approves them there.

Changing who approves later needs no change in n8n: give the role to someone else, or point
`DECIDES_ON` at another role. The next mail goes to the new holders, and links of someone who
no longer fills the role do nothing. A person who fills two deciding roles of the step gets
one mail per role.

### The builder's own steps

The builder may be modelled in roleALPHA like any other value chain: a process with the steps
*detect changes*, *propose a draft* and the governing step, a role responsible for them and an
agent that fills the role. Give these steps custom IDs of one prefix, e.g.
`automation:workflow-detect` and `automation:workflow-propose`, and name the prefix in **Own Step
Prefixes** on *Propose* (default `automation:`). They then never reach the model.

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

### roleALPHA Workflow Builder (`roleAlphaWorkflowBuilder`)

| Operation | What it does | Credential |
|---|---|---|
| Detect Changes | Reads `list_changes` from the cursor kept in the workflow (or the **Cursor** option). Returns `changes` (`created`, `changed`, `removed`, each with `relationships` and the bound `workflows`), `cursor`, `hasMore`, `started`, `checked`, `unreadable` and `skipped`. | MCP OAuth2, n8n API |
| List Workflows | The managed workflows with their bound entities and the credentials they use. | n8n API |
| Propose | Needs a chat model on its **Model** input. Returns `ok`, `action` (`create`, `update`, `deactivate`, `none`), `reason`, `workflow`, `contentHash`, `problems`, `notes`, `decidedBy` (`rule`, `model`, `failed`), and where they apply `rule`, `template`, `code` and `retry`. | MCP OAuth2, n8n API |
| Create Draft | Stores a proposal with `ok = true` as an inactive draft and replaces an older draft of the same entity. Returns `draftId`, `contentHash`, `diff`, `codeChanged`, `codeNodes`, `reviewHtml` and `replacedDrafts`. | n8n API |
| Read Draft | What a draft changes against its target: `action`, `contentHash`, `diff`, `codeChanged` and `codeNodes`. | n8n API |
| Apply Draft | Applies a draft given the approved hash. Optionally activates a new workflow. Refuses changed Code nodes without **Code Approved**. | n8n API |
| Discard Draft | Deletes a draft; refuses any workflow that is not a draft. | n8n API |
| Issue Approval Tokens | `approveToken` and `rejectToken` for one person, bound to `draftId` and `contentHash`, plus `tokenExpiresAt`. Keeps the input fields. | Approval Seal API |
| Verify Approval Token | Returns `draftId`, `contentHash`, `approver`, `decision` and `expiresAt` of a valid token; fails on a changed, foreign or expired one. | Approval Seal API |

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
| **n8n API** (n8n built-in) | API key and base URL of the n8n instance the Workflow Builder manages. When the nodes run in that instance, `http://localhost:5678/api/v1` works even if `/api` is closed to the outside. |
| **Approval Seal API** | `key` (sign and verify seals and approval tokens) and optionally `legacyKey` (verify v2 seals only). |

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
- The Workflow Builder never activates or changes a workflow by itself. A proposal is an
  inactive draft; Apply needs the hash that was sent to the approver and a target that did not
  change since. The approval link is a signed one-time token for one person and one decision;
  Check Approver decides at use whether that person may still decide.
- Duplicate runs are blocked by leases, and wake-ups are claimed before they fire.
- No credentials are kept in wait, settings or cache rows. The share cache key holds no
  record content, and a cached answer is checked again like a fresh one.

Found a security problem? Please do not describe it in a public issue. Open an issue that only
asks for a contact, and roleALPHA GmbH will get back to you.

## Installation (self-hosted n8n)

### Requirements

- A self-hosted n8n that allows community nodes
- A roleALPHA organisation and an MCP OAuth2 credential for it

### Install

In n8n, open **Settings → Community Nodes → Install** and enter
`@rolealpha/n8n-nodes-rolealpha`. Or, on the n8n host:

```bash
cd ~/.n8n/nodes
npm install @rolealpha/n8n-nodes-rolealpha
# restart n8n
```

### Updating

Update the package under **Settings → Community Nodes**, or run
`npm install @rolealpha/n8n-nodes-rolealpha@latest` in the same folder and restart n8n.
Workflows keep their nodes. New parameters start with their defaults.

### Coming from `n8n-nodes-rolealpha` (up to 0.4.x)

Up to 0.4.x the package was installed from a tarball under the name `n8n-nodes-rolealpha`.
n8n stores the package name in every node type, so a node from the old package is
`n8n-nodes-rolealpha.roleAlpha` and one from this package is
`@rolealpha/n8n-nodes-rolealpha.roleAlpha`. Both packages can be installed side by side.
Install this one, switch each workflow's nodes over, and then remove the old package.
Credentials are not tied to the package name and stay as they are.

### Building from source

```bash
git clone https://github.com/roleALPHA/n8n-nodes-rolealpha.git
cd n8n-nodes-rolealpha
npm install
npm run build
npm test
npm pack                     # → rolealpha-n8n-nodes-rolealpha-<version>.tgz
```

### Releasing

Bump `version` in `package.json`, commit, and push a tag `v<version>`. The GitHub Action
**Publish to npm** builds, tests and publishes the package with provenance. It uses npm
trusted publishing, so there is no npm token anywhere: on npmjs.com the package settings name
this repository and the workflow file `publish.yml` as its trusted publisher.

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
| `MCP initialize failed with HTTP 429` | Many runs started at once and roleALPHA turned some away (120 calls per minute and access). The client repeats a call turned away with 429 or 503 up to four times and waits as long as the server asks (Retry-After or RateLimit-Reset, else 1, 2, 4, 8 s). If it still fails, start fewer runs at once. |
| `Empty MCP response` | The server answered with no body. Reading calls are repeated; a writing tool is not, so it cannot run twice. |
| `Cannot access "arguments" due to security concerns` | n8n blocks the name `arguments` in expressions and in `$fromAI`. Name the tool input `toolArgs` or `args`. |
| Propose returns `ok: false` | The model's answer failed the check twice; `problems` says why. Often a node type outside the allow list or a hard-coded address. Add what the model needs to **Extra Rules**. |
| Propose returns `retry: true` | The model or roleALPHA was away. The change comes back in the next run, up to five tries in all. |
| A template fails with `set Runner Workflow` | **Runner Workflow** on *Propose* is empty or names no workflow. |
| A Code node is refused with `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` | n8n leaves the environment open to Code nodes. Move what workflows read from `$env` into credentials, then set it to `true`. |
| `This draft changes Code nodes and was not approved as such` | The approval workflow does not set **Code Approved**. Take *Read Draft* and the check against `codeGoverningStep` from the example. |
| A step with a frequency never gets a workflow | **Scheduler Covers Frequency** expects a generic scheduler to start it. Switch it off if there is none. |
| `The draft changed after it was proposed or approved` | Somebody edited the draft, or the link carries another hash. Discard it; the next change proposes again. |
| `Workflow … changed after the draft was made` | The target was edited after the draft. Discard the draft and let the builder propose again. |
| Detect fails with `kein Modul für die KI freigegeben` | No module is released for AI in roleALPHA. Release it under *AI settings → data release*. |
| Detect reports `hasMore: true` | More changes waited than **Max Pages** × 500. The next run goes on from there. |
| Detect reports the same change twice across runs | `list_changes` delivers at least once, after a restore of the tenant also known changes again. Proposals for them usually come back `none`. |
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
