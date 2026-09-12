const CHUNK_MAX_CHARS = 1200;
const SENTENCE_ENDS = ['. ', '! ', '? ', '\n'];

/**
 * Splits text into pieces small enough to embed: paragraphs first, packed
 * together up to the cap so short paragraphs share a chunk; a paragraph
 * longer than the cap is cut at a sentence end near it, or hard at the cap
 * when no sentence end is close enough. Never returns an empty piece.
 */
export function chunkText(text: string): string[] {
	const paragraphs = text
		.split(/\n\s*\n+/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);

	const units = paragraphs.flatMap((paragraph) =>
		paragraph.length <= CHUNK_MAX_CHARS ? [paragraph] : splitLongParagraph(paragraph),
	);

	const chunks: string[] = [];
	let buffer = '';
	for (const unit of units) {
		if (buffer.length === 0) {
			buffer = unit;
		} else if (buffer.length + 2 + unit.length <= CHUNK_MAX_CHARS) {
			buffer = `${buffer}\n\n${unit}`;
		} else {
			chunks.push(buffer);
			buffer = unit;
		}
	}
	if (buffer.length > 0) chunks.push(buffer);
	return chunks;
}

function splitLongParagraph(paragraph: string): string[] {
	const pieces: string[] = [];
	let rest = paragraph;
	while (rest.length > CHUNK_MAX_CHARS) {
		const window = rest.slice(0, CHUNK_MAX_CHARS);
		const cut = lastSentenceEnd(window) ?? CHUNK_MAX_CHARS;
		const piece = rest.slice(0, cut).trim();
		if (piece.length > 0) pieces.push(piece);
		rest = rest.slice(cut).trim();
	}
	if (rest.length > 0) pieces.push(rest);
	return pieces;
}

/** The end of the sentence closest to the window's end; null when none is found. */
function lastSentenceEnd(window: string): number | null {
	let best = -1;
	for (const marker of SENTENCE_ENDS) {
		const at = window.lastIndexOf(marker);
		if (at === -1) continue;
		const end = at + marker.length;
		if (end > best) best = end;
	}
	return best > 0 ? best : null;
}
