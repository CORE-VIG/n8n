import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Aon's core, inside n8n.
 *
 * The module owns the assistant (a Claude Code session on the owner's
 * subscription, holding this instance's own MCP tools, streamed into a window
 * over every page), its conversations, and Hands: the fenced workspaces where
 * the assistant and agents run commands and keep files.
 *
 * Main only: it spawns processes and holds sessions, and a worker or webhook
 * process has no business doing either.
 */
@BackendModule({ name: 'aon-core', instanceTypes: ['main'] })
export class AonCoreModule implements ModuleInterface {
	async init() {
		await import('./aon-talk.controller.js');
		await import('./aon-threads.controller.js');
		await import('./hands/aon-hands.controller.js');
		const { AonTalkService } = await import('./aon-talk.service.js');
		await Container.get(AonTalkService).init();
	}

	async entities() {
		const { AonThread } = await import('./database/entities/aon-thread.entity.js');
		const { AonTurn } = await import('./database/entities/aon-turn.entity.js');
		const { AonWorkspace } = await import('./database/entities/aon-workspace.entity.js');
		return [AonThread, AonTurn, AonWorkspace];
	}

	async settings() {
		return { assistant: { enabled: true } };
	}
}
