// Claude Usage — shows Claude plan limits in the GNOME top bar.
// Data: the same endpoint Claude Code's /usage uses, authenticated with the
// OAuth token Claude Code keeps in ~/.claude/.credentials.json (read at runtime,
// never copied anywhere). Claude Code refreshes that token while you use it.

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

import {LEVELS, nameFor, phraseFor, durText, clockText, summarise, countdownText, planLimitKeys} from './limits.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const OFF = 'claude-usage-off';

function bar(pct) {
    const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
    return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Claude Usage');
        this._settings = ext.getSettings();
        this._data = null;
        this._cd = null;

        const icons = ext.dir.get_child('icons');
        this._claudeIcon = Gio.FileIcon.new(icons.get_child('claude-symbolic.svg'));
        this._cdIcons = {
            reset: new Gio.ThemedIcon({name: 'alarm-symbolic'}),
            out: Gio.FileIcon.new(icons.get_child('hourglass-symbolic.svg')),
        };
        this._warnIcon = new Gio.ThemedIcon({name: 'dialog-warning-symbolic'});

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({gicon: this._claudeIcon, style_class: 'system-status-icon'});
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        // Countdown: ⏱ time to reset, or ⌛ time until you run out when red
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

        this._verdict = new PopupMenu.PopupBaseMenuItem({reactive: false, visible: false});
        const vbox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._verdictTitle = new St.Label({style_class: 'claude-usage-verdict'});
        this._verdictText = new St.Label({style_class: 'claude-usage-reset'});
        this._verdictText.clutter_text.line_wrap = true;
        vbox.add_child(this._verdictTitle);
        vbox.add_child(this._verdictText);
        this._verdict.add_child(vbox);
        this.menu.addMenuItem(this._verdict);

        this._rows = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._rows);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._status);
        this.menu.addAction('Refresh now', () => this._refresh());
        this.menu.addAction('Settings…', () => ext.openPreferences());

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-minutes')
                this._startTimer();
            else if (key !== 'last-usage' && this._data)
                this._render();
        });

        this._refresh();
        this._startTimer();
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updateCountdown();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _startTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-minutes') * 60, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _readToken() {
        const [, bytes] = Gio.File.new_for_path(CREDS_PATH).load_contents(null);
        const oauth = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth;
        if (!oauth?.accessToken)
            throw new Error('Not logged in to Claude Code');
        if (oauth.expiresAt && oauth.expiresAt < Date.now())
            throw new Error('Token expired — open Claude Code to refresh it');
        return oauth.accessToken;
    }

    async _refresh() {
        try {
            const msg = Soup.Message.new('GET', USAGE_URL);
            msg.request_headers.append('Authorization', `Bearer ${this._readToken()}`);
            msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
            msg.request_headers.append('Accept', 'application/json');

            const bytes = await this._session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, this._cancellable);
            const body = new TextDecoder().decode(bytes.get_data());
            if (msg.get_status() !== Soup.Status.OK)
                throw new Error(`HTTP ${msg.get_status()} ${body.slice(0, 120)}`);

            this._data = JSON.parse(body);
            this._fetchedAt = GLib.DateTime.new_now_local();
            // Plan-limit percentages and reset times only — lets the settings window list limits and draw its preview
            const plan = Object.fromEntries(planLimitKeys(this._data).map(k => [k, this._data[k]]));
            this._settings.set_string('last-usage', JSON.stringify(plan));
            this._render();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._data = null;
            this._icon.gicon = this._warnIcon;
            this._setLevel(null);
            this._cd = null;
            this._updateCountdown();
            this._label.text = '--';
            this._label.visible = true;
            this._verdict.visible = false;
            this._status.label.text = `⚠ ${e.message}`;
        }
    }

    _render() {
        const now = Date.now();
        const {limits, top, text, cd} = summarise(this._data, this._settings, now);

        // Menu: one row per limit, always
        this._rows.removeAll();
        for (const info of limits) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const line = new St.BoxLayout({style_class: 'claude-usage-row'});
            line.add_child(new St.Label({text: nameFor(info.key), style_class: 'claude-usage-name'}));
            line.add_child(new St.Label({text: bar(info.pct), style_class: `claude-usage-bar ${LEVELS[info.level]}`, x_expand: true}));
            line.add_child(new St.Label({text: `${info.pct}%`, style_class: 'claude-usage-pct'}));
            box.add_child(line);
            const parts = [];
            if (info.resetMs !== null)
                parts.push(`resets ${clockText(info.resetMs)}`, `in ${durText(info.resetMs - now)}`);
            if (info.pace !== null)
                parts.push(`pace ≈ ${Math.round(info.pace)}%`);
            box.add_child(new St.Label({text: parts.join(' · '), style_class: 'claude-usage-reset'}));
            item.add_child(box);
            this._rows.addMenuItem(item);
        }

        this._icon.gicon = this._claudeIcon;
        this._label.text = text;
        this._label.visible = text !== '';
        this._setLevel(top ? top.level : 0);
        this._cd = cd;
        this._updateCountdown();
        this._renderVerdict(top);
        this._status.label.text = `Updated ${this._fetchedAt.format('%-I:%M %p')}`;
    }

    _renderVerdict(top) {
        this._verdict.visible = !!top;
        if (!top)
            return;
        const what = phraseFor(top.key);
        const paced = this._settings.get_string('color-by') === 'pace' && top.pace !== null;
        let title, text;
        if (top.used >= 100) {
            title = 'Limit reached';
            text = top.resetMs !== null ? `The ${what} limit resets ${clockText(top.resetMs)}.` : '';
        } else if (paced && top.level === 2) {
            title = 'Running out';
            text = `At this pace the ${what} limit runs out around ${clockText(top.outMs)}, ` +
                `${durText(top.resetMs - top.outMs)} before it resets.`;
        } else if (paced && top.level === 1) {
            title = 'Cutting it close';
            text = `At this pace you'll end the ${what} around ${Math.round(top.pace)}%.`;
        } else if (paced) {
            title = 'On track';
            text = `You should reach the ${what} reset with room to spare.`;
        } else {
            title = ['Plenty left', 'Getting busy', 'Running low'][top.level];
            text = `${top.pct}% of the ${what} limit used.`;
        }
        this._verdictTitle.text = title;
        this._verdictText.text = text;
        LEVELS.forEach(c => this._verdictTitle.remove_style_class_name(c));
        this._verdictTitle.add_style_class_name(LEVELS[top.level]);
    }

    _updateCountdown() {
        const show = this._cd !== null;
        this._cdIcon.visible = this._cdLabel.visible = show;
        if (!show)
            return;
        this._cdIcon.gicon = this._cdIcons[this._cd.kind];
        this._cdLabel.text = countdownText(this._cd, this._settings);
    }

    // level: 0–2, or null for "no data" (grey)
    _setLevel(level) {
        const colour = this._settings.get_boolean('color-enabled');
        for (const actor of [this._icon, this._label, this._cdIcon, this._cdLabel]) {
            [...LEVELS, OFF].forEach(c => actor.remove_style_class_name(c));
            if (level === null)
                actor.add_style_class_name(OFF);
            else if (colour)
                actor.add_style_class_name(LEVELS[level]);
        }
    }

    destroy() {
        for (const id of [this._timer, this._tick]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timer = this._tick = null;
        this._settings.disconnect(this._settingsId);
        this._cancellable.cancel();
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
