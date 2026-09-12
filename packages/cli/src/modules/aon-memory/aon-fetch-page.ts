import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface FetchedPage {
	body: string;
	contentType: string;
}

/**
 * Reads a page as text: a text or HTML content type only, cut off before it
 * grows past the cap regardless of what the server's Content-Length claims.
 *
 * Only the public internet is a page. The host is resolved first and every
 * address it resolves to must be globally routable; a redirect is followed by
 * hand so each hop is held to the same rule. Nothing on this machine, on the
 * container networks or on the local link can be read this way.
 *
 * Throws `BadRequestError` for anything that keeps this from a clean read.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
	let current = await publicUrl(url);
	for (let hop = 0; ; hop++) {
		let response: Response;
		try {
			response = await fetch(current, {
				redirect: 'manual',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
			});
		} catch (error) {
			throw new BadRequestError(`Could not read that page: ${(error as Error).message}`);
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location || hop >= MAX_REDIRECTS) {
				throw new BadRequestError('That page redirects somewhere I will not follow.');
			}
			current = await publicUrl(new URL(location, current).toString());
			continue;
		}
		if (!response.ok) {
			throw new BadRequestError(`That page answered ${response.status} ${response.statusText}.`);
		}
		const contentType = response.headers.get('content-type') ?? '';
		if (!/^text\/|html/i.test(contentType)) {
			throw new BadRequestError(
				`That page is "${contentType || 'unknown'}", not something I can read as text.`,
			);
		}
		return { body: await readCapped(response), contentType };
	}
}

/** The URL if it points at the public internet, else a 400. */
export async function publicUrl(raw: string): Promise<string> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BadRequestError('That is not a URL.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new BadRequestError('Only http and https pages can be read.');
	}
	if (url.username || url.password) {
		throw new BadRequestError('A URL with credentials in it cannot be read.');
	}
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const addresses = isIP(host)
		? [host]
		: await lookup(host, { all: true })
				.then((found) => found.map((a) => a.address))
				.catch(() => {
					throw new BadRequestError(`I cannot resolve ${host}.`);
				});
	if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
		throw new BadRequestError('Only pages on the public internet can be read.');
	}
	return url.toString();
}

/** True for a globally routable address; false for anything local, private or reserved. */
export function isPublicAddress(address: string): boolean {
	const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
	if (isIP(v4) === 4) {
		const [a, b] = v4.split('.').map(Number);
		if (a === 0 || a === 10 || a === 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		if (a >= 224) return false;
		return true;
	}
	if (isIP(address) === 6) {
		const lower = address.toLowerCase();
		if (lower === '::' || lower === '::1') return false;
		if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return false;
		if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
		return true;
	}
	return false;
}

async function readCapped(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) {
		const text = await response.text();
		if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw tooBig();
		return text;
	}
	const decoder = new TextDecoder();
	let received = 0;
	let text = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > MAX_BODY_BYTES) {
			await reader.cancel();
			throw tooBig();
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

function tooBig(): BadRequestError {
	return new BadRequestError(`That page is bigger than ${MAX_BODY_BYTES / (1024 * 1024)} MB.`);
}
