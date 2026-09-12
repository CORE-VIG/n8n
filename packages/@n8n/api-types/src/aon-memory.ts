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

/** Types returned by the Aon memory graph API: entities, facts, observations. */

export interface AonEntitySummary {
	id: string;
	name: string;
	kind: string;
	aliases: string[];
	summary: string | null;
	factCount: number;
	createdAt: string;
}

export interface AonFactSummary {
	id: string;
	subjectId: string;
	subject: string;
	predicate: string;
	objectId: string | null;
	object: string;
	status: string;
	confidence: number | null;
	proposedBy: string | null;
	sourceChunkId: string | null;
	sourceId: string | null;
	sourceTitle: string | null;
	quote: string | null;
	recordedAt: string;
	decidedBy: string | null;
	decidedAt: string | null;
	note: string | null;
}

export interface AonEntityDetail extends AonEntitySummary {
	facts: AonFactSummary[];
	mentionedIn: Array<{ sourceId: string; title: string; origin: string }>;
}

export interface AonFactList {
	items: AonFactSummary[];
	total: number;
	byStatus: Record<string, number>;
}

export interface AonObservationSummary {
	id: string;
	bucket: string;
	text: string;
	salience: number;
	status: string;
	firstSeen: string;
	lastSeen: string;
}

export interface AonGraphNode {
	id: string;
	label: string;
	kind: string;
	weight: number;
	cluster: number;
}

export interface AonGraphEdge {
	from: string;
	to: string;
	label: string;
	status: string;
	factId: string;
}

export interface AonGraphCluster {
	kind: string;
	index: number;
	count: number;
}

export interface AonMemoryGraph {
	nodes: AonGraphNode[];
	edges: AonGraphEdge[];
	clusters: AonGraphCluster[];
	focus: string | null;
	truncated: boolean;
}

export interface AonMemorySkyCategory {
	name: string;
	count: number;
	group: 'origin' | 'kind' | 'entity' | 'fact';
}

export interface AonMemorySky {
	core: number;
	categories: AonMemorySkyCategory[];
	sources: number;
	entities: number;
	facts: number;
	observations: number;
}
