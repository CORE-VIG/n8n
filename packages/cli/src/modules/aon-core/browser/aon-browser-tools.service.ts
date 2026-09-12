import type { AonBrowserActStep } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonBrowserService, checkUrl, ownHosts, BrowserOffline, UrlRefused } from './aon-browser.service';
import { AonGuardService } from '../guard/aon-guard.service';
import { AON_OP_CLASSES } from '../guard/op-classes';
import { identityFromRequest } from '../guard/request-identity';

const MAX_TEXT = 100 * 1024;

const readSchema = {
	url: z.string().min(1).max(2048).describe('A public web page to open and read.'),
} satisfies z.ZodRawShape;

const stepSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('navigate'), url: z.string().min(1).max(2048) }),
	z.object({ kind: z.literal('click'), ref: z.string().optional(), text: z.string().optional() }),
	z.object({
		kind: z.literal('type'),
		ref: z.string().optional(),
		text: z.string().optional(),
		value: z.string(),
		submit: z.boolean().optional(),
	}),
	z.object({ kind: z.literal('wait'), ms: z.number().int().min(0).max(5000) }),
	z.object({ kind: z.literal('snapshot') }),
	z.object({ kind: z.literal('screenshot') }),
]);

const actSchema = {
	steps: z
		.array(stepSchema)
		.min(1)
		.max(20)
		.describe(
			'Steps run in order, in one browser lease: navigate {url}, click {ref|text}, type {ref|text, value, submit?}, wait {ms<=5000}, snapshot, screenshot. Give ref when you already have one from a snapshot; otherwise text is matched against the page\'s interactive elements.',
		),
	purpose: z.string().trim().min(1).max(300).describe('One line, in plain words, for the card the owner may see.'),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Browser: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});

function clip(value: string, max = MAX_TEXT): string {
	if (Buffer.byteLength(value) <= max) return value;
	return `${Buffer.from(value).subarray(0, max).toString('utf8')}\n…(cut, only the first ${max} bytes shown)`;
}

/** The start of a string, for a card summary: never the whole page or step list. */
function preview(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The assistant's browser, offered as MCP tools of this instance: `web_read`
 * for a public page, `web_act` for logging-in-free interactions on one.
 * Guard sees `web.read` (tier 1) and `web.act` (tier 3); a refused URL never
 * reaches Guard or the browser.
 */
@Service()
export class McpAonBrowserToolsService {
	constructor(
		private readonly browser: AonBrowserService,
		private readonly guard: AonGuardService,
	) {}

	async registerTools(registerIfAllowed: RegisterToolFn, user: User) {
		if (!(await this.browser.isConfigured())) return;
		for (const tool of this.tools(user)) registerIfAllowed(tool);
	}

	private tools(user: User): Array<ToolDefinition<z.ZodRawShape>> {
		const read: ToolDefinition<typeof readSchema> = {
			name: 'web_read',
			config: {
				description:
					'Read a public web page in the fenced browser: its title, url, readable text and links. Refuses a private, local or own-instance address, or one carrying a username or password, before ever opening the browser.',
				inputSchema: readSchema,
				annotations: { title: 'Read a web page', readOnlyHint: true, openWorldHint: true },
			},
			handler: async (args, extra) => {
				const check = checkUrl(args.url, ownHosts());
				if (!check.ok) return { content: [{ type: 'text' as const, text: `Browser: ${check.reason}` }], isError: true };
				try {
					const identity = identityFromRequest(extra, user);
					const decision = await this.guard.decideTool(identity, 'web_read', args);

					if (decision.verdict === 'deny') {
						await this.guard.record(identity, decision.opClass, 'deny', { url: check.url });
						const label = AON_OP_CLASSES.find((c) => c.opClass === decision.opClass)?.label ?? decision.opClass;
						return { content: [{ type: 'text' as const, text: `Guard denies this: ${label}` }], isError: true };
					}

					if (decision.verdict === 'ask') {
						const approval = await this.guard.requestApproval(identity, decision.opClass, `Read: ${check.url}`, {
							url: check.url,
						});
						return text(`Guard needs the owner's yes: card ${approval.id} raised. Stop now and wait.`);
					}

					await this.guard.record(identity, decision.opClass, 'allow', { url: check.url });

					const result = await this.browser.read(check.url);
					const links = result.links.length
						? `\n\nLinks:\n${result.links.map((l) => `- ${l.text || '(no text)'}: ${l.href}`).join('\n')}`
						: '';
					return text(clip(`${result.title || '(no title)'} — ${result.url}\n\n${result.text}${links}`));
				} catch (error) {
					return this.browserFailure(error);
				}
			},
		};

		const act: ToolDefinition<typeof actSchema> = {
			name: 'web_act',
			config: {
				description:
					'Act on a public web page in the fenced browser: navigate, click, type, wait, snapshot, screenshot, in one lease. Never for money, credentials or a page that needs his account. Refuses a private, local or own-instance address before ever opening the browser.',
				inputSchema: actSchema,
				annotations: { title: 'Act on a web page', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
			},
			handler: async (args, extra) => {
				const steps: AonBrowserActStep[] = args.steps;
				for (const step of steps) {
					if (step.kind !== 'navigate') continue;
					const check = checkUrl(step.url, ownHosts());
					if (!check.ok) return { content: [{ type: 'text' as const, text: `Browser: ${check.reason}` }], isError: true };
				}
				try {
					const identity = identityFromRequest(extra, user);
					const decision = await this.guard.decideTool(identity, 'web_act', args);

					if (decision.verdict === 'deny') {
						await this.guard.record(identity, decision.opClass, 'deny', { purpose: preview(args.purpose, 120) });
						const label = AON_OP_CLASSES.find((c) => c.opClass === decision.opClass)?.label ?? decision.opClass;
						return { content: [{ type: 'text' as const, text: `Guard denies this: ${label}` }], isError: true };
					}

					if (decision.verdict === 'ask') {
						const approval = await this.guard.requestApproval(
							identity,
							decision.opClass,
							`Act: ${preview(args.purpose, 120)}`,
							{ purpose: args.purpose, steps },
						);
						return text(`Guard needs the owner's yes: card ${approval.id} raised. Stop now and wait.`);
					}

					await this.guard.record(identity, decision.opClass, 'allow', { purpose: preview(args.purpose, 120) });

					const result = await this.browser.act(steps);
					const lines = result.steps.map(
						(s, i) => `${i + 1}. ${s.kind}: ${s.ok ? s.text ?? '(image captured)' : `failed — ${s.error}`}`,
					);
					const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
						{ type: 'text', text: clip(`${lines.join('\n')}\n\n--- page now ---\n${result.snapshot}`) },
					];
					if (result.screenshot) content.push({ type: 'image', data: result.screenshot.data, mimeType: result.screenshot.mimeType });
					return { content };
				} catch (error) {
					return this.browserFailure(error);
				}
			},
		};

		return [read, act] as Array<ToolDefinition<z.ZodRawShape>>;
	}

	private browserFailure(error: unknown) {
		if (error instanceof BrowserOffline) return { content: [{ type: 'text' as const, text: 'Browser: the browser is offline.' }], isError: true };
		if (error instanceof UrlRefused) return { content: [{ type: 'text' as const, text: `Browser: ${error.reason}` }], isError: true };
		return failure(error);
	}
}
