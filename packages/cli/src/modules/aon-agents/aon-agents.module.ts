import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Aon's agents inside n8n: the roster, what each one owes, and every run.
 *
 * The executor claims queued runs and lets them reach `done`; Guard (in
 * `aon-core`) gates what a run may do along the way.
 */
@BackendModule({ name: 'aon-agents', instanceTypes: ['main'] })
export class AonAgentsModule implements ModuleInterface {
	async init() {
		await import('./aon-agents.controller.js');
		const { AonExecutorService } = await import('./executor/aon-executor.service.js');
		Container.get(AonExecutorService).start();
	}

	async entities() {
		const { AonAgent } = await import('./database/entities/aon-agent.entity.js');
		const { AonDeliverable } = await import('./database/entities/aon-deliverable.entity.js');
		const { AonRun } = await import('./database/entities/aon-run.entity.js');
		const { AonLearnedRule } = await import('./database/entities/aon-learned-rule.entity.js');
		const { AonRunEvent } = await import('./database/entities/aon-run-event.entity.js');
		return [AonAgent, AonDeliverable, AonRun, AonLearnedRule, AonRunEvent];
	}
}
