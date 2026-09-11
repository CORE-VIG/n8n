import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Aon's core, inside n8n.
 *
 * The first thing this module owns is the assistant: a Claude Code session on
 * the owner's subscription, holding this instance's own MCP tools, streamed
 * into a window that sits over every page. Memory, agents and Guard join it
 * here as they are ported.
 *
 * Main only: it spawns processes and holds sessions, and a worker or webhook
 * process has no business doing either.
 */
@BackendModule({ name: 'aon-core', instanceTypes: ['main'] })
export class AonCoreModule implements ModuleInterface {
	async init() {
		await import('./aon-talk.controller.js');
		const { AonTalkService } = await import('./aon-talk.service.js');
		await Container.get(AonTalkService).init();
	}

	async settings() {
		return { assistant: { enabled: true } };
	}
}
