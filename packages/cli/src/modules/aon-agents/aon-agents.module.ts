import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';

/**
 * Aon's agents inside n8n: the roster, what each one owes, and every run.
 *
 * This step is read-only. The executor that lets a run reach `done` in here,
 * and the Guard that gates what it may do, come next.
 */
@BackendModule({ name: 'aon-agents', instanceTypes: ['main'] })
export class AonAgentsModule implements ModuleInterface {
	async init() {
		await import('./aon-agents.controller.js');
	}

	async entities() {
		const { AonAgent } = await import('./database/entities/aon-agent.entity.js');
		const { AonDeliverable } = await import('./database/entities/aon-deliverable.entity.js');
		const { AonRun } = await import('./database/entities/aon-run.entity.js');
		const { AonLearnedRule } = await import('./database/entities/aon-learned-rule.entity.js');
		return [AonAgent, AonDeliverable, AonRun, AonLearnedRule];
	}
}
