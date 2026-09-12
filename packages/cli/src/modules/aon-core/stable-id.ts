import { createHash } from 'node:crypto';

/** A UUID-shaped id derived from a name, so the same name always finds the same row. */
export function stableUuid(namespace: string, name: string): string {
	const h = createHash('sha256').update(`${namespace}:${name}`).digest('hex');
	const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
