/**
 * One-time migration of jobs written by the 1.x plugin.
 *
 * v2 changed the `opencode run` flag set (no more --attach, --port,
 * --share, --variant, --command, --dangerously-skip-permissions), so every
 * stored invocation snapshot from 1.x is stale: the next scheduled tick
 * would fail with "unknown flag". Jobs are self-describing enough to
 * rebuild: the run spec is recovered (from the run field, legacy top-level
 * fields, or by reverse-parsing the old invocation), the invocation is
 * rebuilt with v2 flags, and scheduler units are reinstalled so they no
 * longer depend on the retired perl supervisor.
 *
 * Units only reference the supervisor and the job file path, so rewriting
 * the invocation alone already fixes future ticks; the reinstall is a
 * best-effort bonus and failures are reported, not thrown.
 */
import { buildInvocation, invocationsEqual } from "./invocation.js"
import { loadAllJobsAcrossScopes, saveJob, type Job } from "./jobs.js"
import { installJob, jobScheduledState } from "./backends.js"

export interface MigrationResult {
  migrated: string[]
  skipped: { slug: string; reason: string }[]
  failed: { slug: string; error: string }[]
}

export function migrateLegacyJobs(): MigrationResult {
  const result: MigrationResult = { migrated: [], skipped: [], failed: [] }

  let jobs: Job[]
  try {
    jobs = loadAllJobsAcrossScopes()
  } catch {
    return result
  }

  for (const job of jobs) {
    try {
      if (!job.run?.prompt?.trim()) {
        result.skipped.push({ slug: job.slug, reason: "no run prompt could be recovered" })
        continue
      }

      const desired = buildInvocation(job)
      if (invocationsEqual(job.invocation, desired)) continue

      const updated: Job = saveJob({ ...job, invocation: desired, updatedAt: new Date().toISOString() })

      // Best effort: also repoint units from the perl supervisor to the new
      // node supervisor. The job file rewrite above is what actually fixes
      // scheduled runs, so a unit reinstall failure is not fatal. A timer
      // the user deliberately disabled stays disabled.
      try {
        const enable = jobScheduledState(job) !== "disabled"
        installJob(updated, { enable })
      } catch (error) {
        result.failed.push({
          slug: job.slug,
          error: `invocation updated, but scheduler unit reinstall failed: ${errorMessage(error)}`,
        })
        continue
      }

      result.migrated.push(job.slug)
    } catch (error) {
      result.failed.push({ slug: job.slug, error: errorMessage(error) })
    }
  }

  return result
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
