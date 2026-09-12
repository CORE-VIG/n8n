/** Types for the toolbox: what Aon can reach for but does not contain. */

export type AonToolboxKind = 'skill' | 'script' | 'mcp' | 'cli';

export interface AonToolboxItem {
	slug: string;
	kind: AonToolboxKind;
	name: string;
	summary: string;
	whenToUse: string | null;
	location: string;
	invocation: string | null;
	tags: string[];
	source: string;
	estTokens: number;
	/** True once a scan has failed to find it at least once. */
	away: boolean;
	/** True once it has been away for `TOOLBOX_GONE_AFTER_MS`. */
	gone: boolean;
	missingSince: string | null;
	uses: number;
	lastUsedAt: string | null;
	/** One line, for a listing or the voice. */
	line: string;
}

/** `GET /aon/toolbox?q=&kind=&limit=`. */
export interface AonToolboxList {
	count: number;
	live: number;
	byKind: Record<AonToolboxKind, number>;
	shown: number;
	items: AonToolboxItem[];
	empty: string | null;
}

/** `POST /aon/toolbox/rescan`. */
export interface AonToolboxRescanResult {
	added: number;
	updated: number;
	missing: number;
	back: number;
	unchanged: number;
	scanned: number;
	scope: AonToolboxKind[];
	words: string;
}
