# Claude Usage — GNOME top bar

A small GNOME Shell extension that shows your Claude plan limits (session, week, model limits) in the top bar, coloured by whether you're **on track** to reach the reset.

> Unofficial. Not affiliated with or endorsed by Anthropic. "Claude" and the Claude logo are trademarks of Anthropic.
> `icons/claude-symbolic.svg` is a hand-drawn lookalike, not Anthropic's asset, and is **not** covered by the MIT licence.

## What it shows

- **Top bar:** Claude icon + the session % first, always. The week and model limits (`W 66%`, `F 100%`) join it only when they're amber or red (or always, if you choose that in Settings), each in its own colour.
- **Colour** answers "will this stop me before it resets?": green = fine, amber = you'll end the window at ≥ 95% or a weekly run-out is coming, red = used up, ≤ 2% left, or it runs out before the reset soon — within 1 h for the session, 1 working day for weekly limits — or at ≥ 90% used. Once red it stays red a little longer, so it doesn't flicker. A weekly limit with no working hours left before its reset is green (shown in amber text if ≥ 90%, in case you work the weekend). A used-up model limit (Fable) turns the icon amber at most, since the API doesn't say which model you're on.
- **Countdown:** ⏰ the session reset, or the reset of the red limit that stops you first; ⌛ when a limit will run out first. Coloured by the limit it counts down for. Time left or clock time.
- **Menu:** a one-line verdict naming the limit that sets the colour, every limit with a bar, reset time and pace.
- **Settings:** live preview, week and model limits in the bar (when amber or red, or always), working days and hours for weekly pace, the amber threshold, how far a model limit may colour the icon, used/left, countdown, refresh interval.
- **Stays current:** re-judged every minute; a window that rolled over shows `0% ↻` and refetches; numbers older than 3 refresh intervals turn grey.
- **Problems shown clearly:** no internet, can't reach Anthropic, sign-in needed (with a **Sign in…** action), service errors. Each gets its own theme icon, and your last numbers stay visible in grey. Retries as soon as you're back online; backs off when Anthropic says "too many requests" (HTTP 429).
- **Fresh when you look:** opening the menu refreshes if the numbers are over a minute old.

Pace = projected % at reset = `used% × window ÷ elapsed`. The session counts real time (5 h), and also projects from your rate over the last 30 minutes so a burst after idling isn't averaged away. Weekly limits count only your **working hours** (default Mon–Fri 9 AM–7 PM, or all hours), so nights and weekends don't dilute the rate. Elapsed is floored at 10% of the window. It's an estimate; the claude.ai "On track" line may use a different method. Scenarios: [`docs/priority-logic.html`](docs/priority-logic.html); tests: `TZ=Asia/Kolkata gjs -m tests/limits.test.js`.

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
