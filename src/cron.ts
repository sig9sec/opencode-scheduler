/**
 * Cron expression parsing, validation, human-readable descriptions, and
 * conversion to systemd OnCalendar specifications.
 *
 * Supported syntax: 5 fields (minute hour day-of-month month day-of-week)
 * with "*", numbers, ranges with optional steps ("9-17", "9-17/2"), steps
 * ("* /15"), and comma-separated lists. Day-of-week accepts 0-7 with both
 * 0 and 7 meaning Sunday.
 */

export type CronField = [string, string, string, string, string]

export function splitCronExpression(cron: string): CronField {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: ${cron} (expected 5 fields: minute hour day-of-month month day-of-week)`
    )
  }
  return parts as CronField
}

interface FieldRules {
  min: number
  max: number
  label: string
}

const FIELD_RULES: FieldRules[] = [
  { min: 0, max: 59, label: "minute" },
  { min: 0, max: 23, label: "hour" },
  { min: 1, max: 31, label: "day of month" },
  { min: 1, max: 12, label: "month" },
  { min: 0, max: 7, label: "day of week" },
]

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

/**
 * Expand one cron field into the set of numbers it matches.
 * Returns null for `*` (meaning: field unconstrained).
 */
export function parseCronField(field: string, rules: FieldRules): number[] | null {
  if (field === "*") return null

  const expandPart = (part: string): number[] => {
    // Step over the whole range: */n
    if (part.startsWith("*/")) {
      return parseStep(part.slice(2), rules, rules.min)
    }

    // Range with optional step: a-b or a-b/n
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10)
      const end = parseInt(rangeMatch[2], 10)
      if (start < rules.min || end > rules.max || start > end) {
        throw new Error(`Invalid cron ${rules.label} range: ${part} (allowed ${rules.min}-${rules.max})`)
      }
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1
      const values: number[] = []
      for (let v = start; v <= end; v += step) values.push(normalizeDow(v, rules))
      return values
    }

    if (/^\d+$/.test(part)) {
      return [parseCronNumber(part, rules)]
    }

    throw new Error(`Invalid cron ${rules.label} field: ${part}`)
  }

  return uniqueSorted(field.split(",").flatMap(expandPart))
}

function parseStep(stepRaw: string, rules: FieldRules, start: number): number[] {
  const step = parseInt(stepRaw, 10)
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`Invalid cron ${rules.label} step: */${stepRaw}`)
  }
  const values: number[] = []
  for (let v = start; v <= rules.max; v += step) values.push(normalizeDow(v, rules))
  return values
}

function parseCronNumber(value: string, rules: FieldRules): number {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid cron ${rules.label} value: ${value}`)
  }
  const normalized = normalizeDow(parsed, rules)
  if (normalized < rules.min || parsed > rules.max) {
    throw new Error(`Invalid cron ${rules.label} value: ${value} (allowed ${rules.min}-${rules.max})`)
  }
  return normalized
}

/** Day-of-week accepts 7 as an alias for Sunday (0). */
function normalizeDow(value: number, rules: FieldRules): number {
  return rules.label === "day of week" && value === 7 ? 0 : value
}

export function validateCronExpression(cron: string): void {
  const fields = splitCronExpression(cron)
  fields.forEach((field, index) => parseCronField(field, FIELD_RULES[index]))
}

// === Human-readable description ===

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function formatTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM"
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return `${displayHour}:${minute.toString().padStart(2, "0")} ${ampm}`
}

const DOW_RULES = { min: 0, max: 7, label: "day of week" }

function describeDowField(dow: string): string | null {
  let values: number[] | null
  try {
    values = parseCronField(dow, DOW_RULES)
  } catch {
    return null
  }
  if (!values || values.length === 0) return null
  const names = values.map((v) => DOW_NAMES[v % 7] ?? String(v))
  const consecutive = values.every((v, i) => i === 0 || v === values[i - 1] + 1)
  if (consecutive && values.length > 2) return `${names[0]}-${names[names.length - 1]}`
  return names.join("/")
}

export function describeCron(cron: string): string {
  let fields: CronField
  try {
    fields = splitCronExpression(cron)
  } catch {
    return cron
  }
  const [minute, hour, dom, mon, dow] = fields

  const all = (field: string) => field === "*"

  if (all(mon) && all(dom)) {
    if (all(dow) && /^\d+$/.test(hour) && /^\d+$/.test(minute)) {
      return `daily at ${formatTime(parseInt(hour), parseInt(minute))}`
    }
    if (hour.startsWith("*/") && /^\d+$/.test(minute)) {
      return `every ${hour.slice(2)} hours at :${minute.padStart(2, "0")}`
    }
    if (minute.startsWith("*/") && all(hour)) {
      return `every ${minute.slice(2)} minutes`
    }
  }

  if (!all(dow) && all(dom) && all(mon) && /^\d+$/.test(hour) && /^\d+$/.test(minute)) {
    const days = describeDowField(dow)
    if (days) {
      const label = namesCount(days) === 1 ? `${days}s` : days
      return `${label} at ${formatTime(parseInt(hour), parseInt(minute))}`
    }
  }

  return cron
}

/** "Monday" (one name) vs "Monday/Wednesday" or "Monday-Friday" (several). */
function namesCount(days: string): number {
  return days.split(/[/-]/).length
}

// === systemd conversion ===

const SYSTEMD_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const MAX_SYSTEMD_CALENDARS = 64

function formatSystemdValue(value: number, size: number): string {
  return value.toString().padStart(size, "0")
}

/**
 * Convert a cron expression to one or more systemd OnCalendar expressions.
 *
 * cron treats a restricted day-of-month together with a restricted
 * day-of-week as a union (either matches), while systemd ANDs them, so that
 * case expands into two groups of calendars.
 */
export function cronToSystemdCalendars(cron: string): string[] {
  const [minute, hour, dom, mon, dow] = splitCronExpression(cron)
  const minutes = parseCronField(minute, FIELD_RULES[0])
  const hours = parseCronField(hour, FIELD_RULES[1])
  const days = parseCronField(dom, FIELD_RULES[2])
  const months = parseCronField(mon, FIELD_RULES[3])
  const weekdays = parseCronField(dow, FIELD_RULES[4])

  const minuteValues = minutes ? minutes.map((v) => formatSystemdValue(v, 2)) : ["*"]
  const hourValues = hours ? hours.map((v) => formatSystemdValue(v, 2)) : ["*"]
  const dayValues = days ? days.map((v) => formatSystemdValue(v, 2)) : ["*"]
  const monthValues = months ? months.map((v) => formatSystemdValue(v, 2)) : ["*"]
  const weekdayValues = weekdays ? weekdays.map((v) => SYSTEMD_WEEKDAYS[v]) : ["*"]

  const calendars: string[] = []
  const buildGroup = (domGroup: string[], dowGroup: string[]): void => {
    for (const mm of minuteValues) {
      for (const hh of hourValues) {
        for (const dd of domGroup) {
          for (const mo of monthValues) {
            for (const wd of dowGroup) {
              // A leading weekday is only valid when it is constrained; a
              // bare "* " prefix makes systemd reject the whole spec.
              const weekdayPart = wd === "*" ? "" : `${wd} `
              calendars.push(`${weekdayPart}*-${mo}-${dd} ${hh}:${mm}:00`)
            }
          }
        }
      }
    }
  }

  if (days && weekdays) {
    buildGroup(dayValues, ["*"])
    buildGroup(["*"], weekdayValues)
  } else {
    buildGroup(dayValues, weekdayValues)
  }

  if (calendars.length > MAX_SYSTEMD_CALENDARS) {
    throw new Error(
      `Cron expression expands to ${calendars.length} systemd calendar entries (max ${MAX_SYSTEMD_CALENDARS}). ` +
        "Use a simpler expression, for example a step or a shorter list."
    )
  }

  return calendars
}
