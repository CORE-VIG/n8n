import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';

import { AonSettingsService } from '../settings/aon-settings.service';

const NOTIFY_TIMEOUT_MS = 10_000;

export interface AonGuardCard {
	id: string;
	identity: string;
	opClass: string;
	tier: number;
	summary: string;
	runId: string | null;
	/** "card" (the default) is a pending ask; "council" is a live approval the council already made. Lets the workflow pick its template. */
	kind?: 'card' | 'council';
}

/**
 * Tells the owner a card is waiting, on Telegram: posts to the "Aon · Guard
 * cards" workflow's webhook, which relays it. Guard itself stays a pure
 * permission system; this is the one place it reaches out.
 *
 * Authenticates with a secret of its own (`AonSettingsService.guardCardSecret()`),
 * never the owner's MCP key: that key can act as the owner everywhere, and this
 * webhook only ever needs to prove the call came from this instance.
 */
@Service()
export class AonGuardCardsService {
	constructor(
		private readonly config: GlobalConfig,
		private readonly settings: AonSettingsService,
		private readonly logger: Logger,
	) {}

	/** Never throws: a failed notification just means the owner is not pinged, not that the card is lost. */
	async notify(card: AonGuardCard): Promise<void> {
		try {
			const secret = await this.settings.guardCardSecret();
			const base = this.config.aon.mcpUrl.replace(/\/mcp-server\/http$/, '');
			const response = await fetch(`${base}/webhook/aon-guard-card`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'X-Aon-Card-Secret': secret },
				body: JSON.stringify({ ...card, kind: card.kind ?? 'card', url: `${base}/aon/guard` }),
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
