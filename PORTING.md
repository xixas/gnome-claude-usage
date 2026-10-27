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
  "seven_day_opus": null,
  "seven_day_oauth_apps": null,
  "extra_usage": { "is_enabled": false, "utilization": null },
  "limits": [
    { "kind": "session",       "percent": 9,  "resets_at": "…", "scope": null },
    { "kind": "weekly_all",    "percent": 41, "resets_at": "…", "scope": null },
    { "kind": "weekly_scoped", "percent": 15, "resets_at": "2026-10-23T08:00:00+00:00",
      "scope": { "model": { "id": null, "display_name": "Fable" } } }
  ]
}
```

- `utilization` is **percent used, 0–100**.
- **Plan limits** = top-level keys matching `^(five_hour|seven_day\w*)$`, excluding `seven_day_oauth_apps`, whose value has a numeric `utilization`; **plus** each `limits[]` entry with `kind: "weekly_scoped"`, a numeric `percent` and `scope.model.display_name` → key `seven_day_<display_name lowercased>` (this is the only place model limits such as Fable appear). Ignore everything else.
- Names: `five_hour` → Session, `seven_day` → Week, `seven_day_<model>` → `<Model>`. Short labels: first letter (S, W, F…).

## Rules

**Pace** (projected % at reset), per limit:

```
window   = 5 h for five_hour, 7 d for every seven_day*
span(a,b)= b − a for the session; for weekly limits only the working hours between a and b
           (settings: pace-hours = work | all, work-days, work-start, work-end)
total    = span(resets_at − window, resets_at)
elapsed  = max(span(resets_at − window, now), 10% of total)
pace     = used × total / elapsed
runs out = now + (100 − used) × elapsed / used, counted forward over span; kept only if before resets_at
session  : also from the rate over the last 30 min of fetched samples (≥ 10 min of history, reset drops ignored);
           the earlier run-out wins
reset passed (resets_at ≤ now) → the limit counts as 0%, "↻", and is refetched once
```

**Level** per limit (weekly limits measure time in working hours): red = used ≥ 100, or ≤ 2% left with the reset > 30 min away, or it runs out before the reset within `soon` (1 h session, one working day weekly; ×1.25 if it was red last render) or with used ≥ 90 — otherwise amber; green "off" when no working time is left before a weekly reset (still shown in amber text at ≥ 90%); amber = pace ≥ `amber-at` (95); else green. Model-scoped limits (Fable…) colour the icon at most amber unless `model-colour` = red.

**Top limit** = highest icon level; among reds, the one that stops you first; then session → week → models. It sets the icon colour and the verdict.

**Bar text:** the session `9%` always, plus `W 64%` / `F 100%` for any other limit that's amber or red (or every limit, with `show-limits` = always), each in its own colour (`100 − x` in "left" mode).

**As of:** pace and run-out are computed at the moment the numbers were fetched, so they hold still between fetches; the clock only moves the countdown and how close the run-out is.

**Countdown** (default: always): the limit that turns the icon red and stops you first, else the session. Runs out first → hourglass + time until run-out; otherwise alarm + time until its reset. Coloured by that limit. Format `1h50m` / `1d2h`, or clock time (`12:30 PM`, `Thu 1:30 PM`).

**Verdict** (menu): Limit reached / Almost used up / Running out / Heading for the limit / Cutting it close / Just reset / On track.

**Stale:** numbers older than 3 × the refresh interval turn grey, with the time they're from.

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
