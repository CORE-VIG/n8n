import type { AuthenticatedRequest } from '@n8n/db';
import { Container } from '@n8n/di';
import { Get, Middleware, Post, RestController } from '@n8n/decorators';
import type { NextFunction, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ServiceUnavailableError } from '@/errors/response-errors/service-unavailable.error';
import { UnprocessableRequestError } from '@/errors/response-errors/unprocessable.error';
import { ResponseError } from '@/errors/response-errors/abstract/response.error';
import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { AonVoiceUploadMiddleware } from './aon-voice-upload.middleware';
import { AonVoiceService, VoiceOffline, VoiceRequestError } from './aon-voice.service';

const aonVoiceUploadMiddleware = Container.get(AonVoiceUploadMiddleware);

const speakBody = z.object({
	text: z.string().trim().min(1).max(20_000),
	voice: z.string().trim().min(1).max(200).optional(),
});

type UploadRequest = AuthenticatedRequest & {
	file?: Express.Multer.File;
	fileUploadError?: Error;
};

/** A ResponseError for a status code none of the named error classes cover. */
class VoiceUpstreamError extends ResponseError {
	constructor(message: string, status: number) {
		super(message, status, status);
	}
}

function toHttpError(err: unknown): Error {
	if (err instanceof VoiceOffline) return new ServiceUnavailableError(err.message);
	if (err instanceof VoiceRequestError) {
		if (err.status === 400) return new BadRequestError(err.message);
		if (err.status === 422) return new UnprocessableRequestError(err.message);
		return new VoiceUpstreamError(err.message, err.status || 502);
	}
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * The window's ears and mouth: whether the host sidecar is reachable, one
 * clip transcribed, one reply spoken. Owner only, like the rest of Aon's
 * own state — this is his voice, not a team feature.
 */
@RestController('/aon/voice')
export class AonVoiceController {
	constructor(private readonly voice: AonVoiceService) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/status')
	async status(): Promise<{ configured: boolean; online: boolean }> {
		const configured = this.voice.configured();
		if (!configured) return { configured, online: false };
		try {
			await this.voice.health();
			return { configured, online: true };
		} catch {
			return { configured, online: false };
		}
	}

	@Post('/transcribe', { middlewares: [aonVoiceUploadMiddleware.single('audio')] })
	async transcribe(req: UploadRequest): Promise<{ text: string }> {
		if (req.fileUploadError) {
			const error = req.fileUploadError;
			throw error instanceof multer.MulterError
				? new BadRequestError(`Audio upload error: ${error.message}`)
				: new BadRequestError('Audio upload failed');
		}
		const file = req.file;
		if (!file?.buffer?.length) throw new BadRequestError('Multipart field "audio" is required');
		try {
			return await this.voice.transcribe(file.buffer, file.mimetype, file.originalname || 'audio');
		} catch (err) {
			throw toHttpError(err);
		}
	}

	@Post('/speak')
	async speak(req: AuthenticatedRequest, res: Response): Promise<void> {
		const parsed = speakBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		try {
			const { buffer, mime } = await this.voice.speak(parsed.data.text, parsed.data.voice);
			res.setHeader('Content-Type', mime);
			res.setHeader('Content-Length', String(buffer.length));
			res.setHeader('Cache-Control', 'no-store');
			res.status(200).send(buffer);
		} catch (err) {
			throw toHttpError(err);
		}
	}
}
