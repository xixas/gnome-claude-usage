# Claude Usage — GNOME top bar

A small GNOME Shell extension that shows your Claude plan limits (session, week, model limits) in the top bar, coloured by whether you're **on track** to reach the reset.

> Unofficial. Not affiliated with or endorsed by Anthropic. "Claude" and the Claude logo are trademarks of Anthropic.
> `icons/claude-symbolic.svg` is a hand-drawn lookalike, not Anthropic's asset, and is **not** covered by the MIT licence.

## What it shows

- **Top bar:** Claude icon + `session% · week%` (pick which limits in Settings).
- **Colour:** green = on track, amber = cutting it close, red = you'll run out before the reset (or colour by plain % used).
- **Countdown** (amber/red by default): ⏱ time to reset, or ⌛ time until you run out when red. Time left or clock time.
- **Menu:** a one-line verdict ("On track — you should reach the session reset with room to spare"), every limit with a bar, reset time and pace.
- **Settings:** live preview, which limits sit in the bar, used/left, colour by pace/usage, thresholds, countdown, refresh interval.
- **Problems shown clearly:** no internet, can't reach Anthropic, sign-in needed (with a **Sign in…** action), service errors. Each gets its own theme icon, and your last numbers stay visible in grey. Retries as soon as you're back online; backs off when Anthropic says "too many requests" (HTTP 429).
- **Fresh when you look:** opening the menu refreshes if the numbers are over a minute old.

Pace = `used% ÷ (time elapsed ÷ window)`, window 5 h for the session and 7 d for weekly limits. It's an estimate; the claude.ai "On track" line may use a different method.

Design mockup: [`docs/mockup.html`](docs/mockup.html).

## How it gets the numbers

It calls `https://api.anthropic.com/api/oauth/usage` — the endpoint Claude Code's `/usage` uses — with the OAuth token Claude Code stores in `~/.claude/.credentials.json`. The token is read at each refresh and sent only to `api.anthropic.com`; it is never stored. The latest plan-limit percentages and reset times (nothing else from the response) are saved in GNOME settings (`last-usage`) so the settings window can show them.

- You need [Claude Code](https://claude.com/claude-code) installed and logged in with a Claude subscription.
- Only Claude Code renews that token. If you haven't run it for a while, the bar shows a padlock until you open Claude Code again, or use **Sign in…** in the menu. An experimental, off-by-default setting can renew it in the background through the `claude` CLI; the refresh token is single-use, so if an open Claude Code renews at the same moment it could get signed out.
- The endpoint is undocumented and may change or stop working at any time.

## Install

GNOME Shell 48–50.

```sh
git clone https://github.com/xixas/gnome-claude-usage.git \
  ~/.local/share/gnome-shell/extensions/claude-usage@vikas
glib-compile-schemas ~/.local/share/gnome-shell/extensions/claude-usage@vikas/schemas/
```

Log out and back in (Wayland), then:

```sh
gnome-extensions enable claude-usage@vikas
```

## Other desktops

GNOME only. To port it to KDE Plasma, COSMIC or a tray app, start with [`PORTING.md`](PORTING.md): it has the endpoint, the response shape, and every rule as plain numbers.

## License

MIT
