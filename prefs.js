import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LEVELS, summarise, countdownText, labelMarkup} from './limits.js';

// Same colours as stylesheet.css, for the GTK preview
const PREVIEW_CSS = `
.claude-usage-panel { background: #000; color: #fff; border-radius: 9px; padding: 7px 12px; font-weight: bold; }
.claude-usage-ok { color: #8ff0a4; }
.claude-usage-warn { color: #f6d32d; }
.claude-usage-hot { color: #ff7b63; }
`;

// Shown until the extension has fetched real numbers once
function sampleUsage() {
    const inMs = ms => GLib.DateTime.new_from_unix_utc(Math.floor((Date.now() + ms) / 1000)).format_iso8601();
    return {
        five_hour: {utilization: 9, resets_at: inMs(110 * 60e3)},
        seven_day: {utilization: 41, resets_at: inMs(26 * 3600e3)},
    };
}

// A dropdown row bound to a string key with fixed choices: [[value, label], …]
function choiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices.map(c => c[1]))});
    row.selected = Math.max(0, choices.findIndex(c => c[0] === settings.get_string(key)));
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.set({title, subtitle});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class ClaudeUsagePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const lastUsage = () => {
            try {
                return JSON.parse(settings.get_string('last-usage'));
            } catch {
                return null;
            }
        };
        const page = new Adw.PreferencesPage();
        window.add(page);
        window.set_default_size(560, 820);

        page.add(this._previewGroup(settings, lastUsage, window));

        const pace = new Adw.PreferencesGroup({
            title: 'Pace',
            description: 'The session always shows. Week and model limits join it in the bar only when amber or red.',
        });
        page.add(pace);
        pace.add(choiceRow(settings, 'pace-hours', 'Weekly pace counts',
            'Working hours: nights, weekends and days off don\'t dilute your rate',
            [['work', 'Working hours'], ['all', 'All hours']]));
        const days = new Adw.ExpanderRow({title: 'Working days'});
        for (const [day, name] of [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
            ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']]) {
            const row = new Adw.SwitchRow({title: name, active: settings.get_strv('work-days').includes(day)});
            row.connect('notify::active', () => {
                const rest = settings.get_strv('work-days').filter(d => d !== day);
                settings.set_strv('work-days', row.active ? [...rest, day] : rest);
            });
            days.add_row(row);
        }
        pace.add(days);
        pace.add(spinRow(settings, 'work-start', 'Work starts (hour)', '9 = 9 AM', 0, 23));
        pace.add(spinRow(settings, 'work-end', 'Work ends (hour)', '19 = 7 PM', 1, 24));
        pace.add(spinRow(settings, 'amber-at', 'Amber from (projected %)',
            'Amber when a limit is on course to end its window at or above this', 50, 100));
        pace.add(choiceRow(settings, 'model-colour', 'Used-up model limit (e.g. Fable)',
            'The usage data doesn\'t say which model you\'re using, so by default it only turns the bar amber',
            [['amber', 'Amber'], ['red', 'Red']]));

        const display = new Adw.PreferencesGroup({title: 'Display'});
        page.add(display);
        display.add(choiceRow(settings, 'number-mode', 'Numbers show', 'Used: 9% · Left: 91%',
            [['used', 'Used'], ['left', 'Left']]));
        display.add(switchRow(settings, 'color-enabled', 'Colour coding',
            'Off = plain panel colour, like other icons'));

        const countdown = new Adw.PreferencesGroup({title: 'Countdown'});
        page.add(countdown);
        countdown.add(choiceRow(settings, 'countdown-mode', 'Show countdown', 'The session reset, or the red limit that stops you first',
            [['never', 'Never'], ['alert', 'When amber or red'], ['always', 'Always']]));
        countdown.add(choiceRow(settings, 'time-style', 'Show as',
            'Time left: 1h50m · Clock: 12:30 PM',
            [['remaining', 'Time left'], ['clock', 'Clock']]));

        const updates = new Adw.PreferencesGroup({title: 'Updates'});
        page.add(updates);
        updates.add(spinRow(settings, 'refresh-minutes', 'Refresh every (minutes)', '', 1, 60));
        updates.add(switchRow(settings, 'auto-renew', 'Renew sign-in automatically',
            'Experimental. When the login has been expired 5 min, ask Claude Code to renew it in the background. ' +
            'If an open Claude Code renews at the same moment, it could get signed out.'));
    }

    // A copy of the top-bar widget, redrawn on every settings change
    _previewGroup(settings, lastUsage, window) {
        const css = new Gtk.CssProvider();
        css.load_from_string(PREVIEW_CSS);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const group = new Adw.PreferencesGroup({title: 'Preview'});
        const panel = new Gtk.Box({css_classes: ['claude-usage-panel'], spacing: 4, halign: Gtk.Align.END});
        const icon = new Gtk.Image({gicon: Gio.FileIcon.new(this.dir.get_child('icons').get_child('claude-symbolic.svg')), pixel_size: 16});
        const label = new Gtk.Label();
        const cdIcon = new Gtk.Image({pixel_size: 13, margin_start: 6});
        const cdLabel = new Gtk.Label();
        [icon, label, cdIcon, cdLabel].forEach(w => panel.append(w));
        group.add(panel);

        const cdIcons = {
            reset: new Gio.ThemedIcon({name: 'alarm-symbolic'}),
            out: Gio.FileIcon.new(this.dir.get_child('icons').get_child('hourglass-symbolic.svg')),
        };
        const redraw = () => {
            const real = lastUsage();
            group.description = real ? 'Your latest numbers, with these settings' : 'Sample numbers — yours appear after the first update';
            const {top, parts, text, cd} = summarise(real ?? sampleUsage(), settings);
            label.set_markup(labelMarkup(parts, settings.get_boolean('color-enabled')));
            label.visible = text !== '';
            cdIcon.visible = cdLabel.visible = cd !== null;
            if (cd) {
                cdIcon.gicon = cdIcons[cd.kind];
                cdLabel.label = countdownText(cd, settings);
            }
            for (const w of [icon, label, cdIcon, cdLabel]) {
                LEVELS.forEach(c => w.remove_css_class(c));
                if (top && settings.get_boolean('color-enabled') && w !== label)
                    w.add_css_class(LEVELS[w === icon ? top.pillLevel : cd?.level ?? 0]);
            }
        };
        redraw();
        const id = settings.connect('changed', redraw);
        window.connect('close-request', () => {
            settings.disconnect(id);
            return false;
        });
        return group;
    }
}
