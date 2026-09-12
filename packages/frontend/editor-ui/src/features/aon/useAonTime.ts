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

	/**
	 * "in 3 hours" and friends, for a future timestamp such as a Guard card's
	 * expiry. `ago`'s own clamp turns a near-zero or already-past future delta
	 * into "just now", which reads as if the deadline were behind us instead
	 * of upon us — this never says that; a card due within the minute says
	 * "in a moment", and one already past says "due now".
	 */
	const untilLabel = (iso: string | null | undefined): string => {
		if (!iso) return '—';
		const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
		if (seconds <= 0) return i18n.baseText('aon.time.dueNow');
		if (seconds < 60) return i18n.baseText('aon.time.inAMoment');
		const minutes = seconds / 60;
		if (minutes < 60) {
			return i18n.baseText('aon.time.inMinutes', { interpolate: { n: String(Math.round(minutes)) } });
		}
		const hours = minutes / 60;
		if (hours < 24) {
			return Math.round(hours) <= 1
				? i18n.baseText('aon.time.inAnHour')
				: i18n.baseText('aon.time.inHours', { interpolate: { n: String(Math.round(hours)) } });
		}
		const days = hours / 24;
		return Math.round(days) <= 1
			? i18n.baseText('aon.time.inADay')
			: i18n.baseText('aon.time.inDays', { interpolate: { n: String(Math.round(days)) } });
	};

	return { ago, untilLabel };
}
