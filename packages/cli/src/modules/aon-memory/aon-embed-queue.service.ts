import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';

import { AonEmbedService } from './aon-embed.service';
import { AonChunkRepository } from './database/repositories/aon-chunk.repository';

const INTERVAL_MS = 20_000;
const BATCH_SIZE = 20;

/**
 * Finishes what capture left behind: chunks stored without a vector because
 * there were more than the inline budget, or the embedder was briefly down.
 * Runs on a timer so a slow or unavailable Ollama never blocks capture
 * itself; skipped entirely when there is no embedder to run.
 */
@Service()
export class AonEmbedQueueService {
	private running = false;

	constructor(
		private readonly chunks: AonChunkRepository,
		private readonly embedder: AonEmbedService,
		private readonly logger: Logger,
	) {}

	start() {
		if (!this.embedder.enabled) return;
		setInterval(() => {
			void this.tick();
		}, INTERVAL_MS).unref();
	}

	private async tick() {
		if (this.running) return;
		this.running = true;
		try {
			const pending = await this.chunks.listPendingEmbedding(BATCH_SIZE);
			let embedded = 0;
			for (const chunk of pending) {
				const vector = await this.embedder.embed(chunk.text);
				if (vector) {
					await this.chunks.setEmbedding(chunk.id, vector);
					embedded += 1;
				}
			}
			if (embedded > 0) {
				this.logger.info(`Aon memory: embedded ${embedded} chunk(s) in the background`);
			}
		} finally {
			this.running = false;
		}
	}
}
