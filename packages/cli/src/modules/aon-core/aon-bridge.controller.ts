import type { AonMemorySearchMode } from '@n8n/api-types';
import { ModuleRegistry } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';
import { Get, Param, Post, RestController } from '@n8n/decorators';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { UnauthenticatedError } from '@/errors/response-errors/unauthenticated.error';
import type { AonAgentAuthoringService } from '@/modules/aon-agents/aon-agent-authoring.service';
import type { AonRunEventRepository } from '@/modules/aon-agents/database/repositories/aon-run-event.repository';
import type { AonRunRepository } from '@/modules/aon-agents/database/repositories/aon-run.repository';
import type { AonCaptureService } from '@/modules/aon-memory/aon-capture.service';
import type { AonMemorySearchService } from '@/modules/aon-memory/aon-memory-search.service';
import { McpServerApiKeyService } from '@/modules/mcp/mcp-api-key.service';

import { isAonOwner } from './aon-owner';
import { AonTalkService } from './aon-talk.service';
import { AonGuardEventRepository } from './database/repositories/aon-guard-event.repository';
import { tierOf } from './guard/op-classes';
import { stableUuid } from './stable-id';
import { AonVoiceService, VoiceOffline } from './voice/aon-voice.service';

/** A voice note is short; this is generous headroom, not an expected size. */
const MAX_BRIDGE_AUDIO_BYTES = 20 * 1024 * 1024;

const telegramAudio = z.object({
	base64: z.string().min(1),
	mime: z.string().trim().min(1).max(100),
	fileName: z.string().trim().max(200).optional(),
});

const telegramBody = z
	.object({
		chatId: z.union([z.string(), z.number()]).transform((v) => String(v)),
		text: z.string().max(20_000).optional().default(''),
		from: z.object({ id: z.union([z.string(), z.number()]), username: z.string().optional() }),
		/** A Telegram voice note, already downloaded and base64'd by the bridge workflow. */
		audio: telegramAudio.optional(),
		/** Speak the first chunk of the reply back, when the sidecar is up. */
		wantAudio: z.boolean().optional(),
	})
	.refine((body) => body.text.trim().length > 0 || body.audio !== undefined, {
		message: 'text or audio is required',
	});

/** Telegram shows 4096 characters per message; cut a little under, at paragraph ends when possible. */
const TELEGRAM_CHUNK = 3900;

export function chunkForTelegram(text: string, size = TELEGRAM_CHUNK): string[] {
	const out: string[] = [];
	let rest = text.trim();
	while (rest.length > size) {
		let cut = rest.lastIndexOf('\n\n', size);
		if (cut < size / 2) cut = rest.lastIndexOf('\n', size);
		if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
		if (cut < size / 2) cut = size;
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}

const runBody = z.object({
	agent: z.string().min(1).max(40),
	deliverable: z.string().min(1).max(200),
	input: z.string().max(20_000).optional(),
	wait: z.boolean().optional(),
	timeoutSec: z.number().int().min(1).max(900).optional(),
});

/** A run that has reached one of these will not change again. */
const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'stopped']);
const RUN_POLL_MS = 3_000;
const RUN_WAIT_DEFAULT_SEC = 60;

/** `hybrid`/`words`/`meaning` are the node's names for the search's own `hybrid`/`text`/`vector` modes. */
const MEMORY_SEARCH_MODES = ['hybrid', 'words', 'meaning'] as const;
const MEMORY_MODE_MAP: Record<(typeof MEMORY_SEARCH_MODES)[number], AonMemorySearchMode> = {
	hybrid: 'hybrid',
	words: 'text',
	meaning: 'vector',
};

const memorySearchBody = z.object({
	query: z.string().min(1).max(2000),
	mode: z.enum(MEMORY_SEARCH_MODES).optional(),
	limit: z.number().int().min(1).max(50).optional(),
});

const memoryCaptureBody = z
	.object({
		title: z.string().max(500).optional(),
		text: z.string().optional(),
		url: z.string().max(4096).optional(),
		kind: z.string().max(100).optional(),
	})
	.refine((body) => Boolean(body.text?.trim()) !== Boolean(body.url?.trim()), {
		message: 'Give me exactly one of text or a url to capture.',
	});

/**
 * The channel bridge: one owner message from Telegram becomes one assistant
 * turn, and the reply goes back. A workflow (Telegram Trigger → HTTP Request →
 * Telegram) carries the messages; this endpoint decides who is the owner.
 *
 * Three locks, all required: the caller holds the owner's MCP API key (the
 * workflow's Header Auth credential), the chat id is one the owner listed in
 * AON_TELEGRAM_CHAT_IDS, and the *sender* (`from.id`) is one the owner listed
 * in AON_TELEGRAM_USER_IDS (or, when that is empty, one of the same chat ids
 * — a private chat's id equals its owner's user id). The chat id alone is not
 * enough: anyone who can post into an allowed chat — a group the owner is
 * merely a member of, for instance — would otherwise speak as him. A stranger
 * who finds the bot gets nothing, and a scheduled or third-party message
 * never passes as the owner speaking.
 *
 * `/run`, `/run/:id`, `/memory/search` and `/memory/capture` are the other
 * bridge a workflow crosses: the Aon node's, not a channel's. The same
 * Bearer lock applies (the owner's MCP key), but there is no chat or sender
 * to check — a workflow that holds the key may use an agent as a means and
 * read or add to memory. It never reaches the assistant this way: there is
 * no "ask the assistant" operation here, on purpose (see AON.md, "Workflow").
 */
@RestController('/aon/bridge')
export class AonBridgeController {
	constructor(
		private readonly config: GlobalConfig,
		private readonly mcpApiKeys: McpServerApiKeyService,
		private readonly talk: AonTalkService,
		private readonly voice: AonVoiceService,
		private readonly moduleRegistry: ModuleRegistry,
		private readonly guardEvents: AonGuardEventRepository,
	) {}

	/** The owner behind one Bearer MCP key; every bridge route needs exactly this and nothing more. */
	private async ownerFromBearer(req: Request): Promise<User> {
		const header = req.header('authorization') ?? '';
		const match = /^Bearer\s+(.+)$/i.exec(header);
		if (!match) throw new UnauthenticatedError('The bridge needs the owner\'s MCP key as a Bearer token');
		let user: User | null = null;
		try {
			user = (await this.mcpApiKeys.verifyApiKey(match[1].trim())).user;
		} catch {
			throw new UnauthenticatedError('That key does not open the bridge');
		}
		if (!user) throw new UnauthenticatedError('That key does not open the bridge');
		if (!isAonOwner(user)) throw new ForbiddenError('The bridge answers only to the instance owner');
		return user;
	}

	/**
	 * The agent runtime lives in `aon-agents`, a module that may be inactive
	 * on this instance; import it only once it is confirmed active, the way
	 * `AonSettingsService.executorRunning` and the MCP server already do.
	 */
	private async agentsModuleParts(): Promise<{
		authoring: AonAgentAuthoringService;
		runs: AonRunRepository;
		runEvents: AonRunEventRepository;
	}> {
		if (!this.moduleRegistry.isActive('aon-agents')) {
			throw new BadRequestError('Aon agents are not active on this instance.');
		}
		const { AonAgentAuthoringService } = await import('@/modules/aon-agents/aon-agent-authoring.service.js');
		const { AonRunRepository } = await import('@/modules/aon-agents/database/repositories/aon-run.repository.js');
		const { AonRunEventRepository } = await import(
			'@/modules/aon-agents/database/repositories/aon-run-event.repository.js'
		);
		return {
			authoring: Container.get(AonAgentAuthoringService),
			runs: Container.get(AonRunRepository),
			runEvents: Container.get(AonRunEventRepository),
		};
	}

	/** Same reasoning as `agentsModuleParts`, for the `aon-memory` module. */
	private async memoryModuleParts(): Promise<{
		search: AonMemorySearchService;
		capture: AonCaptureService;
	}> {
		if (!this.moduleRegistry.isActive('aon-memory')) {
			throw new BadRequestError('Aon memory is not active on this instance.');
		}
		const { AonMemorySearchService } = await import('@/modules/aon-memory/aon-memory-search.service.js');
		const { AonCaptureService } = await import('@/modules/aon-memory/aon-capture.service.js');
		return {
			search: Container.get(AonMemorySearchService),
			capture: Container.get(AonCaptureService),
		};
	}

	/** The run view the node's "Run deliverable" and "Get run" operations both return. */
	private async runView(
		parts: { runs: AonRunRepository; runEvents: AonRunEventRepository },
		runId: string,
	) {
		const detail = await parts.runs.findDetail(runId);
		if (!detail) throw new NotFoundError(`There is no run with the id ${runId}.`);
		const events = await parts.runEvents.listForRun(runId);
		return {
			runId: detail.id,
			status: detail.status,
			output: detail.output,
			verdict: detail.verification,
			costEur: detail.costEur,
			events: events.slice(-20),
		};
	}

	@Post('/run', { skipAuth: true, ipRateLimit: { limit: 60 } })
	async run(req: Request, _res: Response) {
		await this.ownerFromBearer(req);
		const parsed = runBody.safeParse(req.body);
		if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'bad body');
		const { agent, deliverable, input, wait, timeoutSec } = parsed.data;
		const parts = await this.agentsModuleParts();

		const started = await parts.authoring.startRun(agent, deliverable, input, 'workflow');

		// A record, not a gate: the owner's key already authorized this call;
		// this line is so the run's origin (which workflow) survives in the audit trail.
		const workflowId = req.header('x-aon-workflow');
		if (workflowId) {
			await this.guardEvents.append({
				identity: `workflow:${workflowId}`,
				opClass: 'run.start',
				tier: tierOf('run.start'),
				verdict: 'allow',
				approvalId: null,
				meta: { runId: started.id, agent, deliverable },
			});
		}

		if (wait === false) return { runId: started.id, status: 'queued' };

		const deadline = Date.now() + (timeoutSec ?? RUN_WAIT_DEFAULT_SEC) * 1000;
		let view = await this.runView(parts, started.id);
		while (!TERMINAL_RUN_STATUSES.has(view.status) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
			view = await this.runView(parts, started.id);
		}
		return view;
	}

	@Get('/run/:id', { skipAuth: true, ipRateLimit: { limit: 120 } })
	async getRun(req: Request, _res: Response, @Param('id') id: string) {
		await this.ownerFromBearer(req);
		const parts = await this.agentsModuleParts();
		return await this.runView(parts, id);
	}

	@Post('/memory/search', { skipAuth: true, ipRateLimit: { limit: 60 } })
	async memorySearch(req: Request, _res: Response) {
		await this.ownerFromBearer(req);
		const parsed = memorySearchBody.safeParse(req.body);
		if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'bad body');
		const { search } = await this.memoryModuleParts();
		return await search.search({
			query: parsed.data.query,
			mode: MEMORY_MODE_MAP[parsed.data.mode ?? 'hybrid'],
			limit: parsed.data.limit ?? 10,
		});
	}

	@Post('/memory/capture', { skipAuth: true, ipRateLimit: { limit: 60 } })
	async memoryCapture(req: Request, _res: Response) {
		await this.ownerFromBearer(req);
		const parsed = memoryCaptureBody.safeParse(req.body);
		if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'bad body');
		const { capture } = await this.memoryModuleParts();
		return await capture.capture({ ...parsed.data, origin: 'workflow' });
	}

	@Get('/agents', { skipAuth: true, ipRateLimit: { limit: 60 } })
	async agentsRoster(req: Request, _res: Response) {
		await this.ownerFromBearer(req);
		if (!this.moduleRegistry.isActive('aon-agents')) return [];
		const { AonAgentRepository } = await import('@/modules/aon-agents/database/repositories/aon-agent.repository.js');
		const { AonDeliverableRepository } = await import(
			'@/modules/aon-agents/database/repositories/aon-deliverable.repository.js'
		);
		const agents = Container.get(AonAgentRepository);
		const deliverables = Container.get(AonDeliverableRepository);
		const roster = await agents.listRoster();
		return await Promise.all(
			roster.map(async (a) => ({
				slug: a.slug,
				name: a.name,
				status: a.status,
				deliverables: (await deliverables.listForAgent(a.id)).map((d) => ({
					id: d.id,
					name: d.name,
					shape: d.shape,
					enabled: d.enabled,
				})),
			})),
		);
	}

	@Post('/telegram', { skipAuth: true, ipRateLimit: { limit: 60 } })
	async telegram(req: Request, res: Response) {
		const owner = await this.ownerFromBearer(req);

		const parsed = telegramBody.safeParse(req.body);
		if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'bad body');
		const { chatId, text, from, audio, wantAudio } = parsed.data;

		const allowed = this.config.aon.telegramChatIds
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!allowed.includes(chatId)) {
			throw new ForbiddenError(
				`Chat ${chatId} is not listed as the owner. Add it to AON_TELEGRAM_CHAT_IDS to open the bridge for it.`,
			);
		}

		const userAllowList = this.config.aon.telegramUserIds.trim()
			? this.config.aon.telegramUserIds
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: allowed;
		if (!userAllowList.includes(String(from.id))) {
			throw new ForbiddenError('This bot answers its owner only.');
		}

		const threadId = stableUuid('aon-telegram', `${owner.id}:${chatId}`);

		// Voice in: a voice note is transcribed before the turn runs at all. The
		// sidecar being down is a normal state, not a failure of the bridge — he
		// still gets a reply on Telegram, just one that asks him to type instead.
		let transcript: string | null = null;
		let spokenText = text.trim();
		if (audio) {
			if (Buffer.byteLength(audio.base64, 'base64') > MAX_BRIDGE_AUDIO_BYTES) {
				throw new BadRequestError(`audio exceeds the ${MAX_BRIDGE_AUDIO_BYTES} byte cap`);
			}
			try {
				const result = await this.voice.transcribe(
					Buffer.from(audio.base64, 'base64'),
					audio.mime,
					audio.fileName ?? 'voice.ogg',
				);
				transcript = result.text.trim();
				spokenText = transcript;
			} catch (err) {
				// Offline, or the sidecar rejected this clip: either way, hearing
				// failed and the turn never runs. He can always fall back to typing.
				const message =
					"I can't hear right now — the voice service is offline; type it and I'll answer.";
				return {
					threadId,
					text: message,
					chunks: chunkForTelegram(message),
					costUsd: 0,
					error: err instanceof VoiceOffline ? 'voice_offline' : 'voice_error',
					transcript: null,
				};
			}
		}

		let reply = '';
		let costUsd = 0;
		let error: string | null = null;
		const controller = new AbortController();
		res.on('close', () => controller.abort());
		const tag = audio ? '[From Telegram, spoken]' : '[From Telegram]';
		await this.talk.turn(
			{ user: owner, sessionId: threadId, text: `${tag} ${spokenText}`, reset: false },
			(frame) => {
				if (frame.type === 'text' && typeof frame.delta === 'string') reply += frame.delta;
				else if (frame.type === 'cost' && typeof frame.usd === 'number') costUsd = frame.usd;
				else if (frame.type === 'error' && typeof frame.message === 'string') error = frame.message;
			},
			controller.signal,
		);
		const text_ = reply.trim() || error || 'I have nothing to say to that.';
		const chunks = chunkForTelegram(text_);

		// Voice out: best-effort. The text reply above is never held up by this,
		// and a sidecar that is down or slow just means no voice note this time.
		let audioOut: { base64: string; mime: string } | undefined;
		if (wantAudio) {
			try {
				const spoken = await this.voice.speak(chunks[0] ?? text_);
				audioOut = { base64: spoken.buffer.toString('base64'), mime: spoken.mime };
			} catch {
				// no audio this time; the text chunks below still carry the reply
			}
		}

		return {
			threadId,
			text: text_,
			chunks,
			costUsd,
			error,
			...(audio ? { transcript } : {}),
			...(audioOut ? { audio: audioOut } : {}),
		};
	}
}
