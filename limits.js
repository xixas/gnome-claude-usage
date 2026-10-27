// Shared by extension.js (top bar) and prefs.js (settings window + its preview),
// so both render the bar the same way. No shell imports here.

import GLib from 'gi://GLib';

export const LEVELS = ['claude-usage-ok', 'claude-usage-warn', 'claude-usage-hot'];
// Same colours as stylesheet.css, for Pango markup in the bar label and the GTK preview
export const COLOURS = ['#8ff0a4', '#f6d32d', '#ff7b63'];

const NAMES = {
    five_hour: 'Session',
    seven_day: 'Week',
};

const SUBTITLES = {
    five_hour: '5-hour window',
    seven_day: 'All models',
};

export function nameFor(key) {
    if (NAMES[key])
        return NAMES[key];
    const model = key.replace(/^seven_day_/, '').replace(/_/g, ' ');
    return model.charAt(0).toUpperCase() + model.slice(1);
}

export function subtitleFor(key) {
    return SUBTITLES[key] ?? 'Weekly, model-specific';
}

export function shortFor(key) {
    return nameFor(key).charAt(0);
}

// How the limit reads inside a sentence: "the session reset", "the Fable weekly limit"
export function phraseFor(key) {
    if (key === 'five_hour')
        return 'session';
    if (key === 'seven_day')
        return 'week';
    return `${nameFor(key)} weekly`;
}

const MIN = 60e3;
const HOUR = 60 * MIN;
const SESSION = 'five_hour';
const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function windowMs(key) {
    return key === SESSION ? 5 * HOUR : 7 * 24 * HOUR;
}

// Model-scoped weekly limits (Fable…) block only that model, and the API doesn't say which one is in use
function isModel(key) {
    return key !== SESSION && key !== 'seven_day';
}

// Only the plan limits: drops extra_usage, seven_day_oauth_apps and anything without a utilization
function isPlanLimit(key, value) {
    return /^(five_hour|seven_day\w*)$/.test(key) && key !== 'seven_day_oauth_apps' &&
        typeof value?.utilization === 'number';
}

// The plan limits as {key: {utilization, resets_at}}. Model-scoped weekly limits (e.g. Fable) come
// only in the nested `limits` list: {kind: 'weekly_scoped', percent, resets_at, scope: {model: {display_name}}}.
export function planLimits(data) {
    const out = Object.fromEntries(Object.entries(data ?? {}).filter(([k, v]) => isPlanLimit(k, v)));
    for (const entry of Array.isArray(data?.limits) ? data.limits : []) {
        const model = entry?.scope?.model?.display_name;
        if (entry?.kind !== 'weekly_scoped' || typeof model !== 'string' || typeof entry.percent !== 'number')
            continue;
        const key = `seven_day_${model.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
        out[key] ??= {utilization: entry.percent, resets_at: entry.resets_at ?? null};
    }
    return out;
}

export function planLimitKeys(data) {
    return Object.keys(planLimits(data));
}

export function durText(ms) {
    const mins = Math.max(0, Math.round(ms / 60e3));
    const h = Math.floor(mins / 60), d = Math.floor(h / 24);
    return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

export function clockText(ms) {
    const when = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const sameDay = when.get_year() === now.get_year() && when.get_day_of_year() === now.get_day_of_year();
    return when.format(sameDay ? '%-I:%M %p' : '%a %-I:%M %p');
}

// ---- Working hours: weekly pace counts only these, so nights and weekends don't dilute it ----

// {days: Set of 1–7 (ISO, Mon = 1), start, end (hours)} or null for calendar time
export function scheduleOf(settings) {
    if (settings.get_string('pace-hours') !== 'work')
        return null;
    const days = new Set(settings.get_strv('work-days').map(d => DAY_NAMES.indexOf(d) + 1).filter(d => d > 0));
    const start = settings.get_int('work-start'), end = settings.get_int('work-end');
    if (!days.size || end <= start)
        return null;
    return {days, start, end};
}

function midnight(ms) {
    const t = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    return GLib.DateTime.new_local(t.get_year(), t.get_month(), t.get_day_of_month(), 0, 0, 0);
}

// Each working stretch [from, to) in ms that overlaps [fromMs, toMs), in order
function* workSpans(fromMs, toMs, sched) {
    for (let day = midnight(fromMs); day.to_unix() * 1000 < toMs; day = day.add_days(1)) {
        if (!sched.days.has(day.get_day_of_week()))
            continue;
        const s = Math.max(day.add_hours(sched.start).to_unix() * 1000, fromMs);
        const e = Math.min(day.add_hours(sched.end).to_unix() * 1000, toMs);
        if (e > s)
            yield [s, e];
    }
}

export function workMs(fromMs, toMs, sched) {
    if (!sched)
        return Math.max(0, toMs - fromMs);
    let total = 0;
    for (const [s, e] of workSpans(fromMs, toMs, sched))
        total += e - s;
    return total;
}

// The wall-clock moment `amount` of working time after fromMs, or null if that falls at or after limitMs
function advance(fromMs, amount, limitMs, sched) {
    if (!sched)
        return fromMs + amount < limitMs ? fromMs + amount : null;
    for (const [s, e] of workSpans(fromMs, limitMs, sched)) {
        if (e - s > amount)
            return s + amount;
        amount -= e - s;
    }
    return null;
}

// ---- Per-limit verdict ----

// %/ms over the last 30 minutes of session samples [{t, used}], ignoring anything before a reset (a drop)
function recentRate(history, used, nowMs) {
    let recent = (history ?? []).filter(s => nowMs - s.t <= 30 * MIN);
    const drop = recent.findLastIndex((s, i) => i > 0 && s.used < recent[i - 1].used);
    if (drop > 0)
        recent = recent.slice(drop);
    const first = recent[0];
    if (!first || nowMs - first.t < 10 * MIN || used <= first.used)
        return 0;
    return (used - first.used) / (nowMs - first.t);
}

// One limit: % used, reset, projected % at reset (pace), when it runs out before the reset (outMs),
// level (0 green · 1 amber · 2 red), pillLevel (what it may do to the whole indicator) and why (reason).
// Pace and run-out are worked out as of opts.asOf, when `used` was measured, so they hold still between
// fetches; nowMs only decides whether a reset has passed and how close things are.
function analyse(key, value, nowMs, opts) {
    const asOf = Math.min(opts.asOf ?? nowMs, nowMs);
    const used = value.utilization;
    const info = {key, used, pct: Math.round(used), resetMs: null, pace: null, outMs: null,
        level: 0, pillLevel: 0, reason: 'fine', stale: false, recent: false};
    const reset = value.resets_at ? GLib.DateTime.new_from_iso8601(value.resets_at, null) : null;
    if (reset)
        info.resetMs = reset.to_unix() * 1000;

    if (info.resetMs !== null && info.resetMs <= nowMs) {
        // The window rolled over since the last fetch: it's empty now, whatever the old number said
        Object.assign(info, {used: 0, pct: 0, stale: true, reason: 'reset', resetMs: null});
        return info;
    }

    if (info.resetMs !== null) {
        const window = windowMs(key);
        let sched = key === SESSION ? null : opts.schedule;
        const start = info.resetMs - window;
        let total = workMs(start, info.resetMs, sched);
        if (sched && total <= 0) {
            sched = null;
            total = window;
        }
        // Floored at 10% of the window, so an early burst projects cautiously instead of not at all
        const elapsed = Math.max(workMs(start, asOf, sched), total * 0.1);
        info.pace = used * total / elapsed;
        if (used > 0 && used < 100)
            info.outMs = advance(asOf, (100 - used) * elapsed / used, info.resetMs, sched);
        if (key === SESSION && used < 100) {
            const rate = recentRate(opts.history, used, asOf);
            const out = rate > 0 ? asOf + (100 - used) / rate : null;
            if (out !== null && out < info.resetMs && (info.outMs === null || out < info.outMs))
                Object.assign(info, {outMs: out, recent: true});
        }
    }

    // Weekly limits measure time in working hours: with none left before the reset there's nothing to act on
    const sched = key === SESSION ? null : opts.schedule;
    const left = info.resetMs === null ? Infinity : workMs(nowMs, info.resetMs, sched);
    // "Close" = within an hour for the session, a working day for weekly limits; a quarter more once red, so it doesn't flap
    const soon = (key === SESSION ? HOUR : sched ? (sched.end - sched.start) * HOUR : 24 * HOUR) *
        (opts.wasRed?.has(key) ? 1.25 : 1);
    if (used >= 100)
        Object.assign(info, {level: 2, reason: 'blocked'});
    else if (left === 0)
        Object.assign(info, {reason: 'off'});
    else if (100 - used <= 2 && left > 30 * MIN)
        Object.assign(info, {level: 2, reason: 'almost'});
    // Red only when the run-out is close (or nearly everything is used): a slight overshoot hours away is amber
    // The run-out projected at the last fetch has already passed: it may be used up by now — refetch to know
    else if (info.outMs !== null && info.outMs <= nowMs)
        Object.assign(info, {level: 2, reason: 'lapsed'});
    else if (info.outMs !== null && (workMs(nowMs, info.outMs, sched) <= soon || used >= 90))
        Object.assign(info, {level: 2, reason: 'out'});
    else if (info.outMs !== null)
        Object.assign(info, {level: 1, reason: 'heading'});
    else if (info.pace !== null && info.pace >= opts.amberAt)
        Object.assign(info, {level: 1, reason: 'close'});
    info.pillLevel = isModel(key) && !opts.modelRed ? Math.min(info.level, 1) : info.level;
    return info;
}

// When a red limit stops you: now if it's used up, else when it runs out
function blockAt(info, nowMs) {
    return info.reason === 'out' ? info.outMs : nowMs;
}

// Everything the top bar needs from one API response + the current settings:
// limits (all, session → week → models, for the menu), top (the limit that sets the colour and verdict),
// parts ([{text, level}] for the bar label), text (plain label), cd ({kind: 'reset' | 'out', ms, level} or null,
// coloured by the limit it counts down for)
// and refetch (a window rolled over, or a run-out passed, since the fetch). history: recent session samples [{t, used}];
// wasRed: keys that were red last time (they stay red a little longer, so the colour doesn't flap);
// asOf: when `data` was fetched (pace and run-out are judged at that moment).
export function summarise(data, settings, now = Date.now(), history = [], wasRed = new Set(), asOf = now) {
    const opts = {
        schedule: scheduleOf(settings),
        amberAt: settings.get_int('amber-at'),
        modelRed: settings.get_string('model-colour') === 'red',
        history,
        wasRed,
        asOf,
    };
    const rank = k => (k === SESSION ? 0 : k === 'seven_day' ? 1 : 2);
    const limits = Object.entries(planLimits(data))
        .map(([k, v]) => analyse(k, v, now, opts))
        .sort((a, b) => rank(a.key) - rank(b.key));

    // A nearly used-up weekly limit with no working time left stays visible (amber text, icon green):
    // you can't act on it at work, but weekend use would hit it
    const offWatch = i => i.reason === 'off' && i.used >= 90;

    // Worst pill level wins; among equals the one that stops you first, then session → week → models.
    // With everything green, an offWatch limit sets the verdict, so it matches the amber number in the bar.
    const top = limits.reduce((a, b) => {
        if (b.pillLevel !== a.pillLevel)
            return b.pillLevel > a.pillLevel ? b : a;
        if (b.pillLevel === 0 && offWatch(b) && !offWatch(a))
            return b;
        return a.level === 2 && b.level === 2 && blockAt(b, now) < blockAt(a, now) ? b : a;
    }, limits[0]) ?? null;

    const left = settings.get_string('number-mode') === 'left';
    const num = i => `${left ? 100 - i.pct : i.pct}%`;
    const always = settings.get_string('show-limits') === 'always';
    const parts = limits
        .filter(i => i.key === SESSION || always || i.level > 0 || offWatch(i))
        .map(i => ({
            text: `${i.key === SESSION ? '' : `${shortFor(i.key)} `}${num(i)}${i.stale ? ' ↻' : ''}`,
            level: offWatch(i) ? 1 : i.level,
        }));

    // Countdown: the red limit that stops you first, otherwise the session's reset
    const reds = limits.filter(i => i.pillLevel === 2).sort((a, b) => blockAt(a, now) - blockAt(b, now));
    const session = limits.find(i => i.key === SESSION);
    const mode = settings.get_string('countdown-mode');
    let cd = null;
    if (mode !== 'never' && (mode === 'always' || (top?.pillLevel ?? 0) > 0)) {
        const target = reds[0] ?? session;
        if (target?.reason === 'out')
            cd = {kind: 'out', ms: target.outMs, level: target.pillLevel};
        else if (target?.resetMs != null)
            cd = {kind: 'reset', ms: target.resetMs, level: target.pillLevel};
    }
    // refetch: a window rolled over, or a projected run-out has passed, since the numbers were fetched
    return {limits, top, parts, text: parts.map(p => p.text).join(' · '), cd,
        refetch: limits.some(i => i.stale || i.reason === 'lapsed')};
}

// The bar label as Pango markup, each number in its own colour
export function labelMarkup(parts, colour) {
    return parts.map(p => {
        const text = GLib.markup_escape_text(p.text, -1);
        return colour ? `<span foreground="${COLOURS[p.level]}">${text}</span>` : text;
    }).join(' · ');
}

export function countdownText(cd, settings) {
    return settings.get_string('time-style') === 'clock'
        ? clockText(cd.ms)
        : durText(cd.ms - Date.now()).replace(' ', '');
}
