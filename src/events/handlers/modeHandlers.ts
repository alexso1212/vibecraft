/**
 * Mode Detection Handlers
 *
 * Subscribes to EventBus events and triggers mode activations:
 * - Skill tool → ECC mode
 * - 3+ Task spawns in 5s → Superpower mode (escalates from ECC)
 * - Bash with codex/gemini → Octopus mode (escalates from any)
 * - stop event → delayed deactivation
 */

import { eventBus } from '../EventBus'
import { modeManager } from '../../effects/ModeManager'
import type { PreToolUseEvent, StopEvent } from '../../../shared/types'

export function registerModeHandlers(): void {
  // Skill tool → activate ECC
  eventBus.on('pre_tool_use', (event: PreToolUseEvent, ctx) => {
    if (!ctx.session) return
    if (event.tool === 'Skill') {
      modeManager.activate(ctx.session.id, 'ecc')
    }
  })

  // Task tool → count spawns, may escalate to Superpower
  eventBus.on('pre_tool_use', (event: PreToolUseEvent, ctx) => {
    if (!ctx.session) return
    if (event.tool === 'Task') {
      // Ensure at least ECC is active
      modeManager.activate(ctx.session.id, 'ecc')
      // Record spawn — may upgrade to superpower
      modeManager.recordTaskSpawn(ctx.session.id)
    }
  })

  // Bash with codex/gemini → Octopus mode
  eventBus.on('pre_tool_use', (event: PreToolUseEvent, ctx) => {
    if (!ctx.session) return
    if (event.tool === 'Bash') {
      const command = (event.toolInput?.command as string) ?? ''
      if (modeManager.checkOctopusTrigger(command)) {
        modeManager.activate(ctx.session.id, 'octopus')
      }
    }
  })

  // Stop → schedule deactivation (3s delay for visual exit animation)
  eventBus.on('stop', (_event: StopEvent, ctx) => {
    if (!ctx.session) return
    modeManager.deactivate(ctx.session.id)
  })
}
