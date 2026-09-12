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
agents and n8n agents. It can create, change, run, review and retire
workflows now; creating, changing and reviewing agents comes with the
executor. It is not an agent (it never acts on its own) and not a workflow
(it reasons).

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
never an agent. Note: the runtime that starts runs inside this instance (the
executor) is planned; the roster, deliverables, past runs and learned rules
are here now.

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
Guard like every other effect.

**Routine.** A workflow whose only job is to invoke an Aon agent on a
schedule (Schedule Trigger → Aon node → the agent). A deliverable declares its
cadence and one routine implements it. A routine never invokes the assistant,
holds no rules of its own, and an n8n agent's scheduled task is not a routine.
Planned with the executor.

**Channel bridge.** A workflow that authenticates one message from the owner
on a channel (Telegram, and later others), relays it to the assistant as an
owner-initiated turn, and relays the reply back. It never reasons, and a
scheduled or third-party message never passes through it as if the owner
had spoken. Planned.

**Executor.** The non-reasoning runtime that claims a run from one charter
version, starts it, records it and asks the judge for the verdict. Planned.

**Judge.** The actor a deliverable names to decide whether its definition of
done is met: the owner, or a model call the executor makes on the
deliverable's behalf. A judge decides; it never acts. Planned with the
executor.

**Run.** One recorded attempt by an Aon agent toward a deliverable: queued,
claimed, running, judged, then done, failed or stopped, with its output and
its cost. A *workflow execution* is n8n's record of a workflow; an *n8n agent
run* is n8n's record of its agent. The three are never mixed up.

**Skill.** A procedure written down (SKILL.md) that any actor may follow. A
skill is knowledge, not an actor; it cannot act, own or decide.

**Tool.** A callable capability assigned to an actor. It can come from a
node, a workflow, Hands, custom code or an MCP server. A tool is a verb, not an
actor. The instance's *MCP server* is the authenticated transport that exposes
selected capabilities as tools; it does not reason or own work.

**Rule.** A constraint on one actor: standing (written by the owner) or
learned (promoted from run evidence; canary, then kept or revoked).

**Effect.** Anything that changes persistent or external state, sends data,
spends money or grants access.

**Guard.** The permission system: every effect is classed, the class has a
tier, the tier has a policy, and what the policy does not allow goes to the
approver — the owner — as a card. Guard checks the concrete call before it
executes, for the assistant, for agents, for workflows' effectful nodes and
for Hands alike. This is the target invariant; today the MCP server enforces
authentication and scopes and Hands runs what it is given, and Guard itself
is the next module.

**Memory.** What Aon has read: captured sources → chunks (searched by word and
by meaning) → facts and entities (extracted). Capture and extraction are its
only writers; actors ask for a capture, they never write records directly.
Memory keeps the evidence a learned rule came from; the rule belongs to its
agent. Search is here now; capture and extraction are next.

**Hands.** The fenced workspace where commands run and files live, for the
assistant and for agents (and, through the same service, for n8n agents).
Workflows do not use Hands; they use nodes.

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
| Assistant, Hands, config | `packages/cli/src/modules/aon-core` | the window (built); Settings › Aon (planned) | built |
| Agents, deliverables, runs, rules | `packages/cli/src/modules/aon-agents` | `/aon/agents`, `/aon/agents/:slug` | read-only now; executor, judge, routines, channel bridge planned |
| Guard | `packages/cli/src/modules/aon-guard` | Guard page, cards | planned |
| Memory | `packages/cli/src/modules/aon-memory` | search on `/aon` (built); a Memory page (planned) | search built; capture, extraction planned |
| Hands service | `/root/aon-hands` on the host (n8n sandbox protocol) | — | built |
| Workflows, executions, n8n agents, credentials | n8n itself | n8n's own pages | stock |
