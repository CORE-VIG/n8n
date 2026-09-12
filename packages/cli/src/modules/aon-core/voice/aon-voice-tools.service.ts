import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonVoiceService } from './aon-voice.service';

const statusSchema = {} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/**
 * The voice sidecar's status as a tool: configured and reachable, or not —
 * a normal state, never an error. Speaking and transcribing are not tools:
 * both carry binary audio, which a tool call cannot.
 */
@Service()
export class McpAonVoiceToolsService {
	constructor(private readonly voice: AonVoiceService) {}

	registerTools(registerIfAllowed: RegisterToolFn) {
		const status: ToolDefinition<typeof statusSchema> = {
			name: 'voice_status',
			config: {
				description: "Whether the voice sidecar is configured and reachable, so the window's mic and read-aloud can work.",
				inputSchema: statusSchema,
				annotations: { title: 'Voice status', readOnlyHint: true },
			},
			handler: async () => {
				const configured = this.voice.configured();
				if (!configured) return text('Voice is not configured: AON_VOICE_URL or AON_VOICE_TOKEN is unset.');
				try {
					await this.voice.health();
					return text('Voice is configured and online.');
				} catch {
					return text('Voice is configured but not reachable right now.');
				}
			},
		};

		registerIfAllowed(status);
	}
}
