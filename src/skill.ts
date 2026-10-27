/**
 * The built-in "scheduled job best practices" skill. Registered natively
 * with the OpenCode skill registry, so it can be @-mentioned from any
 * session in locations where the plugin is loaded - including the
 * `opencode run` sessions that scheduled jobs start.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { SCHEDULER_DIR } from "./config.js"

export const SKILL_ID = "scheduled-job-best-practices"
export const SKILL_NAME = "Scheduled Job Best Practices"
export const SKILL_DIR = join(SCHEDULER_DIR, "skills", SKILL_ID)

export const SKILL_CONTENT = `---
name: ${SKILL_ID}
description: Patterns for reliable, non-interactive scheduled opencode jobs
---

## Use This Skill

Put this line at the very top of any scheduled job prompt:

@${SKILL_ID}

Then write the task below it.

## Core Principles

1. **No magic injection.** Do not assume placeholders like __TODAY__ exist. Compute runtime values with tools (bash) during the run.
2. **Non-interactive.** Scheduled runs auto-approve permissions unless a deny rule matches, but deny rules still block. Never rely on QR codes, manual logins, or confirmation dialogs.
3. **Idempotent.** Make reruns safe (maintain a seen/state file; avoid duplicate messages).
4. **Observable.** Print a short summary at the end with status + outputs.
5. **Minimal side effects.** Write durable artifacts under outputs/ in the job workdir.
6. **Bounded.** Set timeoutSeconds on the job so a hung run cannot hold the lock forever.

## Runtime Values: Dates

If you need local dates, compute them at runtime.

~~~bash
TODAY="$(date +%F)"
TOMORROW="$(date -d 'tomorrow' +%F)"
~~~

If timezone matters, set TZ explicitly (example: TZ=Europe/Zurich date +%F).

## Preflight Checklist

Before doing any expensive work:

- Confirm required tools are available (browser, network, etc).
- Confirm required env vars exist (source .env only if needed).
- If a dependency is missing or offline, stop early and emit a single concise reason.

## Notifications (Telegram)

Prefer the Telegram Bot API (non-interactive) over web.telegram.org.

## Output Contract

End every run with a compact summary:

- Status: success | skipped | failed
- Reason (1 line)
- Outputs written (paths)
- Notifications sent (message_id, chat_id) if applicable

## Idempotency Pattern

When notifying about "new" items (deals, alerts, etc.):

- Store a seen list in outputs/<job>/seen.json
- Only notify on items not in seen.json
- Update seen.json after sending
`

/** Materialize the SKILL.md file so the registered path really exists. */
export function ensureSkillFile(): string {
  mkdirSync(SKILL_DIR, { recursive: true })
  const path = join(SKILL_DIR, "SKILL.md")
  const content = SKILL_CONTENT.trimEnd() + "\n"
  if (!existsSync(path) || readFileSync(path, "utf-8") !== content) {
    writeFileSync(path, content)
  }
  return path
}
