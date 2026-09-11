import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';

const EMBED_TIMEOUT_MS = 15_000;

/**
 * Turns text into the same vectors the memory was embedded with, through the
 * Ollama server named in `AON_OLLAMA_URL`. No server, or a failure, means no
 * vector: callers fall back to word search rather than failing.
 */
@Service()
export class AonEmbedService {
	constructor(
		private readonly globalConfig: GlobalConfig,
		private readonly logger: Logger,
	) {}

	get enabled() {
		return this.globalConfig.aon.ollamaUrl.trim() !== '';
	}

	async embed(text: string): Promise<number[] | null> {
		if (!this.enabled) return null;
		const { ollamaUrl, embedModel } = this.globalConfig.aon;
		try {
			const response = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/embed`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: embedModel, input: text }),
				signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
			});
			if (!response.ok) {
				this.logger.warn(`Aon embed: ${embedModel} answered ${response.status}`);
				return null;
			}
			const data = (await response.json()) as { embeddings?: number[][] };
			const vector = data.embeddings?.[0];
			return Array.isArray(vector) && vector.length > 0 ? vector : null;
		} catch (error) {
			this.logger.warn(`Aon embed: ${(error as Error).message}`);
			return null;
		}
	}
}
