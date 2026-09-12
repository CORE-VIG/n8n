# Aon inside n8n — what is what

Aon is the owner's personal-assistant system, built into this n8n. n8n gives
it the automation engine, the integrations, the credentials and the editor;
Aon gives it a conversational actor, autonomous agents, a memory, hands and a
conscience. Every part below has one job. A part never does another part's
job, so nothing steps on anything.

Reviewed against n8n's own model on 2026-09-12 (Codex, read-only). Where a
part is planned rather than built, it says so.

## The actors — the parts that reason

**Assistant.** Aon's conversational actor, presented in the window. It acts
only during a turn the owner started (in the window, or from a channel such as
Telegram) and only within that turn. It may use the capabilities its scope and
Guard allow: workflows and their executions, credentials, Hands, memory, Aon
agents and n8n agents; the browser and the voice sidecar; its skills. It can
create, change, run, review and retire workflows and agents alike, each
effect passing Guard. It is not an agent (it never acts on its own) and not a workflow
(it reasons). It decides Guard cards and pending facts only as the owner's
hand: `guard_decide` and `memory_fact_decide` refuse the call outright when
the identity behind it is an agent's run, not the owner.

**Agent** (an Aon agent). A script that executes one bounded charter for the
owner, on its own. Unlike a workflow, it reasons. Its charter is the
combination of

- *orientation* — its purpose, persona, what it owns, the sources it reads;
- *rules* — standing rules the owner wrote, and learned rules promoted from
  the evidence of its own runs (canary first, then kept or revoked); a rule
  belongs to the agent, not to memory;
- *skills* — the procedures (SKILL.md) it may follow;
- *tools* — the capabilities it may call, scoped to it;
- *Guard* — the tiers it may act within by itself, and who approves the rest;
- *deliverables* — what it owes: a named outcome with a definition of done,
  single or recurring, and who judges that it is done.

An agent is registered in Aon's runtime and produces *runs*. It may create,
change, run, review and retire workflows, as means to its deliverables, and
may ask for other agents. An agent is never a workflow, and a workflow is
never an agent. Agents are authored by the owner on their page or by the
assistant through its tools (an agent may propose one, behind a card).

**n8n agent.** n8n's own first-class agent product, the "Agents · Preview"
module: it can run through its Preview chat, integrations, scheduled tasks or
workflows, and it is not the AI Agent node. In Aon it is the cheap tier
(Ollama, OpenRouter) and something the assistant or an Aon agent may build and
use; that is a routing choice, not its definition. It is never called just
"agent": "agent" alone always means an Aon agent.

## The mechanisms — the parts that do not reason

**Workflow.** An n8n graph with fixed orchestration: nodes and connections,
started by a trigger (time, webhook, event, a person). Its path can branch
and its nodes can call models, but the workflow itself exercises no
judgement; any reasoning belongs to an actor it invokes. Built by the owner,
the assistant or an agent. It lives in n8n; its effectful nodes answer to
Guard like every other effect. A workflow reaches Aon through the Aon node:
run an agent's deliverable as a means to the workflow's own end, or search or
capture memory. It never speaks to the assistant — there is no such
operation on the node, on purpose, because nothing scheduled or third-party
may invoke the assistant as if the owner spoke.

**Routine.** A deliverable's cadence, kept by the executor: a `recurring`
deliverable carries a cron expression, the executor computes its next due
time from the last run and queues a run for its agent when it is due, and a
stopped, failed or denied run waits for the next cadence rather than
retrying at once. A routine has no rules of its own and never invokes the
assistant. (A workflow may also start an agent's run through the MCP tools;
that is a workflow using an agent, not a routine.) Built.

**Channel bridge.** A workflow that authenticates one message from the owner
on a channel (Telegram, and later others), relays it to the assistant as an
owner-initiated turn, and relays the reply back. It never reasons, and a
scheduled or third-party message never passes through it as if the owner
had spoken: the bridge checks both the chat and the sender against the
owner's ids. Voice notes travel the same way (heard and answered through
the voice sidecar). Built for Telegram.

**Executor.** The non-reasoning runtime that claims a run from one charter
version, starts it, records it, asks the judge for the verdict, keeps the
routines, the breaker and the budget. Built.

**Judge.** The actor a deliverable names to decide whether its definition of
done is met: the owner, or a model call the executor makes on the
deliverable's behalf, always a different model than the maker. A judge
decides; it never acts. Built.

**Graph.** The shape of an automation whose steps have dependencies: each
step runs once, branches fork on a condition and merge back, and the whole
converges. In n8n, a workflow with IF/Switch branches and Merge nodes; in
Aon, a `single` or `recurring` deliverable, or a parent run with child runs.
A graph needs every branch to end somewhere and no edge pointing backwards.

**Loop.** The shape of an automation that repeats a step until a check passes
or a stop rule fires. In n8n, Loop Over Items or an edge that routes back; in
Aon, a `goal` deliverable, where the judge is the check and `maxIterations`
is the stop rule. A loop always needs both the check and the stop rule; one
without the other is not a loop, it is a runaway. Every builder — the
assistant, an agent — names the shape before building (skill `loop-vs-graph`).

**Skill.** A procedure written down (SKILL.md) that any actor may follow;
Aon's live in the CLI home's `.claude/skills/` (canonical copies in the
fork's `aon-skills/`). A skill is knowledge, not an actor. The six built-ins:
`loop-vs-graph`, `aon-memory`, `n8n-workflow-quality`, `dogfood`,
`aon-reasoning`, `aon-plan`.

**Run.** One recorded attempt by an Aon agent toward a deliverable: queued,
claimed, running, judged, then done, failed or stopped, with its output and
its cost. A *workflow execution* is n8n's record of a workflow; an *n8n agent
run* is n8n's record of its agent. The three are never mixed up.

**Tool.** A callable capability assigned to an actor. It can come from a
node, a workflow, Hands, custom code or an MCP server. A tool is a verb, not an
actor. The instance's *MCP server* is the authenticated transport that exposes
selected capabilities as tools; it does not reason or own work. Every function
of Aon that the pages offer is also a tool, so the assistant can do from the
chat whatever the owner can do from a page, within Guard; the only exceptions
are the card secret, voice audio in and out, and the Telegram bridge, which
are not tools by design.

**Rule.** A constraint on one actor: standing (written by the owner) or
learned (promoted from run evidence; canary, then kept or revoked).

**Effect.** Anything that changes persistent or external state, sends data,
spends money or grants access.

**Guard.** The permission system: every effect is classed, the class has a
tier, the tier has a policy, and what the policy does not allow goes to the
approver — the owner — as a card. Guard checks the concrete call before it
executes, for the assistant, for agents, for the browser and for Hands; an
approved card authorizes exactly one retry of the call it was raised for.
Built (`aon-core/guard`): sixteen-plus effect classes in tiers 0–4, policies
per identity, cards with a day's expiry, an audit trail, cards relayed to
Telegram. A run the Aon node starts is recorded under its own identity,
`workflow:<id>`, in that audit trail — a record of where the run came from,
not a gate: the owner's key already authorized the call. Not yet under
Guard: the effectful nodes of workflows, which run with their own
credentials as n8n always did; that is the remaining gap between today and
the invariant.

**Council.** Guard's automatic approver for a tier-3 card, when a standing
rule says so: the owner sets one identity's policy for one op class to
`council` on the Guard page, and only then does a card of that shape ever
reach it. It never rules on money, access, sending mail, writing the
calendar, acting on a web page, publishing a workflow, or an agent's own
charter — human-only by code, not by a policy row a standing rule could
widen, and tier 4 is human-only in general. When it may rule, two
independent models (haiku and sonnet) each read the card, the identity's
standing rules and its last ten decided cards, and each must cite a
standing rule that resolves the case; both must approve and both must cite
one, or nothing happens. Every op class starts in shadow: the council rules
and records what it would have done, but the owner still decides every
card. An op class goes live — the council decides for itself — only once
its last twenty shadow rulings are decided with zero false approvals (the
council said yes where the owner said no), and the owner has not pinned it
back to shadow by hand. A live approval decides the card as `council`, runs
the same resume path an owner's approval does, and is the only council
ruling that reaches Telegram. Built (`aon-core/guard/council`).

**Memory.** What Aon has read: captured sources → chunks (searched by word and
by meaning) → facts and entities (extracted). Capture and extraction are its
only writers; actors ask for a capture, they never write records directly.
Memory keeps the evidence a learned rule came from; the rule belongs to its
agent. Search, capture and extraction (a small model, every minute, within
its own monthly budget; every fact it proposes is pending until the owner
confirms or rejects it) are built. A page is a source of kind `page`: not
read once like a capture, but authored by the owner (or written on his
behalf) and replaced in place by title, the way a note gets updated rather
than piling up copies. Once a day, the dream rereads the facts, the newest
sources and the observations and rewrites a five-bucket model of the owner
(identity, people, projects, preferences, commitments), within the same
monthly budget, replacing the previous version rather than piling up copies.
`memory_about_me` and `memory_context` are how an actor reads that model and
the context around a topic before acting on his life, his people or his
projects.

**Hands.** The fenced workspace where commands run and files live, for the
assistant and for agents (and, through the same service, for n8n agents).
A command has no network unless Guard leases it, and a lease is the
allowlist proxy (package registries, GitHub, model hubs; every connection
logged), never the host's network. Workflows do not use Hands; they use nodes.

**Browser.** A fenced browser on the host (Obscura, reached over its own MCP
endpoint), for the assistant and for agents. `web_read` is tier 1: it opens a
public page and returns its title, text and links. `web_act` is tier 3: it
drives the same browser — navigate, click, type, wait, snapshot, screenshot —
in one lease. One lease at a time; a fresh one clears cookies and closes
tabs before it starts and closes tabs again on the way out, however it
ended. A private address, a local name, or this instance's own host is
refused before the browser is ever asked; Obscura refuses a private address
again on its own side, which is also where DNS rebinding is caught.

**Voice.** A host sidecar (`aon-voice`) that hears and speaks for the window
and for the channel bridge — nothing more. It turns a recorded clip into
text and turns text into spoken audio; it never reasons and never decides
what to say. The window has a mic and a "read aloud" toggle; a Telegram
voice note is transcribed before the turn runs, and a reply can come back
as audio too. The sidecar being down is a normal state, not an error: every
route answers with a plain "can't hear/speak right now" and the assistant
still works by typing.

**Google.** Gmail, Calendar, Drive and Sheets, reached through the owner's own
n8n credential (`googleOAuth2Api`, or one of the services that extend it),
never a separate app registration. `aon-google-auth.service.ts` finds the
credential named "Aon Google" (or the oldest of the Google family the owner
owns), decrypts it the way `CredentialsHelper` does, and refreshes an expired
access token against Google's token endpoint, persisting the refreshed token
back the way n8n's own OAuth2 refresh does — with no node or workflow behind
it, since these are on-demand tool calls, not an execution. Reads (`mail_search`,
`mail_read`, `calendar_list`, `drive_search`, `drive_folder`, `drive_read`,
`sheet_read`) are tier 0; a draft, a label change, a new Drive file or a
sheet write are tier 1; sending mail and any calendar change are tier 3, so
the owner sees a card before either leaves this instance. Google being
unconfigured is a normal state: every tool then answers with the credential's
name and the scopes it needs, not an error.

**Owner.** The person. Guard's final approver, and the only one who
authorizes publication; an approved actor may carry it out.

## The rules that keep the parts apart

1. Only actors reason: the assistant, Aon agents, n8n agents. Everything else
   executes exactly what it was given.
2. Every effect passes Guard, whoever asks for it, by whatever path (the
   target; see Guard for what is enforced today).
3. Every mutable artifact — a workflow, a charter, a skill, a file in Hands, a
   credential — has one authority at a time; other actors propose changes,
   and every write checks the artifact's version (n8n does this for
   workflows today; Aon's own artifacts get it with the executor).
4. Names are exact: "agent" is an Aon agent; n8n's are "n8n agents"; the
   window is "the assistant"; a scheduled wake-up of an agent is "a routine";
   agents have runs, workflows have executions.
5. A workflow that needs judgement is the wrong tool: give the judgement to an
   actor and keep the workflow's orchestration fixed.

## Where each part lives in the code

| Part | Backend | Pages | State |
|---|---|---|---|
| Assistant, threads, channel bridge, Hands client, browser, voice, settings | `packages/cli/src/modules/aon-core` | the window; `/aon` (Home), `/aon/hands`, `/aon/settings` | built |
| Guard | `packages/cli/src/modules/aon-core/guard` | `/aon/guard`, cards on Telegram | built; workflow nodes not yet gated |
| Council | `packages/cli/src/modules/aon-core/guard/council` | `/aon/guard` (Council section), cards on Telegram (live only) | built; every op class starts in shadow |
| Agents, deliverables, runs, rules, executor, judge, routines | `packages/cli/src/modules/aon-agents` | `/aon/agents`, `/aon/agents/new`, `/aon/agents/:slug`, `/aon/runs` | built |
| Memory: sources, chunks, capture, extraction, entities, facts, observations, graph | `packages/cli/src/modules/aon-memory` | `/aon/memory` (search, capture, Sky / Brain / Radial, entities, facts, observations) | built |
| Skills | `aon-skills/` (canonical) → the CLI home's `.claude/skills` | Settings › Aon (on/off) | built; the owner picks what is added |
| Hands service | `/root/aon-hands` on the host (n8n sandbox protocol, allowlist proxy) | — | built |
| Browser and voice sidecars | `aon-browser` (Obscura) and `aon-voice` on the host | — | built |
| Google: Gmail, Calendar, Drive, Sheets | `packages/cli/src/modules/aon-core/google` | Settings › Aon (Google part) | built |
| Workflows, executions, n8n agents, credentials | n8n itself | n8n's own pages | stock |