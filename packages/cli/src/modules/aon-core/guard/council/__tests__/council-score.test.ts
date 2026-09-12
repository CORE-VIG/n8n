import { describe, expect, it } from 'vitest';

import {
	councilApproveGate,
	isLiveClass,
	scoreClass,
	type CouncilMemberAnswer,
	type CouncilRulingRow,
} from '../council-score';

function member(over: Partial<CouncilMemberAnswer> = {}): CouncilMemberAnswer {
	return { model: 'haiku', approve: true, reason: 'fits the rule', citedRule: 'R1', ...over };
}

describe('councilApproveGate', () => {
	it('refuses fewer than two members', () => {
		expect(councilApproveGate([member()], ['R1'])).toEqual({ approve: false, citedRules: [] });
	});

	it('approves when every member approves and cites a rule that was given', () => {
		const result = councilApproveGate(
			[member({ model: 'haiku', citedRule: 'R1' }), member({ model: 'sonnet', citedRule: 'R2' })],
			['R1', 'R2'],
		);
		expect(result.approve).toBe(true);
		expect(result.citedRules).toEqual(['R1', 'R2']);
	});

	it('refuses a dissent even when the other member approves and cites a rule', () => {
		const result = councilApproveGate(
			[member({ model: 'haiku' }), member({ model: 'sonnet', approve: false })],
			['R1'],
		);
		expect(result).toEqual({ approve: false, citedRules: [] });
	});

	it('refuses when a member approves but cites nothing', () => {
		const result = councilApproveGate(
			[member({ model: 'haiku' }), member({ model: 'sonnet', citedRule: null })],
			['R1'],
		);
		expect(result).toEqual({ approve: false, citedRules: [] });
	});

	it('refuses when a member cites a rule that was never given to it', () => {
		const result = councilApproveGate(
			[member({ model: 'haiku' }), member({ model: 'sonnet', citedRule: 'R9' })],
			['R1'],
		);
		expect(result).toEqual({ approve: false, citedRules: [] });
	});

	it('deduplicates when both members cite the same rule', () => {
		const result = councilApproveGate(
			[member({ model: 'haiku', citedRule: 'R1' }), member({ model: 'sonnet', citedRule: 'R1' })],
			['R1'],
		);
		expect(result).toEqual({ approve: true, citedRules: ['R1'] });
	});
});

function decided(verdict: 'approve' | 'deny', ownerDecision: 'approved' | 'denied'): CouncilRulingRow {
	return { verdict, ownerDecision };
}

function pending(verdict: 'approve' | 'deny'): CouncilRulingRow {
	return { verdict, ownerDecision: null };
}

describe('scoreClass', () => {
	it('is not eligible with no rulings at all', () => {
		const score = scoreClass('mail.send', []);
		expect(score).toEqual({
			opClass: 'mail.send',
			rulings: 0,
			decided: 0,
			agreement: 0,
			falseApprovals: 0,
			eligibleForLive: false,
			blocker: '0 of 20 decided rulings',
		});
	});

	it('is not eligible below twenty decided rulings even with perfect agreement', () => {
		const rows = Array.from({ length: 19 }, () => decided('approve', 'approved'));
		const score = scoreClass('hands.run', rows);
		expect(score.eligibleForLive).toBe(false);
		expect(score.blocker).toBe('19 of 20 decided rulings');
	});

	it('is eligible at twenty decided rulings with zero false approvals', () => {
		const rows = Array.from({ length: 20 }, () => decided('approve', 'approved'));
		const score = scoreClass('hands.run', rows);
		expect(score.eligibleForLive).toBe(true);
		expect(score.blocker).toBeNull();
		expect(score.agreement).toBe(20);
		expect(score.falseApprovals).toBe(0);
	});

	it('a false denial (council said deny, owner approved) does not block promotion', () => {
		const rows: CouncilRulingRow[] = [
			...Array.from({ length: 19 }, () => decided('approve', 'approved')),
			decided('deny', 'approved'),
		];
		const score = scoreClass('hands.run', rows);
		expect(score.eligibleForLive).toBe(true);
		expect(score.agreement).toBe(19);
		expect(score.falseApprovals).toBe(0);
	});

	it('a single false approval blocks promotion however many rulings there are', () => {
		const rows: CouncilRulingRow[] = [
			decided('approve', 'denied'),
			...Array.from({ length: 30 }, () => decided('approve', 'approved')),
		];
		const score = scoreClass('hands.run', rows);
		expect(score.eligibleForLive).toBe(false);
		expect(score.blocker).toBe('1 false approval');
		expect(score.falseApprovals).toBe(1);
	});

	it('only scores the most recent twenty of a longer history', () => {
		const oldFalseApproval = decided('approve', 'denied');
		const rows: CouncilRulingRow[] = [
			...Array.from({ length: 20 }, () => decided('approve', 'approved')),
			oldFalseApproval,
		];
		const score = scoreClass('hands.run', rows);
		expect(score.rulings).toBe(20);
		expect(score.falseApprovals).toBe(0);
		expect(score.eligibleForLive).toBe(true);
	});

	it('undecided (still-pending) rulings count toward the window but not toward decided', () => {
		const rows: CouncilRulingRow[] = [
			pending('approve'),
			pending('deny'),
			...Array.from({ length: 18 }, () => decided('approve', 'approved')),
		];
		const score = scoreClass('hands.run', rows);
		expect(score.rulings).toBe(20);
		expect(score.decided).toBe(18);
		expect(score.eligibleForLive).toBe(false);
		expect(score.blocker).toBe('18 of 20 decided rulings');
	});
});

describe('isLiveClass', () => {
	const eligible = scoreClass('hands.run', Array.from({ length: 20 }, () => decided('approve', 'approved')));
	const notEligible = scoreClass('hands.run', []);

	it('is live when the scoreboard clears the bar and the owner has not pinned it to shadow', () => {
		expect(isLiveClass(eligible, false)).toBe(true);
	});

	it('stays shadow when the owner has pinned it, even with a clean scoreboard', () => {
		expect(isLiveClass(eligible, true)).toBe(false);
	});

	it('stays shadow when the scoreboard is not eligible, whatever the pin says', () => {
		expect(isLiveClass(notEligible, false)).toBe(false);
	});
});
