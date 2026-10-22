# Porting to another desktop

Everything a port to KDE Plasma, COSMIC, a tray app, etc. needs. The rules here are the spec; the GNOME code is one implementation of it.

## Files

| File | GNOME-specific? | What it is |
|---|---|---|
| `limits.js` | no (uses GLib only for dates) | all logic: which limits count, pace, colour level, countdown, bar text |
| `auth.js` | no (GLib/Gio file + subprocess) | reads the token, error kinds |
| `extension.js` | **yes** | top-bar widget, menu, fetching, scheduling, error display |
| `prefs.js` + `schemas/` | **yes** | settings window and storage |
| `docs/mockup.html` | — | visual spec of every state |

## Data source

- **Token:** `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`; `claudeAiOauth.expiresAt` is a Unix time in **milliseconds**. Read it on every fetch; never copy it. Only Claude Code renews it.
- **Request:** `GET https://api.anthropic.com/api/oauth/usage` with headers
  `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, `Accept: application/json`.
- **Undocumented:** this is the endpoint Claude Code's `/usage` uses. It can change without notice.

Example response (shape only; extra fields vary):

```json
{
  "five_hour":       { "utilization": 9.0,  "resets_at": "2026-10-22T07:00:00+00:00" },
  "seven_day":       { "utilization": 41.0, "resets_at": "2026-10-23T08:00:00+00:00" },
  "seven_day_fable": { "utilization": 15.0, "resets_at": "2026-10-23T08:00:00+00:00" },
  "seven_day_oauth_apps": null,
  "extra_usage": { "is_enabled": false, "utilization": null }
}
```

- `utilization` is **percent used, 0–100**.
- **Plan limits** = keys matching `^(five_hour|seven_day\w*)$`, excluding `seven_day_oauth_apps`, whose value has a numeric `utilization`. Ignore everything else.
- Names: `five_hour` → Session, `seven_day` → Week, `seven_day_<model>` → `<Model>`. Short labels: first letter (S, W, F…).

## Rules

**Pace** (projected % at reset), per limit:

```
window   = 5 h for five_hour, 7 d for every seven_day*
elapsed  = window − (resets_at − now)
pace     = used × window / elapsed            (null if elapsed < 10% of window)
runs out = now + (100 − used) × elapsed / used   (only when pace ≥ 100; "now" if used ≥ 100)
```

**Level** per limit — colour by pace (default), when pace is known:
green `pace < 90`, amber `90 ≤ pace < 100`, red `runs out before reset`.
Otherwise colour by usage: amber from `warn-at` (50), red from `hot-at` (80).

**Top limit** = highest level, then highest pace (or used). It sets the bar colour, countdown and verdict.

**Bar text:** chosen limits as `9% · 41%` (or `100 − x` in "left" mode); short labels when on, or when 3+ are shown.

**Countdown** (default: only when amber/red): red with a run-out time → hourglass + time until run-out; otherwise alarm + time until the top limit resets. Format `1h50m` / `1d2h`, or clock time (`12:30 PM`, `Thu 1:30 PM`).

**Verdict** (menu): Limit reached / Running out / Cutting it close / On track; or Plenty left / Getting busy / Running low when colouring by usage.

**Colours:** green `#8ff0a4`, amber `#f6d32d`, red `#ff7b63`, grey `#9a9996`.

## Errors

Keep the last numbers on screen, grey; swap the Claude icon for the problem icon.

| Kind | When | Icon (freedesktop name) | Retry |
|---|---|---|---|
| offline | request failed and the OS says no network | `network-offline-symbolic` | when the network comes back, and each interval |
| unreachable | request failed, network is up | `network-error-symbolic` | each interval |
| auth | no credentials file / no token / expired / HTTP 401 or 403 | `changes-prevent-symbolic`; offer "Sign in…" (`claude auth login --claudeai` in a terminal) | each interval |
| ratelimit | HTTP 429 | none if numbers exist (status line shows next try) | `Retry-After`, else interval × 2ⁿ, max 1 h; reset on success |
| server | other HTTP status, bad JSON, no plan limits in response | `dialog-warning-symbolic` | each interval |

Also refresh when the menu opens, if the last attempt was over 60 s ago (not while rate-limited).
