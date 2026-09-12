import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Aon's memory inside n8n: everything it has read, chunked and embedded, and
 * searched by word and by meaning, plus the graph of entities and facts read
 * out of it. Capture feeds it — typed text or a page to read — a background
 * queue finishes embedding whatever capture could not do inline, and the
 * extractor turns unread sources into pending facts for the owner to decide.
 */
@BackendModule({ name: 'aon-memory', instanceTypes: ['main'] })
export class AonMemoryModule implements ModuleInterface {
	async init() {
		await import('./aon-memory.controller.js');
		const { AonEmbedQueueService } = await import('./aon-embed-queue.service.js');
		Container.get(AonEmbedQueueService).start();
		const { AonExtractService } = await import('./aon-extract.service.js');
		Container.get(AonExtractService).start();
	}

	async entities() {
		const { AonSource } = await import('./database/entities/aon-source.entity.js');
		const { AonChunk } = await import('./database/entities/aon-chunk.entity.js');
		const { AonEntity } = await import('./database/entities/aon-entity.entity.js');
		const { AonFact } = await import('./database/entities/aon-fact.entity.js');
		const { AonObservation } = await import('./database/entities/aon-observation.entity.js');
		return [AonSource, AonChunk, AonEntity, AonFact, AonObservation];
	}
}
