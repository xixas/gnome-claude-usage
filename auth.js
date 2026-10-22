// Claude Code's login, borrowed read-only. Claude Code renews its token while it runs.
// Optionally (setting "auto-renew", off by default), when the token has been expired a while,
// ask the `claude` CLI to renew it without a browser — the approach Claudeland uses. The CLI
// owns the token protocol and the credentials file; this module never writes it.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CREDS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const RENEW_TIMEOUT_SECONDS = 45;
// The refresh token is single-use. A running Claude Code renews before expiry, so only step in
// once the token has been expired this long — then nothing else is about to spend it.
const RENEW_GRACE_MS = 5 * 60e3;
// Claude Code rejects a refresh token whose scopes are not restated
const FALLBACK_SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers'];
const EXPIRED = 'Your Claude Code login expired. Open Claude Code, or sign in again.';

// kind: offline | unreachable | renewing | auth | ratelimit | server
export class UsageError extends Error {
    constructor(kind, message, retryAfter = null) {
        super(message);
        this.kind = kind;
        this.retryAfter = retryAfter;
    }
}

function readOauth() {
    let bytes;
    try {
        [, bytes] = Gio.File.new_for_path(CREDS_PATH).load_contents(null);
    } catch {
        throw new UsageError('auth', 'Claude Code is not installed or not signed in.');
    }
    const oauth = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth;
    if (!oauth?.accessToken)
        throw new UsageError('auth', 'Claude Code is not signed in.');
    return oauth;
}

// GNOME Shell's PATH often lacks ~/.local/bin, where Claude Code installs itself
function claudePath() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']);
    return GLib.find_program_in_path('claude') ?? (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

function waitCheck(proc) {
    return new Promise(resolve => {
        let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RENEW_TIMEOUT_SECONDS, () => {
            timeoutId = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        proc.wait_check_async(null, (p, res) => {
            if (timeoutId)
                GLib.source_remove(timeoutId);
            try {
                resolve(p.wait_check_finish(res));
            } catch {
                resolve(false);
            }
        });
    });
}

export class Auth {
    constructor() {
        this._failedFor = null;
        this._proc = null;
    }

    // A usable access token, or a UsageError saying why not.
    // With autoRenew, an expired token is renewed through the CLI; onRenewing() runs just before.
    async token(autoRenew, onRenewing) {
        let oauth = readOauth();
        if (!oauth.expiresAt || oauth.expiresAt > Date.now())
            return oauth.accessToken;
        if (!autoRenew || !oauth.refreshToken || this._failedFor === oauth.refreshToken || !claudePath())
            throw new UsageError('auth', EXPIRED);
        if (Date.now() - oauth.expiresAt < RENEW_GRACE_MS)
            throw new UsageError('renewing', 'Waiting a few minutes in case Claude Code renews it first.');

        onRenewing();
        if (!await this._renew(oauth)) {
            this._failedFor = oauth.refreshToken;
            throw new UsageError('auth', 'Your Claude Code login expired and couldn\'t be renewed. Sign in again.');
        }
        oauth = readOauth();
        if (oauth.expiresAt && oauth.expiresAt <= Date.now())
            throw new UsageError('auth', EXPIRED);
        return oauth.accessToken;
    }

    async _renew(oauth) {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        // Through the environment, never argv: process arguments are world-readable
        launcher.setenv('CLAUDE_CODE_OAUTH_REFRESH_TOKEN', oauth.refreshToken, true);
        launcher.setenv('CLAUDE_CODE_OAUTH_SCOPES',
            (oauth.scopes?.length ? oauth.scopes : FALLBACK_SCOPES).join(' '), true);
        launcher.set_stdin_file_path('/dev/null');
        try {
            this._proc = launcher.spawnv([claudePath(), 'auth', 'login', '--claudeai']);
        } catch {
            return false;
        }
        const ok = await waitCheck(this._proc);
        this._proc = null;
        return ok;
    }

    // Interactive sign-in in a terminal
    signIn() {
        const cmd = [claudePath() ?? 'claude', 'auth', 'login', '--claudeai'];
        const terminals = [['kgx', '--'], ['ptyxis', '--'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xterm', '-e']];
        for (const [term, flag] of terminals) {
            if (GLib.find_program_in_path(term)) {
                Gio.Subprocess.new([term, flag, ...cmd], Gio.SubprocessFlags.NONE);
                this._failedFor = null;
                return true;
            }
        }
        return false;
    }

    destroy() {
        this._proc?.force_exit();
        this._proc = null;
    }
}
