/** Types returned by the Aon memory API: sources, their chunks, and capture. */

export interface AonSourceSummary {
	id: string;
	origin: string;
	kind: string;
	status: string;
	title: string;
	externalId: string | null;
	docTime: string | null;
	indexedAt: string | null;
	createdAt: string;
	chunkCount: number;
	embeddedCount: number;
	bytes: number;
}

export interface AonChunkSummary {
	id: string;
	seq: number;
	tokens: number;
	text: string;
	embeddedAt: string | null;
}

export interface AonSourceDetail extends AonSourceSummary {
	content: string;
	meta: Record<string, unknown> | null;
	extractedAt: string | null;
	chunks: AonChunkSummary[];
}

export interface AonSourceList {
	items: AonSourceSummary[];
	total: number;
	origins: Array<{ origin: string; count: number }>;
}

export interface AonCaptureRequest {
	/** Shown in lists; derived from the text or the page when omitted. */
	title?: string;
	/** Text to remember. One of text or url is required. */
	text?: string;
	/** A page to fetch and remember as text. */
	url?: string;
	/** Where it came from; "capture" when he typed it. */
	origin?: string;
	/** text | page | note | mail | file … */
	kind?: string;
	/** When the content is from, ISO; defaults to now. */
	docTime?: string;
}

export interface AonCaptureResult {
	source: AonSourceSummary;
	chunks: number;
	embedded: number;
	/** Chunks still waiting for their embedding; the module finishes them in the background. */
	pending: number;
}
