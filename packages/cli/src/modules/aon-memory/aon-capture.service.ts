import type { AonCaptureRequest, AonCaptureResult, AonSourceSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { createHash, randomUUID } from 'node:crypto';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

import { chunkText } from './aon-chunk-text';
import { AonEmbedService } from './aon-embed.service';
import { fetchPage } from './aon-fetch-page';
import { extractHtmlTitle, htmlToText } from './aon-html-to-text';
import { AonChunkRepository } from './database/repositories/aon-chunk.repository';
import { AonSourceRepository } from './database/repositories/aon-source.repository';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TITLE_MAX_CHARS = 80;
/** Chunks embedded before the request answers; the rest waits for the background queue. */
const INLINE_EMBED_LIMIT = 40;

interface SourceToStore {
	origin: string;
	kind: string;
	title: string;
	content: string;
	externalId: string | null;
	contentHash: string | null;
	meta: Record<string, unknown>;
	docTime: Date;
}

/**
 * Turns typed text or a page into memory: a source row plus the chunks it
 * was cut into, embedded as far as the inline budget allows. Whatever is
 * left over is picked up by `AonEmbedQueueService` in the background.
 */
@Service()
export class AonCaptureService {
	constructor(
		private readonly sources: AonSourceRepository,
		private readonly chunks: AonChunkRepository,
		private readonly embedder: AonEmbedService,
	) {}

	async capture(request: AonCaptureRequest): Promise<AonCaptureResult> {
		const hasText = typeof request.text === 'string' && request.text.trim().length > 0;
		const hasUrl = typeof request.url === 'string' && request.url.trim().length > 0;
		if (hasText === hasUrl) {
			throw new BadRequestError('Give me exactly one of text or a url to read.');
		}

		return hasUrl ? await this.captureUrl(request) : await this.captureText(request);
	}

	private async captureText(request: AonCaptureRequest): Promise<AonCaptureResult> {
		const text = (request.text ?? '').trim();
		if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
			throw new BadRequestError(
				'That text is bigger than 2 MB. Shorten it, or capture it as a url.',
			);
		}

		const origin = request.origin?.trim() || 'capture';
		const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');

		// The same text, already remembered under this origin: nothing to add.
		const existing = await this.sources.findByHash(origin, contentHash);
		if (existing) return resultFor(existing);

		const title = request.title?.trim() || firstLine(text) || 'Untitled';
		return await this.store({
			origin,
			kind: request.kind?.trim() || 'text',
			title,
			content: text,
			externalId: null,
			contentHash,
			meta: { bytes: Buffer.byteLength(text, 'utf8'), chunker: 'v1' },
			docTime: resolveDocTime(request.docTime),
		});
	}

	private async captureUrl(request: AonCaptureRequest): Promise<AonCaptureResult> {
		const url = (request.url ?? '').trim();
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new BadRequestError('That is not a valid url.');
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new BadRequestError('I can only read http:// or https:// pages.');
		}

		const page = await fetchPage(url);
		const isHtml = /html/i.test(page.contentType);
		const content = (isHtml ? htmlToText(page.body) : page.body).trim();
		const extractedTitle = isHtml ? extractHtmlTitle(page.body) : null;

		const origin = request.origin?.trim() || 'url';
		const title = request.title?.trim() || extractedTitle || firstLine(content) || url;

		// A re-read of the same page replaces the old read rather than duplicating it.
		const existing = await this.sources.findByExternalId(origin, url);
		if (existing) await this.sources.deleteById(existing.id);

		return await this.store({
			origin,
			kind: request.kind?.trim() || 'page',
			title,
			content,
			externalId: url,
			contentHash: null,
			meta: { url, bytes: Buffer.byteLength(content, 'utf8'), chunker: 'v1' },
			docTime: resolveDocTime(request.docTime),
		});
	}

	private async store(source: SourceToStore): Promise<AonCaptureResult> {
		const id = randomUUID();
		const now = new Date();
		await this.sources.insertSource({
			id,
			origin: source.origin,
			externalId: source.externalId,
			title: source.title,
			content: source.content,
			meta: source.meta,
			kind: source.kind,
			status: 'indexed',
			contentHash: source.contentHash,
			docTime: source.docTime,
			indexedAt: now,
			createdAt: now,
		});

		const pieces = chunkText(source.content).map((text, seq) => ({
			seq,
			text,
			tokens: Math.ceil(text.length / 4),
		}));
		const inserted = await this.chunks.insertMany(id, pieces);

		let embedded = 0;
		if (this.embedder.enabled) {
			for (const chunk of inserted.slice(0, INLINE_EMBED_LIMIT)) {
				const vector = await this.embedder.embed(chunk.text);
				if (vector) {
					await this.chunks.setEmbedding(chunk.id, vector);
					embedded += 1;
				}
			}
		}

		const summary: AonSourceSummary = {
			id,
			origin: source.origin,
			kind: source.kind,
			status: 'indexed',
			title: source.title,
			externalId: source.externalId,
			docTime: source.docTime.toISOString(),
			indexedAt: now.toISOString(),
			createdAt: now.toISOString(),
			chunkCount: inserted.length,
			embeddedCount: embedded,
			bytes: Buffer.byteLength(source.content, 'utf8'),
		};

		return {
			source: summary,
			chunks: inserted.length,
			embedded,
			pending: inserted.length - embedded,
		};
	}
}

function resultFor(existing: AonSourceSummary): AonCaptureResult {
	return {
		source: existing,
		chunks: existing.chunkCount,
		embedded: existing.embeddedCount,
		pending: existing.chunkCount - existing.embeddedCount,
	};
}

function resolveDocTime(docTime: string | undefined): Date {
	if (!docTime) return new Date();
	const parsed = new Date(docTime);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** The first non-empty line, short enough to sit in a title column. */
function firstLine(text: string): string {
	const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
	return line.length > TITLE_MAX_CHARS ? line.slice(0, TITLE_MAX_CHARS).trimEnd() : line;
}
