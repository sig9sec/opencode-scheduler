/**
 * @sig9.ch/opencode-scheduler
 *
 * OpenCode v2 plugin that schedules recurring `opencode run` prompts with
 * the OS scheduler (systemd --user timers, cron fallback). See README.md
 * for the storage layout and reliability guarantees.
 */
import { Plugin, Skill } from "@opencode/plugin"
import { migrateLegacyJobs } from "./migrate.js"
import { registerTools } from "./tools.js"
import { ensureSkillFile, SKILL_CONTENT, SKILL_ID, SKILL_NAME } from "./skill.js"

export default Plugin.define({
  id: "opencode-scheduler",
  async setup(ctx) {
    const locationDir = ctx.location.directory

    // Heal jobs written by the 1.x plugin: their invocation snapshots use
    // v1 opencode flags that no longer exist, so their next tick would fail.
    // Idempotent; only writes when something actually changes.
    try {
      const migration = migrateLegacyJobs()
      if (migration.migrated.length > 0) {
        console.log(`[opencode-scheduler] migrated ${migration.migrated.length} job(s) to v2 invocations: ${migration.migrated.join(", ")}`)
      }
      for (const skipped of migration.skipped) {
        console.warn(`[opencode-scheduler] job "${skipped.slug}" needs attention: ${skipped.reason}`)
      }
      for (const failed of migration.failed) {
        console.warn(`[opencode-scheduler] migration issue for "${failed.slug}": ${failed.error}`)
      }
    } catch (error) {
      console.warn(`[opencode-scheduler] job migration failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Expose the best-practices skill natively so scheduled prompts can
    // reference it with @scheduled-job-best-practices.
    const skillPath = ensureSkillFile()
    await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make(SKILL_ID),
        name: Skill.Name.make(SKILL_NAME),
        description: "Patterns for reliable, non-interactive scheduled opencode jobs",
        path: Skill.Info.fields.path.make(skillPath),
        content: SKILL_CONTENT,
      })
    })

    await ctx.tool.transform((editor) => {
      registerTools(editor, locationDir)
    })
  },
})
