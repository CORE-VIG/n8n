import { Service } from '@n8n/di';
import type { RequestHandler } from 'express';
import multer from 'multer';

/** A spoken clip is short; this is generous headroom, not an expected size. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * One recorded clip in, kept in memory only: it goes straight to the voice
 * sidecar and is never written to disk here.
 */
@Service()
export class AonVoiceUploadMiddleware {
	private readonly upload: multer.Multer;

	constructor() {
		this.upload = multer({
			storage: multer.memoryStorage(),
			limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
		});
	}

	single(fieldName: string): RequestHandler {
		return (req, res, next) => {
			void this.upload.single(fieldName)(req, res, (error) => {
				if (error) {
					(req as typeof req & { fileUploadError?: Error }).fileUploadError = error as Error;
				}
				next();
			});
		};
	}
}
