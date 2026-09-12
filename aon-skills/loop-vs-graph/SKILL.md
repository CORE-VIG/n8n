---
name: loop-vs-graph
description: Use before building or changing any workflow or deliverable that repeats or branches — tells a loop from a graph, and what each needs (a stop rule, or explicit merges) so it cannot run forever or fork silently.
---

# Loop or graph? Decide first, then build.

Every automation is one of two shapes. Name the shape before the first node.

## A graph
Steps with dependencies. Each step runs once; branches fork on a condition and
merge back; the whole thing converges to an end. In n8n: a trigger, nodes,
IF/Switch branches, a Merge node where branches rejoin. For an Aon agent: a
`single` or `recurring` deliverable, or a parent run with child runs.

A graph needs:
- every branch to end somewhere (a Merge, or an explicit final node per branch);
- no edge that points back to an earlier node — that would make it a loop;
- the first node to be the only trigger.

## A loop
One step (or a few) repeated until a check passes or a stop rule fires. In
n8n: the Loop Over Items node (batches), or a Wait/IF that routes back to an
earlier node. For an Aon agent: a `goal` deliverable — the judge is the check,
`maxIterations` is the stop rule.

A loop needs BOTH:
- a check: the condition that ends it when met (the judge's verdict, an IF on
  the data, "no more items");
- a stop rule: a hard cap on iterations or time, even if the check never passes.
Never build a loop with only one of the two. Say the cap out loud when you build it.

## Telling them apart when he describes it
- "for each…", "until…", "keep trying…", "retry…", "every item" → loop.
- "when X then Y, otherwise Z", "in parallel", "then", "after both" → graph.
- Both ("for each customer, check A and B then merge") → a graph inside a loop:
  build the graph as the loop's body.

## When you build it
1. Say which shape it is and why, in one sentence.
2. For a loop, state the check and the stop rule before writing nodes.
3. For a graph, list the branches and where each merges.
4. Validate, then test with pinned data that exercises the loop's exit (or every branch) at least once.
