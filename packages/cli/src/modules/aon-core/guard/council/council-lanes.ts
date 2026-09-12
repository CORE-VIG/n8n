/**
 * The lane a card sits in before the council is ever asked.
 *
 * Human-only op classes never reach the council, whatever a standing rule
 * says: money, access, sending mail, writing the calendar, acting on a web
 * page, publishing a workflow, and an agent's own charter. Tier 4 is
 * human-only in general, not by name. This is computed here, in code, so
 * widening it is a code change the owner reviews — never a policy row a
 * standing rule could quietly extend.
 */
const HUMAN_ONLY_OP_CLASSES: ReadonlySet<string> = new Set([
	'money',
	'access',
	'mail.send',
	'calendar.write',
	'web.act',
	'workflow.publish',
	'agent.write',
]);

export function isHumanOnly(opClass: string, tier: number): boolean {
	return tier >= 4 || HUMAN_ONLY_OP_CLASSES.has(opClass);
}
