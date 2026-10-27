// Claude Usage — shows Claude plan limits in the GNOME top bar.
// Data: the same endpoint Claude Code's /usage uses, authenticated with the
// OAuth token Claude Code keeps in ~/.claude/.credentials.json (read at runtime,
// never copied anywhere). See auth.js for the optional automatic renewal.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {LEVELS, nameFor, phraseFor, durText, clockText, summarise, countdownText, labelMarkup, planLimits, planLimitKeys,
    scheduleOf} from './limits.js';
import {Auth, UsageError} from './auth.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OFF = 'claude-usage-off';
const MAX_BACKOFF_SECONDS = 3600;
const MENU_REFRESH_AFTER_MS = 60e3;
// Session samples kept for the recent-rate projection
const HISTORY_MS = 45 * 60e3;

// Shown in place of the spark (grey, last numbers kept) when a fetch fails
const PROBLEMS = {
    offline: {icon: 'network-offline-symbolic', title: 'No internet connection',
        text: 'Retrying as soon as you\'re back online.'},
    unreachable: {icon: 'network-error-symbolic', title: 'Can\'t reach Anthropic',
        text: 'api.anthropic.com didn\'t answer. Retrying at the next refresh.'},
    renewing: {icon: 'view-refresh-symbolic', title: 'Renewing sign-in'},
    auth: {icon: 'changes-prevent-symbolic', title: 'Sign in to Claude Code'},
    ratelimit: {icon: 'dialog-warning-symbolic', title: 'Slowed down by Anthropic'},
    server: {icon: 'dialog-warning-symbolic', title: 'Usage service problem'},
    old: {icon: 'document-open-recent-symbolic', title: 'Numbers may be out of date'},
};

function bar(pct) {
    const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
    return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Claude Usage');
        this._settings = ext.getSettings();
        this._auth = new Auth();
        this._data = null;
        this._problem = null;
        this._cd = null;
        this._backoff = 1;
        this._lastTry = 0;
        this._history = [];
        this._wasRed = new Set();

        const icons = ext.dir.get_child('icons');
        this._claudeIcon = Gio.FileIcon.new(icons.get_child('claude-symbolic.svg'));
        this._cdIcons = {
            reset: new Gio.ThemedIcon({name: 'alarm-symbolic'}),
            out: Gio.FileIcon.new(icons.get_child('hourglass-symbolic.svg')),
        };

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({gicon: this._claudeIcon, style_class: 'system-status-icon'});
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        // Countdown: ⏰ time to reset, or ⌛ time until you run out
        this._cdIcon = new St.Icon({style_class: 'claude-usage-cd-icon', visible: false});
        this._cdLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-cd',
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        box.add_child(this._cdIcon);
        box.add_child(this._cdLabel);
        this.add_child(box);

        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();

        // Verdict ("On track …") or, when something is wrong, the problem
        this._verdict = new PopupMenu.PopupBaseMenuItem({reactive: false});
        this._verdict.visible = false;
        const vbox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const titleRow = new St.BoxLayout({style_class: 'claude-usage-verdict-row'});
        this._verdictIcon = new St.Icon({style_class: 'claude-usage-verdict-icon', visible: false});
        this._verdictTitle = new St.Label({style_class: 'claude-usage-verdict', y_align: Clutter.ActorAlign.CENTER});
        titleRow.add_child(this._verdictIcon);
        titleRow.add_child(this._verdictTitle);
        this._verdictText = new St.Label({style_class: 'claude-usage-reset'});
        this._verdictText.clutter_text.line_wrap = true;
        vbox.add_child(titleRow);
        vbox.add_child(this._verdictText);
        this._verdict.add_child(vbox);
        this.menu.addMenuItem(this._verdict);

        this._rows = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._rows);
        this._rowWidgets = new Map();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._status);
        this._signIn = this.menu.addAction('Sign in…', () => {
            if (this._auth.signIn())
                this._schedule(60);
        });
        this.menu.addAction('Refresh now', () => this._refresh());
        // Rejects with "Already showing a prefs dialog" when it's open already; nothing to do then
        this.menu.addAction('Settings…', () => ext.openPreferences()?.catch?.(() => {}));

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open && this._problem?.kind !== 'ratelimit' && Date.now() - this._lastTry > MENU_REFRESH_AFTER_MS)
                this._refresh();
        });

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-minutes')
                this._schedule(this._interval());
            else if (key !== 'last-usage')
                this._render();
        });

        this._monitor = Gio.NetworkMonitor.get_default();
        this._networkId = this._monitor.connect('network-changed', (_m, available) => {
            if (available && ['offline', 'unreachable'].includes(this._problem?.kind))
                this._refresh();
        });

        this._render();
        this._refresh();
        // Re-judge every minute: countdowns move, "soon" gets closer, and a window may roll over between fetches
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _interval() {
        return this._settings.get_int('refresh-minutes') * 60;
    }

    _schedule(seconds) {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timer = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _fetch() {
        const token = await this._auth.token(this._settings.get_boolean('auto-renew'), () => {
            this._problem = new UsageError('renewing', 'Asking Claude Code to renew your login…');
            this._render();
        });
        const msg = Soup.Message.new('GET', USAGE_URL);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        msg.request_headers.append('Accept', 'application/json');

        let bytes;
        try {
            bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new UsageError(this._monitor.network_available ? 'unreachable' : 'offline', e.message);
        }

        const status = msg.get_status();
        const body = new TextDecoder().decode(bytes.get_data());
        if (status === 401 || status === 403)
            throw new UsageError('auth', `Claude rejected the login (HTTP ${status}).`);
        if (status === 429) {
            const retryAfter = parseInt(msg.response_headers.get_one('Retry-After') ?? '', 10);
            throw new UsageError('ratelimit', 'Too many requests (HTTP 429).', retryAfter > 0 ? retryAfter : null);
        }
        if (status !== Soup.Status.OK)
            throw new UsageError('server', `HTTP ${status} ${body.slice(0, 120)}`);

        let data;
        try {
            data = JSON.parse(body);
        } catch {
            data = null;
        }
        if (!planLimitKeys(data).length)
            throw new UsageError('server', 'Unexpected response — the unofficial usage endpoint may have changed.');
        return data;
    }

    async _refresh() {
        if (this._busy)
            return;
        this._busy = true;
        this._lastTry = Date.now();
        let next = this._interval();
        try {
            this._data = await this._fetch();
            this._fetchedAt = GLib.DateTime.new_now_local();
            const used = planLimits(this._data).five_hour?.utilization;
            if (typeof used === 'number')
                this._history = [...this._history.filter(h => Date.now() - h.t < HISTORY_MS), {t: Date.now(), used}];
            this._backoff = 1;
            this._problem = null;
            // Plan-limit percentages and reset times only — lets the settings window list limits and draw its preview
            this._settings.set_string('last-usage', JSON.stringify({...planLimits(this._data), _at: Date.now()}));
            this._render();
        } catch (e) {
            if (this._cancellable.is_cancelled() || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            const err = e instanceof UsageError ? e : new UsageError('server', e.message);
            if (err.kind === 'ratelimit') {
                this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_SECONDS / next);
                next = Math.min(err.retryAfter ?? next * this._backoff, MAX_BACKOFF_SECONDS);
            } else if (err.kind === 'renewing') {
                next = 60;
            }
            err.retryAt = Date.now() + next * 1000;
            this._problem = err;
            this._render();
        } finally {
            this._busy = false;
            if (!this._cancellable.is_cancelled())
                this._schedule(next);
        }
    }

    _render() {
        const now = Date.now();
        // A 429 with numbers in hand isn't worth alarming about; everything else greys the bar
        let problem = this._problem && !(this._problem.kind === 'ratelimit' && this._data) ? this._problem : null;
        if (!problem && this._fetchedAt && now - this._fetchedAt.to_unix() * 1000 > 3 * this._interval() * 1000)
            problem = {kind: 'old', message: `These numbers are from ${this._fetchedAt.format('%-I:%M %p')}.`};
        const fetchedMs = this._fetchedAt ? this._fetchedAt.to_unix() * 1000 : now;
        const summary = this._data
            ? summarise(this._data, this._settings, now, this._history, this._wasRed, fetchedMs) : null;
        this._wasRed = new Set(summary?.limits.filter(i => i.level === 2).map(i => i.key));
        // A window rolled over since the last fetch: fetch now rather than wait for the timer —
        // once per fetched result, at most once a minute, never while Anthropic has asked us to back off
        if (summary?.refetch && this._staleTried !== this._fetchedAt && !this._busy &&
            now - this._lastTry > MENU_REFRESH_AFTER_MS && this._problem?.kind !== 'ratelimit') {
            this._staleTried = this._fetchedAt;
            this._refresh();
        }
        const schedule = scheduleOf(this._settings);

        // Rows are built once per set of limits and updated in place, so an open menu doesn't flicker
        const limits = summary?.limits ?? [];
        if (limits.map(i => i.key).join() !== [...this._rowWidgets.keys()].join()) {
            this._rows.removeAll();
            this._rowWidgets.clear();
            for (const info of limits)
                this._rowWidgets.set(info.key, this._addRow(info.key));
        }
        const left = this._settings.get_string('number-mode') === 'left';
        for (const info of limits) {
            const row = this._rowWidgets.get(info.key);
            row.bar.text = bar(info.pct);
            LEVELS.forEach(c => row.bar.remove_style_class_name(c));
            if (!problem)
                row.bar.add_style_class_name(LEVELS[info.level]);
            row.pct.text = left ? `${100 - info.pct}% left` : `${info.pct}%`;
            const parts = [];
            if (info.stale)
                parts.push('just reset · refreshing');
            if (info.resetMs !== null)
                parts.push(`resets ${clockText(info.resetMs)}`, `in ${durText(info.resetMs - now)}`);
            if (info.pace !== null && !problem)
                parts.push(`pace ≈ ${Math.round(info.pace)}%${schedule && info.key !== 'five_hour' ? ' (work hours)' : ''}`);
            row.sub.text = parts.join(' · ');
            row.item.opacity = problem ? 128 : 255;
        }

        this._icon.gicon = problem ? new Gio.ThemedIcon({name: PROBLEMS[problem.kind].icon}) : this._claudeIcon;
        if (summary)
            this._label.clutter_text.set_markup(labelMarkup(summary.parts, !problem && this._settings.get_boolean('color-enabled')));
        else
            this._label.text = this._problem ? '--' : '…';
        this._label.visible = !summary || summary.text !== '';
        this._cd = problem ? null : summary?.cd ?? null;
        this._setLevel(problem || !summary ? null : summary.top?.pillLevel ?? 0, this._cd?.level ?? 0);
        this._updateCountdown();

        if (problem)
            this._showVerdict(PROBLEMS[problem.kind].title, PROBLEMS[problem.kind].text ?? problem.message,
                null, PROBLEMS[problem.kind].icon);
        else if (summary?.top)
            this._renderVerdict(summary.top);
        else
            this._verdict.visible = false;

        let status = this._fetchedAt ? `${problem ? 'Last updated' : 'Updated'} ${this._fetchedAt.format('%-I:%M %p')}` : 'No data yet';
        if (this._problem?.kind === 'ratelimit')
            status += ` · next try ${clockText(this._problem.retryAt)}`;
        this._status.label.text = status;
        this._signIn.visible = problem?.kind === 'auth';
    }

    _addRow(key) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const line = new St.BoxLayout({style_class: 'claude-usage-row'});
        const barLabel = new St.Label({style_class: 'claude-usage-bar', x_expand: true});
        const pct = new St.Label({style_class: 'claude-usage-pct'});
        line.add_child(new St.Label({text: nameFor(key), style_class: 'claude-usage-name'}));
        line.add_child(barLabel);
        line.add_child(pct);
        const sub = new St.Label({style_class: 'claude-usage-reset'});
        box.add_child(line);
        box.add_child(sub);
        item.add_child(box);
        this._rows.addMenuItem(item);
        return {item, bar: barLabel, pct, sub};
    }

    _showVerdict(title, text, level, iconName = null) {
        this._verdict.visible = true;
        this._verdictTitle.text = title;
        this._verdictText.text = text;
        this._verdictIcon.visible = iconName !== null;
        if (iconName)
            this._verdictIcon.icon_name = iconName;
        LEVELS.forEach(c => this._verdictTitle.remove_style_class_name(c));
        if (level !== null)
            this._verdictTitle.add_style_class_name(LEVELS[level]);
    }

    _renderVerdict(top) {
        const what = phraseFor(top.key);
        const back = top.resetMs !== null ? ` It resets ${clockText(top.resetMs)}.` : '';
        // While Anthropic has asked us to back off, say when the next check is instead of "now"
        const check = this._problem?.kind === 'ratelimit' ? `Next check ${clockText(this._problem.retryAt)}.` : 'Checking now.';
        const [title, text] = {
            blocked: ['Limit reached', `The ${what} limit is used up.${back}`],
            almost: ['Almost used up', `${100 - top.pct}% of the ${what} limit left.${back}`],
            out: ['Running out', `At ${top.recent ? 'your rate over the last half hour' : 'this pace'} the ${what} limit ` +
                `runs out around ${clockText(top.outMs)}, ${durText(top.resetMs - top.outMs)} before it resets.`],
            heading: ['Heading for the limit', `At this pace the ${what} limit runs out around ${clockText(top.outMs)}, ` +
                `before it resets ${clockText(top.resetMs)}.`],
            close: ['Cutting it close', `At this pace the ${what} limit ends its window at about ${Math.round(top.pace)}%.`],
            lapsed: ['May have run out', `At the last reading the ${what} limit was due to run out around ` +
                `${clockText(top.outMs)}. ${check}`],
            reset: ['Just reset', `The ${what} window rolled over. ${check}`],
            off: ['Nothing to do', `${top.pct}% of the ${what} limit used, and no working hours left before it resets ` +
                `${clockText(top.resetMs)}.`],
            fine: ['On track', top.pace !== null ? `You should reach the ${what} reset with room to spare.` : 'Nothing is close to a limit.'],
        }[top.reason];
        this._showVerdict(title, text, top.pillLevel);
    }

    _updateCountdown() {
        const show = this._cd !== null;
        this._cdIcon.visible = this._cdLabel.visible = show;
        if (!show)
            return;
        this._cdIcon.gicon = this._cdIcons[this._cd.kind];
        this._cdLabel.text = countdownText(this._cd, this._settings);
    }

    // level: 0–2, or null for "not live" (grey); the countdown takes the level of the limit it counts down for
    _setLevel(level, cdLevel) {
        const colour = this._settings.get_boolean('color-enabled');
        for (const actor of [this._icon, this._label, this._cdIcon, this._cdLabel]) {
            [...LEVELS, OFF].forEach(c => actor.remove_style_class_name(c));
            const own = actor === this._cdIcon || actor === this._cdLabel ? cdLevel : level;
            if (level === null)
                actor.add_style_class_name(OFF);
            // The label colours each number itself (labelMarkup); a class colour would override that
            else if (colour && actor !== this._label)
                actor.add_style_class_name(LEVELS[own]);
        }
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of [this._timer, this._tick]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timer = this._tick = 0;
        this._settings.disconnect(this._settingsId);
        this._monitor.disconnect(this._networkId);
        this._auth.destroy();
        this._session.abort();
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new UsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
