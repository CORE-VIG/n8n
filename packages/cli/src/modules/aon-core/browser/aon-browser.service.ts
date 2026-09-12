import type {
	AonBrowserActResult,
	AonBrowserActStep,
	AonBrowserLink,
	AonBrowserReadResult,
	AonBrowserScreenshot,
	AonBrowserStatus,
	AonBrowserStepResult,
} from '@n8n/api-types';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import { isIP } from 'node:net';

import { isPublicAddress } from '../../aon-memory/aon-fetch-page';

/**
 * The browser: how the assistant reaches `aon-browser`, the Obscura MCP
 * server on the docker gateway, and the URL rules that run before the
 * browser ever sees an address.
 *
 * Ported from the standalone Aon app's `lib/browser.ts` (proven live against
 * Obscura 0.2.2, 2026-09-05) and re-verified live against this same endpoint
 * on 2026-09-12. Three things changed in the port, deliberately:
 *
 *   - The lease's one lock used to live on `globalThis`, because Next
 *     compiles each route into its own bundle with its own module
 *     instances — a module-level lock would have been one lock per route.
 *     This service is a `@n8n/di` singleton in one long-running process, so
 *     the lock is an ordinary instance field.
 *   - The old client hard-coded its own public host (`aon.cod-a.com`) as a
 *     host no URL may ever name. This instance's own host is configurable
 *     (`N8N_HOST` and friends), so `ownHosts()` reads it from the
 *     environment instead of hard-coding a domain that belongs to a
 *     different app.
 *   - Obscura's real tool surface, read live from `tools/list` on this
 *     deployment, is not the one the old client's comments describe:
 *     `browser_snapshot` already returns "URL: …\nTitle: …\n\n<body text>"
 *     rather than an accessibility tree, there is a `browser_links` tool
 *     that returns `{text, href}` JSON lines directly, elements are typed
 *     with `browser_fill` (replace) and `browser_type` (append) rather than
 *     one `type`, and the screenshot tool is `browser_screenshot`, not
 *     `browser_take_screenshot`. This client is written against the names
 *     and shapes actually seen on the wire, not the old comments.
 *
 * Everything else — the stateless endpoint, the fresh-lease cookie/tab
 * reset, closing tabs on every exit however the lease ends, the bounded
 * lock wait, the "no retry" rule on a timed-out call, and Obscura refusing
 * private addresses again on its own side (DNS rebinding lands there) —
 * carries over unchanged.
 */

export const READ_TIMEOUT_MS = 30_000;
export const MAX_URL_CHARS = 2048;
/** How long one tool call may take on its own, inside the lease's deadline. */
const CALL_CAP_MS = 30_000;
/** The reset at the end of a lease runs on its own small budget, so a timed-out read still leaves the browser clean. */
const RESET_BUDGET_MS = 8_000;
/** How long a caller waits for the one browser before giving up. */
export const LOCK_WAIT_MS = 30_000;
/** How long the status probe waits for `initialize` before calling the browser offline. */
const PROBE_TIMEOUT_MS = 2_000;
/** `read()`'s text and a step's snapshot text are both capped here. */
const MAX_TEXT_BYTES = 60 * 1024;
/** A screenshot bigger than this is refused rather than sent half-usable. */
const MAX_SCREENSHOT_BYTES = Math.floor(1.5 * 1024 * 1024);
const MAX_LINKS = 200;
const MAX_WAIT_STEP_MS = 5_000;

// ─── The URL rules ─────────────────────────────────────────────────────────

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];

/** Env vars that name a host of this instance or a private service beside it. */
const OWN_HOST_ENV_KEYS = [
	'WEBHOOK_URL',
	'N8N_EDITOR_BASE_URL',
	'AON_BROWSER_URL',
	'N8N_SANDBOX_SERVICE_URL',
	'AON_MCP_URL',
];

/** Hostnames that name this instance itself or the private services beside it: never a target. */
export function ownHosts(env: Record<string, string | undefined> = process.env): string[] {
	const out = new Set<string>();
	const bareHost = env.N8N_HOST;
	if (bareHost) out.add(bareHost.toLowerCase());
	for (const key of OWN_HOST_ENV_KEYS) {
		const v = env[key];
		if (!v) continue;
		try {
			out.add(new URL(v).hostname.toLowerCase());
		} catch {
			/* not a URL: nothing to protect */
		}
	}
	return [...out];
}

/**
 * The URL rules. Refusals say why in words, because the brain reads the
 * reason aloud. Everything fails closed: a host that cannot be parsed, a
 * bare name that would resolve on the local network, an address literal in
 * a private range (checked with the same `isPublicAddress` the memory
 * module's own page fetcher uses, so the two guards never disagree), a
 * credential in the URL, this instance's own hosts. A domain name's private
 * range, reached only by DNS, is Obscura's own job: it refuses those again
 * on its side, which is also where DNS rebinding is caught.
 */
export function checkUrl(raw: unknown, own: string[] = ownHosts()): UrlCheck {
	if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'a URL is required' };
	const s = raw.trim();
	if (s.length > MAX_URL_CHARS) {
		return { ok: false, reason: `the URL is longer than ${MAX_URL_CHARS} characters` };
	}
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return { ok: false, reason: 'that is not a URL Aon can read' };
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		return { ok: false, reason: `only http and https are read, not ${u.protocol.replace(':', '')}` };
	}
	if (u.username || u.password) {
		return { ok: false, reason: 'a URL carrying a username or password is never opened' };
	}
	// A trailing dot is the root-anchored form of the same name; resolvers
	// honour it, so it must not be a way past the checks below.
	const bracketless = u.hostname.replace(/^\[|\]$/g, '');
	const host = bracketless.toLowerCase().replace(/\.+$/, '');
	if (!host) return { ok: false, reason: 'the URL names no host' };
	if (host === 'localhost' || LOCAL_SUFFIXES.some((sfx) => host.endsWith(sfx))) {
		return { ok: false, reason: `${host} is a local name, not the web` };
	}
	const literal = isIP(host);
	if (literal) {
		if (!isPublicAddress(host)) return { ok: false, reason: `${host} is a private or reserved address` };
	} else if (!host.includes('.')) {
		return { ok: false, reason: `${host} has no dot: a bare name resolves on the local network, not the web` };
	}
	for (const o of own) {
		if (host === o || host.endsWith(`.${o}`)) return { ok: false, reason: `${host} is this instance's own host` };
	}
	u.hash = '';
	return { ok: true, url: u.toString(), host };
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** The browser is not configured (`AON_BROWSER_URL` is empty). A normal state, not a fault. */
export class BrowserOffline extends Error {
	constructor(message = 'the browser is not configured') {
		super(message);
		this.name = 'BrowserOffline';
	}
}

/** A URL the rules refuse, before the browser is ever asked. */
export class UrlRefused extends Error {
	constructor(public readonly reason: string) {
		super(reason);
		this.name = 'UrlRefused';
	}
}

export type BrowserErrorCode = 'unavailable' | 'timeout' | 'protocol' | 'tool';

/** A transport- or protocol-level failure talking to an already-configured browser. */
export class BrowserError extends Error {
	code: BrowserErrorCode;
	constructor(code: BrowserErrorCode, message: string) {
		super(message);
		this.name = 'BrowserError';
		this.code = code;
	}
}

// ─── The MCP transport ──────────────────────────────────────────────────────

export type ToolImage = { mimeType: string; data: string };
export type ToolResult = { text: string; image: ToolImage | null; isError: boolean };
export type ToolArgs = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * The body may be plain JSON or an SSE stream whose last `data:` line is the
 * JSON-RPC response. `JSON.parse` has no typed return, so the result is
 * handed to {@link toToolResult} as `unknown` and read back field by field
 * with `typeof` guards, rather than cast to a shape.
 */
export function parseRpcBody(raw: string): unknown {
	const s = raw.trim();
	if (!s) throw new BrowserError('protocol', 'the browser returned an empty response');
	if (s.startsWith('{')) return JSON.parse(s);
	const data = s
		.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).trim())
		.filter(Boolean);
	if (!data.length) throw new BrowserError('protocol', 'the browser returned neither JSON nor an event stream');
	return JSON.parse(data[data.length - 1]);
}

export function toToolResult(rpc: unknown): ToolResult {
	if (!isRecord(rpc)) throw new BrowserError('protocol', 'the browser returned something unreadable');
	if (isRecord(rpc.error)) {
		const message = typeof rpc.error.message === 'string' ? rpc.error.message : undefined;
		const code = typeof rpc.error.code === 'number' ? rpc.error.code : undefined;
		throw new BrowserError('protocol', `the browser refused the call: ${message ?? `code ${code}`}`);
	}
	const result = isRecord(rpc.result) ? rpc.result : undefined;
	const content = Array.isArray(result?.content) ? result.content : [];
	const textParts: string[] = [];
	let image: ToolImage | null = null;
	for (const item of content) {
		if (!isRecord(item)) continue;
		if (item.type === 'text' && typeof item.text === 'string') textParts.push(item.text);
		if (!image && item.type === 'image' && typeof item.data === 'string') {
			image = { mimeType: typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'image/png', data: item.data };
		}
	}
	return { text: textParts.join('\n'), image, isError: result?.isError === true };
}

// ─── The snapshot / links / elements renderers ─────────────────────────────

export interface RenderedSnapshot {
	url: string;
	title: string;
	text: string;
}

const SNAPSHOT_HEADER_RE = /^URL: (.*)\nTitle: (.*)\n\n/;
const SNAPSHOT_FOOTER_RE = /\n*(?:\d+\s+interactive element\(s\) registered\.|No interactive elements\.?)[\s\S]*$/i;

/**
 * `browser_snapshot` already returns "URL: …\nTitle: …\n\n<body text>", plus
 * a trailing sentence about how many interactive elements it found. This
 * pulls the three parts apart and drops the trailing sentence, which is
 * navigation help for a model, not page content.
 */
export function renderSnapshot(raw: string): RenderedSnapshot {
	const header = SNAPSHOT_HEADER_RE.exec(raw);
	const url = header?.[1]?.trim() ?? '';
	const title = header?.[2]?.trim() ?? '';
	const body = header ? raw.slice(header[0].length) : raw;
	return { url, title, text: body.replace(SNAPSHOT_FOOTER_RE, '').trim() };
}

function isLinkLike(value: unknown): value is AonBrowserLink {
	return isRecord(value) && typeof value.text === 'string' && typeof value.href === 'string';
}

/** `browser_links` returns one `{text, href}` JSON object per line. */
export function parseLinksJsonl(raw: string): AonBrowserLink[] {
	const out: AonBrowserLink[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (isLinkLike(parsed)) out.push({ text: parsed.text, href: parsed.href });
	}
	return out;
}

export interface InteractiveElement {
	ref: string;
	tag: string;
	desc: string;
}

const ELEMENT_RE = /^ref=(\S+)\s+(\S+)\s+"([\s\S]*)"\s*$/;

/** `browser_interactive_elements` returns one fixed-column line per element: `ref=e1    a    "Learn more"`. */
export function parseInteractiveElements(raw: string): InteractiveElement[] {
	const out: InteractiveElement[] = [];
	for (const line of raw.split('\n')) {
		const m = ELEMENT_RE.exec(line);
		if (m) out.push({ ref: m[1], tag: m[2], desc: m[3] });
	}
	return out;
}

function clipUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
	const head = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
	return `${head}\n…(cut at ${maxBytes} bytes)`;
}

function clipImage(image: ToolImage): AonBrowserScreenshot | null {
	const bytes = Buffer.byteLength(image.data, 'base64');
	if (bytes > MAX_SCREENSHOT_BYTES) return null;
	return { mimeType: image.mimeType, data: image.data };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const stepOk = (kind: AonBrowserActStep['kind'], text: string): AonBrowserStepResult => ({
	kind,
	ok: true,
	text,
	error: null,
	image: null,
});
const stepFail = (kind: AonBrowserActStep['kind'], error: unknown): AonBrowserStepResult => ({
	kind,
	ok: false,
	text: null,
	error: error instanceof Error ? error.message : String(error),
	image: null,
});

// ─── The lease ──────────────────────────────────────────────────────────────

interface BrowserSession {
	/** A tool call inside the lease; its timeout is the smaller of the call cap and what is left of the deadline. */
	call(name: string, args?: ToolArgs): Promise<ToolResult>;
	remainingMs(): number;
}

/**
 * The assistant's browser: a fenced, single-lease browser on the host,
 * reached over Obscura's MCP endpoint. One process-wide lock serialises
 * every use; a fresh lease clears cookies and closes tabs before it starts
 * and closes tabs again on the way out, whatever happened in between.
 */
@Service()
export class AonBrowserService {
	private lockChain: Promise<void> = Promise.resolve();

	private rpcId = 0;

	constructor(private readonly globalConfig: GlobalConfig) {}

	private browserUrl(): string | null {
		const v = (this.globalConfig.aon.browserUrl || '').trim();
		return v || null;
	}

	async isConfigured(): Promise<boolean> {
		return this.browserUrl() !== null;
	}

	/** The Browser status card: configured, reachable, and which host — never the full URL. */
	async status(): Promise<AonBrowserStatus> {
		const url = this.browserUrl();
		if (!url) return { configured: false, online: false, host: null };
		let host: string | null = null;
		try {
			host = new URL(url).hostname;
		} catch {
			/* leave host null: an unparsable AON_BROWSER_URL is a misconfiguration, not a crash */
		}
		return { configured: true, online: await this.probeInitialize(url), host };
	}

	/** Navigate to `url` and read it back as title, url and readable text, plus its links. Throws `BrowserOffline` or `UrlRefused`. */
	async read(rawUrl: string): Promise<AonBrowserReadResult> {
		const url = this.browserUrl();
		if (!url) throw new BrowserOffline();
		const check = checkUrl(rawUrl, ownHosts());
		if (!check.ok) throw new UrlRefused(check.reason);
		return await this.withLease(url, {}, async (session) => {
			await session.call('browser_navigate', { url: check.url });
			const snap = await session.call('browser_snapshot', { max_chars: MAX_TEXT_BYTES });
			const rendered = renderSnapshot(snap.text);
			const linksResult = await session.call('browser_links', { limit: MAX_LINKS });
			return {
				title: rendered.title,
				url: rendered.url || check.url,
				text: clipUtf8(rendered.text, MAX_TEXT_BYTES),
				links: parseLinksJsonl(linksResult.text),
			};
		});
	}

	/** Run a bounded list of steps in one lease. Throws `BrowserOffline` or `UrlRefused` (a `navigate` step's URL) before the browser is touched. */
	async act(steps: readonly AonBrowserActStep[]): Promise<AonBrowserActResult> {
		const url = this.browserUrl();
		if (!url) throw new BrowserOffline();
		const own = ownHosts();
		const checked = steps.map((step) => {
			if (step.kind !== 'navigate') return step;
			const check = checkUrl(step.url, own);
			if (!check.ok) throw new UrlRefused(check.reason);
			return { ...step, url: check.url };
		});
		return await this.withLease(url, {}, async (session) => {
			const results: AonBrowserStepResult[] = [];
			for (const step of checked) {
				results.push(await this.runStep(session, step));
			}
			const snap = await session.call('browser_snapshot', { max_chars: MAX_TEXT_BYTES });
			const screenshot = [...results].reverse().find((r) => r.kind === 'screenshot' && r.image)?.image ?? null;
			return {
				steps: results,
				snapshot: clipUtf8(renderSnapshot(snap.text).text, MAX_TEXT_BYTES),
				screenshot,
			};
		});
	}

	private async runStep(session: BrowserSession, step: AonBrowserActStep): Promise<AonBrowserStepResult> {
		try {
			switch (step.kind) {
				case 'navigate': {
					const r = await session.call('browser_navigate', { url: step.url });
					return stepOk(step.kind, r.text);
				}
				case 'click': {
					const ref = await this.resolveRef(session, step.ref, step.text);
					const r = await session.call('browser_click', { ref });
					return stepOk(step.kind, r.text);
				}
				case 'type': {
					const ref = await this.resolveRef(session, step.ref, step.text);
					const r = await session.call('browser_fill', { ref, value: step.value });
					let text = r.text;
					if (step.submit) {
						const submitted = await session.call('browser_press_key', { key: 'Enter' });
						text = `${text}\n${submitted.text}`;
					}
					return stepOk(step.kind, text);
				}
				case 'wait': {
					const ms = Math.max(0, Math.min(step.ms, MAX_WAIT_STEP_MS));
					const left = session.remainingMs();
					if (left <= 0) throw new BrowserError('timeout', 'the lease ran out before a wait step');
					await sleep(Math.min(ms, left));
					return stepOk(step.kind, `waited ${ms} ms`);
				}
				case 'snapshot': {
					const r = await session.call('browser_snapshot', { max_chars: MAX_TEXT_BYTES });
					return stepOk(step.kind, clipUtf8(renderSnapshot(r.text).text, MAX_TEXT_BYTES));
				}
				case 'screenshot': {
					const r = await session.call('browser_screenshot', {});
					if (!r.image) return stepFail(step.kind, new Error('the browser returned no image'));
					const image = clipImage(r.image);
					if (!image) return stepFail(step.kind, new Error(`the screenshot is bigger than ${MAX_SCREENSHOT_BYTES} bytes`));
					return { kind: step.kind, ok: true, text: null, error: null, image };
				}
			}
		} catch (error) {
			return stepFail(step.kind, error);
		}
	}

	/** `browser_click`/`browser_fill` take a `ref`; a step given `text` instead is resolved against `browser_interactive_elements`. */
	private async resolveRef(session: BrowserSession, ref: string | undefined, text: string | undefined): Promise<string> {
		if (ref) return ref;
		if (!text || !text.trim()) throw new Error('this step needs ref or text');
		const listing = await session.call('browser_interactive_elements', { limit: 200 });
		const needle = text.trim().toLowerCase();
		const found = parseInteractiveElements(listing.text).find((e) => e.desc.toLowerCase().includes(needle));
		if (!found) throw new Error(`no interactive element matches "${text}"`);
		return found.ref;
	}

	private async probeInitialize(url: string): Promise<boolean> {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', connection: 'close' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 0,
					method: 'initialize',
					params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aon', version: '1' } },
				}),
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	/**
	 * One `tools/call` against the browser. Never retried: a navigate that
	 * timed out must not be sent twice. `connection: close` is deliberate:
	 * keep-alive against Obscura's HTTP server cost a flat 4 s on every call
	 * after the first in the app this was ported from; a fresh connection
	 * answers in a millisecond.
	 */
	private async callTool(url: string, name: string, args: ToolArgs, timeoutMs: number): Promise<ToolResult> {
		const capped = Math.max(1, Math.min(timeoutMs, CALL_CAP_MS));
		let res: Response;
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', connection: 'close' },
				body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/call', params: { name, arguments: args } }),
				signal: AbortSignal.timeout(capped),
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
				throw new BrowserError('timeout', `${name} took longer than ${Math.round(capped / 1000)} s`);
			}
			throw new BrowserError('unavailable', `the browser is not reachable: ${msg}`);
		}
		if (!res.ok) throw new BrowserError('unavailable', `the browser answered HTTP ${res.status}`);
		return toToolResult(parseRpcBody(await res.text()));
	}

	/** Serialise every use of the one browser. Returns the release. */
	private async acquireLock(maxWaitMs: number): Promise<() => void> {
		const previous = this.lockChain;
		let release!: () => void;
		const mine = new Promise<void>((r) => {
			release = r;
		});
		this.lockChain = previous.then(() => mine);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				previous,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new BrowserError('unavailable', `the browser was busy with another request for more than ${Math.round(maxWaitMs / 1000)} s`)),
						maxWaitMs,
					);
				}),
			]);
		} catch (e) {
			// Step out of the queue on the way past, or everyone behind waits for a turn this caller will never take.
			release();
			throw e;
		} finally {
			if (timer) clearTimeout(timer);
		}
		return release;
	}

	/**
	 * Run `fn` holding the browser. The lock is taken before the deadline
	 * starts, so a read queued behind another does not lose its budget
	 * waiting. Tabs are closed on the way out on their own budget: a read
	 * that timed out mid-navigation must not leave its page open for the
	 * next caller.
	 */
	private async withLease<T>(
		url: string,
		opts: { timeoutMs?: number; fresh?: boolean; maxWaitMs?: number },
		fn: (session: BrowserSession) => Promise<T>,
	): Promise<T> {
		const release = await this.acquireLock(opts.maxWaitMs ?? LOCK_WAIT_MS);
		try {
			const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
			const deadline = Date.now() + timeoutMs;
			const session: BrowserSession = {
				remainingMs: () => Math.max(0, deadline - Date.now()),
				call: async (name, args = {}) => {
					const left = deadline - Date.now();
					if (left <= 0) throw new BrowserError('timeout', `the ${Math.round(timeoutMs / 1000)} s budget ran out before ${name}`);
					return await this.callTool(url, name, args, Math.min(left, CALL_CAP_MS));
				},
			};
			try {
				if (opts.fresh !== false) {
					await session.call('browser_clear_cookies');
					await session.call('browser_close');
				}
				return await fn(session);
			} finally {
				await this.callTool(url, 'browser_close', {}, RESET_BUDGET_MS).catch(() => undefined);
			}
		} finally {
			release();
		}
	}
}
