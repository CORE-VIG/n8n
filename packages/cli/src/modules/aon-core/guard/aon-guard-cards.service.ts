import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';

import { McpServerApiKeyService } from '@/modules/mcp/mcp-api-key.service';
import { OwnershipService } from '@/services/ownership.service';

const NOTIFY_TIMEOUT_MS = 10_000;

export interface AonGuardCard {
	id: string;
	identity: string;
	opClass: string;
	tier: number;
	summary: string;
	runId: string | null;
}

/**
 * Tells the owner a card is waiting, on Telegram: posts to the "Aon · Guard
 * cards" workflow's webhook, which relays it. Guard itself stays a pure
 * permission system; this is the one place it reaches out.
 */
@Service()
export class AonGuardCardsService {
	constructor(
		private readonly config: GlobalConfig,
		private readonly mcpApiKeys: McpServerApiKeyService,
		private readonly ownership: OwnershipService,
		private readonly logger: Logger,
	) {}

	/** Never throws: a failed notification just means the owner is not pinged, not that the card is lost. */
	async notify(card: AonGuardCard): Promise<void> {
		try {
			const owner = await this.ownership.getInstanceOwner();
			const key =
				(await this.mcpApiKeys.findServerApiKeyForUser(owner, { redact: false })) ??
				(await this.mcpApiKeys.createMcpServerApiKey(owner));
			const base = this.config.aon.mcpUrl.replace(/\/mcp-server\/http$/, '');
			const response = await fetch(`${base}/webhook/aon-guard-card`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', Authorization: `Bearer ${key.apiKey}` },
				body: JSON.stringify({ ...card, url: `${base}/aon/guard` }),
				signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
			});
			if (!response.ok) {
				this.logger.warn(`[aon] guard card webhook answered ${response.status}`);
			}
		} catch (e) {
			this.logger.warn(`[aon] could not notify a Guard card: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
