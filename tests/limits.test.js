// Scenario tests for limits.js — the cases from docs/priority-logic.html.
// Run: TZ=Asia/Kolkata gjs -m tests/limits.test.js

import GLib from 'gi://GLib';
import System from 'system';
import {summarise, workMs, scheduleOf, planLimits} from '../limits.js';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Tue 27 Oct 2026, 1:26 PM IST
const NOW = GLib.DateTime.new_local(2026, 10, 27, 13, 26, 0).to_unix() * 1000;

function settings(over = {}) {
    const v = {
        'pace-hours': 'work', 'work-days': ['mon', 'tue', 'wed', 'thu', 'fri'], 'work-start': 9, 'work-end': 19,
        'day-off': '', 'amber-at': 95, 'model-colour': 'amber', 'number-mode': 'used',
        'countdown-mode': 'always', 'time-style': 'remaining', ...over,
    };
    return {get_string: k => v[k], get_int: k => v[k], get_strv: k => v[k], get_boolean: k => v[k]};
}

const iso = ms => GLib.DateTime.new_from_unix_utc(Math.floor(ms / 1000)).format_iso8601();
const lim = (used, resetInMs, now = NOW) => ({utilization: used, resets_at: resetInMs === null ? null : iso(now + resetInMs)});
const byKey = (s, k) => s.limits.find(i => i.key === k);

let failed = 0;
function test(name, fn) {
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}\n     ${e.message}`);
    }
}
function eq(actual, expected, what) {
    if (actual !== expected)
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Thu 29 Oct 1:30 PM reset → 2d 0h 4m from NOW
const WEEK_RESET = 2 * DAY + 4 * MIN;

test('1 today (work hours): session first, week 64% heads for Thu ~10:15 AM → amber, shown', () => {
    const s = summarise({five_hour: lim(11, 3 * MIN), seven_day: lim(64, WEEK_RESET)}, settings(), NOW);
    const w = byKey(s, 'seven_day');
    eq(w.reason, 'heading', 'week reason');
    eq(Math.round(w.pace), 107, 'week pace');
    const out = GLib.DateTime.new_from_unix_local(Math.floor(w.outMs / 1000));
    eq(out.format('%a %H'), 'Thu 10', 'run-out hour');
    eq(s.text, '11% · W 64%', 'label');
    eq(s.top.key, 'seven_day', 'colour from');
    eq(s.cd.kind, 'reset', 'countdown kind');
    eq(s.cd.ms - NOW, 3 * MIN, 'countdown is the session reset');
});

test('1b today (calendar time): week projects ~90% → green, hidden', () => {
    const s = summarise({five_hour: lim(11, 3 * MIN), seven_day: lim(64, WEEK_RESET)}, settings({'pace-hours': 'all'}), NOW);
    eq(byKey(s, 'seven_day').level, 0, 'week level');
    eq(s.text, '11%', 'label');
    eq(s.top.level, 0, 'pill');
});

test('2 session idle, week 99% resets in 1 day → red, week countdown', () => {
    const s = summarise({five_hour: lim(0, null), seven_day: lim(99, DAY)}, settings(), NOW);
    eq(byKey(s, 'seven_day').reason, 'almost', 'week reason');
    eq(s.top.level, 2, 'pill');
    eq(s.text, '0% · W 99%', 'label');
    eq(s.cd.ms - NOW, DAY, 'countdown = week reset');
});

test('3 session 85% after 3 h → red, runs out in ~32 min', () => {
    const s = summarise({five_hour: lim(85, 2 * HOUR)}, settings(), NOW);
    const i = byKey(s, 'five_hour');
    eq(i.reason, 'out', 'reason');
    eq(Math.round((i.outMs - NOW) / MIN), 32, 'minutes to run-out');
    eq(s.cd.kind, 'out', 'countdown kind');
});

test('4 session 60% after 4 h → pace 75, green', () => {
    const i = byKey(summarise({five_hour: lim(60, HOUR)}, settings(), NOW), 'five_hour');
    eq(Math.round(i.pace), 75, 'pace');
    eq(i.level, 0, 'level');
});

test('5 week 70% with 2 days left (calendar) → pace 98, amber', () => {
    const s = summarise({five_hour: lim(20, 3 * HOUR), seven_day: lim(70, 2 * DAY)}, settings({'pace-hours': 'all'}), NOW);
    const w = byKey(s, 'seven_day');
    eq(Math.round(w.pace), 98, 'pace');
    eq(w.reason, 'close', 'reason');
    eq(s.text, '20% · W 70%', 'label');
});

test('6 Fable 100%, week 40% → Fable red, pill capped amber; red when model-colour = red', () => {
    const data = {five_hour: lim(12, 3 * HOUR), seven_day: lim(40, 2 * DAY), seven_day_fable: lim(100, 2 * DAY)};
    const s = summarise(data, settings({'pace-hours': 'all'}), NOW);
    eq(byKey(s, 'seven_day_fable').level, 2, 'fable level');
    eq(s.top.pillLevel, 1, 'pill capped');
    eq(s.text, '12% · F 100%', 'label');
    eq(s.cd.ms - NOW, 3 * HOUR, 'countdown stays on the session (Fable is capped at amber)');
    eq(summarise(data, settings({'pace-hours': 'all', 'model-colour': 'red'}), NOW).top.pillLevel, 2, 'pill red');
});

test('7 no session active → green, no countdown', () => {
    const s = summarise({five_hour: lim(0, null), seven_day: lim(10, 5 * DAY)}, settings(), NOW);
    eq(s.top.level, 0, 'pill');
    eq(s.cd, null, 'countdown');
    eq(s.text, '0%', 'label');
});

test('8 session reset passed, not refetched → 0% ↻, stale', () => {
    const s = summarise({five_hour: lim(40, -2 * MIN)}, settings(), NOW);
    eq(s.text, '0% ↻', 'label');
    eq(s.stale, true, 'stale');
    eq(s.cd, null, 'countdown');
});

test('9 idle then a 50% burst in the last 30 min → red via recent rate', () => {
    const history = [{t: NOW - 30 * MIN, used: 0}, {t: NOW - 15 * MIN, used: 25}];
    const plain = byKey(summarise({five_hour: lim(50, HOUR)}, settings(), NOW), 'five_hour');
    eq(plain.level, 0, 'average alone says green');
    const i = byKey(summarise({five_hour: lim(50, HOUR)}, settings(), NOW, history), 'five_hour');
    eq(i.level, 2, 'level');
    eq(i.recent, true, 'from recent rate');
    eq(Math.round((i.outMs - NOW) / MIN), 30, 'minutes to run-out');
});

test('10 heavy Thu–Fri, 40% by Saturday → amber (not red), frozen over the weekend', () => {
    const sat = GLib.DateTime.new_local(2026, 10, 31, 12, 0, 0).to_unix() * 1000;
    const thuReset = GLib.DateTime.new_local(2026, 11, 5, 13, 30, 0).to_unix() * 1000;
    const data = {seven_day: {utilization: 40, resets_at: iso(thuReset)}};
    const a = byKey(summarise(data, settings(), sat), 'seven_day');
    eq(a.reason, 'heading', 'reason');
    const sun = byKey(summarise(data, settings(), sat + DAY), 'seven_day');
    eq(Math.round(sun.pace), Math.round(a.pace), 'pace unchanged on Sunday');
});

test('11 week 99% resets in 2 h → red (almost gone)', () => {
    eq(byKey(summarise({seven_day: lim(99, 2 * HOUR)}, settings(), NOW), 'seven_day').reason, 'almost', 'reason');
});

test('14 session 2 min in at 20% → amber: run-out projected ~2 h away, not imminent', () => {
    eq(byKey(summarise({five_hour: lim(20, 5 * HOUR - 2 * MIN)}, settings(), NOW), 'five_hour').reason, 'heading', 'reason');
});

test('screenshot 2:28 PM: session 20% after 58 min → 102% pace, out 8 min early but ~4 h away → amber', () => {
    const i = byKey(summarise({five_hour: lim(20, 4 * HOUR + 2 * MIN)}, settings(), NOW), 'five_hour');
    eq(Math.round(i.pace), 103, 'pace');
    eq(i.reason, 'heading', 'reason');
});

test('same steady 102% pace in the last hour → red', () => {
    eq(byKey(summarise({five_hour: lim(85, 50 * MIN)}, settings(), NOW), 'five_hour').level, 2, 'level');
});

test('15 session 2 min in at 1% → green', () => {
    eq(byKey(summarise({five_hour: lim(1, 5 * HOUR - 2 * MIN)}, settings(), NOW), 'five_hour').level, 0, 'level');
});

test('16 week 5% in the first 6 h (calendar) → green', () => {
    const i = byKey(summarise({seven_day: lim(5, 7 * DAY - 6 * HOUR)}, settings({'pace-hours': 'all'}), NOW), 'seven_day');
    eq(Math.round(i.pace), 50, 'pace');
    eq(i.level, 0, 'level');
});

test('17 session 100%, resets in 10 min → red, countdown to reset', () => {
    const s = summarise({five_hour: lim(100, 10 * MIN)}, settings(), NOW);
    eq(s.top.reason, 'blocked', 'reason');
    eq(s.cd.kind, 'reset', 'kind');
    eq(s.cd.ms - NOW, 10 * MIN, 'ms');
});

test('18 70% used early, idle since → green', () => {
    const history = [{t: NOW - 25 * MIN, used: 70}, {t: NOW - 12 * MIN, used: 70}];
    eq(byKey(summarise({five_hour: lim(70, HOUR)}, settings(), NOW, history), 'five_hour').level, 0, 'level');
});

test('19 week reset passed mid-session → week 0%, session untouched', () => {
    const s = summarise({five_hour: lim(30, 2 * HOUR), seven_day: lim(80, -MIN)}, settings(), NOW);
    eq(byKey(s, 'seven_day').used, 0, 'week used');
    eq(byKey(s, 'five_hour').used, 30, 'session used');
});

test('day off removes that day from working time', () => {
    const tue = GLib.DateTime.new_local(2026, 10, 27, 0, 0, 0).to_unix() * 1000;
    eq(workMs(tue, tue + DAY, scheduleOf(settings())) / HOUR, 10, 'normal Tuesday');
    eq(workMs(tue, tue + DAY, scheduleOf(settings({'day-off': '2026-10-27'}))), 0, 'Tuesday off');
});

test('countdown-mode alert hides the session timer while green', () => {
    eq(summarise({five_hour: lim(11, HOUR)}, settings({'countdown-mode': 'alert'}), NOW).cd, null, 'cd');
});

test('live alert case: pill amber from the week, session timer stays green', () => {
    const s = summarise({five_hour: lim(15, 4 * HOUR + 10 * MIN), seven_day: lim(66, WEEK_RESET)}, settings(), NOW);
    eq(s.top.pillLevel, 1, 'pill');
    eq(s.cd.ms - NOW, 4 * HOUR + 10 * MIN, 'countdown = session reset');
    eq(s.cd.level, 0, 'countdown colour = session');
});

test('used-up Fable: countdown stays the green session timer', () => {
    const s = summarise({five_hour: lim(12, 3 * HOUR), seven_day: lim(40, 2 * DAY), seven_day_fable: lim(100, 2 * DAY)},
        settings({'pace-hours': 'all'}), NOW);
    eq(s.cd.level, 0, 'countdown level');
});

test('planLimits reads model limits from the nested list', () => {
    const p = planLimits({five_hour: {utilization: 5, resets_at: null},
        limits: [{kind: 'weekly_scoped', percent: 42, resets_at: 'x', scope: {model: {display_name: 'Fable'}}}]});
    eq(p.seven_day_fable.utilization, 42, 'fable');
    eq(Object.keys(p).join(), 'five_hour,seven_day_fable', 'keys');
});

test('run-out skips the weekend and a day off', () => {
    const sat = GLib.DateTime.new_local(2026, 10, 31, 12, 0, 0).to_unix() * 1000;
    const thuReset = GLib.DateTime.new_local(2026, 11, 5, 13, 30, 0).to_unix() * 1000;
    const data = {seven_day: {utilization: 40, resets_at: iso(thuReset)}};
    const when = o => GLib.DateTime.new_from_unix_local(Math.floor(byKey(summarise(data, settings(o), sat), 'seven_day').outMs / 1000)).format('%a %H:%M');
    eq(when({}), 'Wed 12:15', 'normal week');
    eq(when({'day-off': '2026-11-02'}), 'Thu 12:15', 'Monday off');
});

// Week window Thu 22 Oct 13:30 → Mon 2 Nov 09:00 is not real; use a window that resets Monday 09:00
const FRI_EVE = GLib.DateTime.new_local(2026, 10, 30, 18, 0, 0).to_unix() * 1000;
const MON_9 = GLib.DateTime.new_local(2026, 11, 2, 9, 0, 0).to_unix() * 1000;

test('week 99% at Fri 18:00, resets Mon 09:00 → not red over the weekend (no working time left)', () => {
    const sat = FRI_EVE + 18 * HOUR;
    const i = byKey(summarise({seven_day: {utilization: 99, resets_at: iso(MON_9)}}, settings(), sat), 'seven_day');
    eq(i.level, 0, 'level');
    eq(i.reason, 'off', 'reason');
    const s = summarise({five_hour: lim(0, null, sat), seven_day: {utilization: 99, resets_at: iso(MON_9)}}, settings(), sat);
    eq(s.text, '0% · W 99%', 'still visible in the bar');
    eq(s.parts[1].level, 1, 'amber text');
    eq(s.top.pillLevel, 0, 'icon green');
});

test('session hovering at the 1 h boundary stays red once red (no flapping)', () => {
    // 75% after 3 h 40 m, steady: out in ~73 min — just over an hour
    const data = {five_hour: lim(75, 80 * MIN)};
    eq(byKey(summarise(data, settings(), NOW), 'five_hour').level, 1, 'fresh: amber');
    eq(byKey(summarise(data, settings(), NOW, [], new Set(['five_hour'])), 'five_hour').level, 2, 'was red: stays red');
});

test('used-up Fable with amber cap does not take the countdown from the session', () => {
    const s = summarise({five_hour: lim(12, 3 * HOUR), seven_day: lim(40, 2 * DAY), seven_day_fable: lim(100, 3 * DAY)},
        settings({'pace-hours': 'all'}), NOW);
    eq(s.cd.ms - NOW, 3 * HOUR, 'countdown = session reset');
});

test('week 85% by Fri 18:00 (Thu reset): on Sunday the run-out is ~2.5 working hours into Monday → red', () => {
    const thuReset = GLib.DateTime.new_local(2026, 11, 5, 13, 30, 0).to_unix() * 1000;
    const sun = FRI_EVE + 42 * HOUR;
    const i = byKey(summarise({seven_day: {utilization: 85, resets_at: iso(thuReset)}}, settings(), sun), 'seven_day');
    eq(i.level, 2, 'level');
});

print(failed ? `\n${failed} failed` : '\nall passed');
System.exit(failed ? 1 : 0);
