// Claude Code's login, borrowed read-only. Claude Code renews its token while it runs;
// when it has expired, the menu offers an interactive sign-in in a terminal.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CREDS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

// kind: offline | unreachable | auth | ratelimit | server
export class UsageError extends Error {
    constructor(kind, message, retryAfter = null) {
        super(message);
        this.kind = kind;
        this.retryAfter = retryAfter;
    }
}

// GNOME Shell's PATH often lacks ~/.local/bin, where Claude Code installs itself
function claudePath() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']);
    return GLib.find_program_in_path('claude') ?? (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

export class Auth {
    // A usable access token, or a UsageError('auth') saying why not
    async token() {
        let bytes;
        try {
            [, bytes] = Gio.File.new_for_path(CREDS_PATH).load_contents(null);
        } catch {
            throw new UsageError('auth', 'Claude Code is not installed or not signed in.');
        }
        const oauth = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth;
        if (!oauth?.accessToken)
            throw new UsageError('auth', 'Claude Code is not signed in.');
        if (oauth.expiresAt && oauth.expiresAt < Date.now())
            throw new UsageError('auth', 'Your Claude Code login expired. Open Claude Code, or sign in again.');
        return oauth.accessToken;
    }

    // Interactive sign-in in a terminal
    signIn() {
        const cmd = [claudePath() ?? 'claude', 'auth', 'login', '--claudeai'];
        const terminals = [['kgx', '--'], ['ptyxis', '--'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xterm', '-e']];
        for (const [term, flag] of terminals) {
            if (GLib.find_program_in_path(term)) {
                Gio.Subprocess.new([term, flag, ...cmd], Gio.SubprocessFlags.NONE);
                return true;
            }
        }
        return false;
    }

    destroy() {
    }
}
