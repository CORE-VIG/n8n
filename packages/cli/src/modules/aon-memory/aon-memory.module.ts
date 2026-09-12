import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Aon's memory inside n8n: everything it has read, chunked and embedded, and
 * searched by word and by meaning. Capture feeds it — typed text or a page
 * to read — and a background queue finishes embedding whatever capture could
 * not do inline.
 */
@BackendModule({ name: 'aon-memory', instanceTypes: ['main'] })
export class AonMemoryModule implements ModuleInterface {
	async init() {
		await import('./aon-memory.controller.js');
		const { AonEmbedQueueService } = await import('./aon-embed-queue.service.js');
		Container.get(AonEmbedQueueService).start();
	}

	async entities() {
		const { AonSource } = await import('./database/entities/aon-source.entity.js');
		const { AonChunk } = await import('./database/entities/aon-chunk.entity.js');
		return [AonSource, AonChunk];
	}
}
