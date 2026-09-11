import { useI18n } from '@n8n/i18n';

/** "3 h ago" and friends, for the lists; a date once it is older than a month. */
export function useAonTime() {
	const i18n = useI18n();

	const ago = (iso: string | null | undefined): string => {
		if (!iso) return '—';
		const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		if (seconds < 60) return i18n.baseText('aon.time.justNow');
		const minutes = seconds / 60;
		if (minutes < 60) {
			return i18n.baseText('aon.time.minutesAgo', {
				interpolate: { n: String(Math.round(minutes)) },
			});
		}
		const hours = minutes / 60;
		if (hours < 48) {
			return i18n.baseText('aon.time.hoursAgo', { interpolate: { n: String(Math.round(hours)) } });
		}
		const days = hours / 24;
		if (days < 30) {
			return i18n.baseText('aon.time.daysAgo', { interpolate: { n: String(Math.round(days)) } });
		}
		return new Date(iso).toLocaleDateString();
	};

	return { ago };
}
