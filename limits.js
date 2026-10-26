// Shared by extension.js (top bar) and prefs.js (settings window + its preview),
// so both render the bar the same way. No shell imports here.

import GLib from 'gi://GLib';

export const LEVELS = ['claude-usage-ok', 'claude-usage-warn', 'claude-usage-hot'];

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

function windowMs(key) {
    return key === 'five_hour' ? 5 * 3600e3 : 7 * 24 * 3600e3;
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

// One limit: % used, reset time, projected % at reset (pace) and when it runs out at this pace.
// Pace is left null in the first 10% of a window — too early to judge.
function analyse(key, value, nowMs) {
    const info = {key, used: value.utilization, pct: Math.round(value.utilization), resetMs: null, pace: null, outMs: null};
    const reset = value.resets_at ? GLib.DateTime.new_from_iso8601(value.resets_at, null) : null;
    if (!reset)
        return info;
    info.resetMs = reset.to_unix() * 1000;
    const window = windowMs(key);
    const elapsed = window - (info.resetMs - nowMs);
    if (elapsed < window * 0.1)
        return info;
    info.pace = info.used * window / elapsed;
    if (info.used >= 100)
        info.outMs = nowMs;
    else if (info.pace >= 100)
        info.outMs = nowMs + (100 - info.used) * elapsed / info.used;
    return info;
}

// 0 green, 1 amber, 2 red
function levelOf(info, settings) {
    if (settings.get_string('color-by') === 'pace' && info.pace !== null) {
        if (info.outMs !== null)
            return 2;
        return info.pace >= 90 ? 1 : 0;
    }
    if (info.pct >= settings.get_int('hot-at'))
        return 2;
    return info.pct >= settings.get_int('warn-at') ? 1 : 0;
}

// Everything the top bar needs from one API response + the current settings:
// limits (all, for the menu), top (the limit that sets colour / countdown / verdict),
// text (the bar label) and cd ({kind: 'reset' | 'out', ms} or null).
export function summarise(data, settings, now = Date.now()) {
    const limits = Object.entries(planLimits(data))
        .map(([k, v]) => {
            const info = analyse(k, v, now);
            info.level = levelOf(info, settings);
            return info;
        });

    // worst level first, then furthest along — by the same measure the colour uses
    const paced = settings.get_string('color-by') === 'pace';
    const score = i => i.level * 1000 + ((paced ? i.pace : null) ?? i.used);
    const top = limits.reduce((a, b) => (score(b) > score(a) ? b : a), limits[0]) ?? null;

    const shown = limits.filter(i => settings.get_strv('bar-limits').includes(i.key));
    const labels = settings.get_boolean('short-labels') || shown.length >= 3;
    const left = settings.get_string('number-mode') === 'left';
    const text = shown
        .map(i => `${labels ? `${shortFor(i.key)} ` : ''}${left ? 100 - i.pct : i.pct}%`)
        .join(' · ');

    const mode = settings.get_string('countdown-mode');
    let cd = null;
    if (top && (mode === 'always' || (mode === 'alert' && top.level > 0))) {
        if (top.level === 2 && top.outMs !== null && top.used < 100)
            cd = {kind: 'out', ms: top.outMs};
        else if (top.resetMs !== null)
            cd = {kind: 'reset', ms: top.resetMs};
    }
    return {limits, top, text, cd};
}

export function countdownText(cd, settings) {
    return settings.get_string('time-style') === 'clock'
        ? clockText(cd.ms)
        : durText(cd.ms - Date.now()).replace(' ', '');
}
