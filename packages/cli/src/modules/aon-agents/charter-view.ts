import type { AonCharterView } from '@n8n/api-types';

const KNOWN = new Set(['purpose','owns','sources','do','dont','skills','tools','tierCeiling','breakerLimit','escalateWhen','budgetEurMonth','modelBand']);
const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v.trim() ? [v] : [];
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The imported charter JSON, grouped the way Aon defines an agent (see AON.md). */
export function charterView(raw: Record<string, unknown>, persona: string): AonCharterView {
	const other = Object.fromEntries(Object.entries(raw).filter(([k]) => !KNOWN.has(k)));
	return {
		orientation: { purpose: text(raw.purpose), persona, owns: list(raw.owns), sources: list(raw.sources) },
		rules: { do: list(raw.do), dont: list(raw.dont) },
		skills: list(raw.skills),
		tools: list(raw.tools),
		guard: { tierCeiling: num(raw.tierCeiling), breakerLimit: num(raw.breakerLimit), escalateWhen: text(raw.escalateWhen), budgetEurMonth: num(raw.budgetEurMonth), modelBand: text(raw.modelBand) },
		other,
	};
}
