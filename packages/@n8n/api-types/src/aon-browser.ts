/**
 * Types for Aon's browser: a fenced, single-lease browser on the host,
 * reached through Obscura's MCP endpoint (`aon-browser`).
 */

export interface AonBrowserStatus {
	configured: boolean;
	online: boolean;
	/** The host only, never the full URL: nothing secret, but no reason to publish the port either. */
	host: string | null;
}

export interface AonBrowserLink {
	text: string;
	href: string;
}

export interface AonBrowserReadRequest {
	url: string;
}

export interface AonBrowserReadResult {
	title: string;
	url: string;
	text: string;
	links: AonBrowserLink[];
}

export type AonBrowserActStep =
	| { kind: 'navigate'; url: string }
	| { kind: 'click'; ref?: string; text?: string }
	| { kind: 'type'; ref?: string; text?: string; value: string; submit?: boolean }
	| { kind: 'wait'; ms: number }
	| { kind: 'snapshot' }
	| { kind: 'screenshot' };

export interface AonBrowserScreenshot {
	mimeType: string;
	data: string;
}

export interface AonBrowserStepResult {
	kind: AonBrowserActStep['kind'];
	ok: boolean;
	text: string | null;
	error: string | null;
	image: AonBrowserScreenshot | null;
}

export interface AonBrowserActRequest {
	steps: AonBrowserActStep[];
	purpose: string;
}

export interface AonBrowserActResult {
	steps: AonBrowserStepResult[];
	/** Null when the closing snapshot itself failed (e.g. the lease ran out) — the step results and screenshot below are still real. */
	snapshot: string | null;
	/** The last screenshot step's image, if any, surfaced for convenience. */
	screenshot: AonBrowserScreenshot | null;
	/** Why `snapshot` is null; null when the snapshot succeeded. */
	error: string | null;
}
