/**
 * ModeManager - Detects and manages skill mode activations per zone
 *
 * Modes:
 * - ecc: Enhanced Claude Code skills (Skill tool used)
 * - superpower: Multi-perspective analysis (3+ Task spawns in 5s window)
 * - octopus: Multi-AI collaboration (Bash with codex/gemini CLI)
 *
 * Escalation: ecc → superpower → octopus (higher mode replaces lower)
 */

export type SkillMode = 'none' | 'ecc' | 'superpower' | 'octopus'

const MODE_PRIORITY: Record<SkillMode, number> = {
  none: 0,
  ecc: 1,
  superpower: 2,
  octopus: 3,
}

interface ZoneModeState {
  mode: SkillMode
  activatedAt: number
  taskSpawnTimestamps: number[]  // sliding window for superpower detection
}

type ModeChangeCallback = (zoneId: string, newMode: SkillMode, oldMode: SkillMode) => void

const SUPERPOWER_TASK_THRESHOLD = 3
const SUPERPOWER_WINDOW_MS = 5000
const DEACTIVATE_DELAY_MS = 3000

class ModeManager {
  private zones = new Map<string, ZoneModeState>()
  private listeners: ModeChangeCallback[] = []
  private deactivateTimers = new Map<string, ReturnType<typeof setTimeout>>()

  getMode(zoneId: string): SkillMode {
    return this.zones.get(zoneId)?.mode ?? 'none'
  }

  /**
   * Activate a mode for a zone. Higher-priority modes replace lower ones.
   * Returns true if the mode actually changed.
   */
  activate(zoneId: string, mode: SkillMode): boolean {
    const state = this.getOrCreateState(zoneId)
    if (MODE_PRIORITY[mode] <= MODE_PRIORITY[state.mode]) return false

    // Cancel pending deactivation
    this.clearDeactivateTimer(zoneId)

    const oldMode = state.mode
    state.mode = mode
    state.activatedAt = Date.now()
    this.notify(zoneId, mode, oldMode)
    return true
  }

  /**
   * Deactivate mode for a zone (with optional delay).
   * Only deactivates if the current mode matches (or force=true).
   */
  deactivate(zoneId: string, mode?: SkillMode, delay = DEACTIVATE_DELAY_MS): void {
    const state = this.zones.get(zoneId)
    if (!state || state.mode === 'none') return
    if (mode && state.mode !== mode) return

    this.clearDeactivateTimer(zoneId)

    if (delay > 0) {
      this.deactivateTimers.set(zoneId, setTimeout(() => {
        this.deactivateImmediate(zoneId)
      }, delay))
    } else {
      this.deactivateImmediate(zoneId)
    }
  }

  /**
   * Record a Task spawn for superpower detection.
   * Returns true if superpower threshold was reached.
   */
  recordTaskSpawn(zoneId: string): boolean {
    const state = this.getOrCreateState(zoneId)
    const now = Date.now()
    state.taskSpawnTimestamps.push(now)

    // Prune timestamps outside the window
    const cutoff = now - SUPERPOWER_WINDOW_MS
    state.taskSpawnTimestamps = state.taskSpawnTimestamps.filter(t => t > cutoff)

    if (state.taskSpawnTimestamps.length >= SUPERPOWER_TASK_THRESHOLD) {
      return this.activate(zoneId, 'superpower')
    }
    return false
  }

  /**
   * Check if a Bash command triggers Octopus mode.
   * Looks for codex/gemini CLI invocations.
   */
  checkOctopusTrigger(command: string): boolean {
    if (!command) return false
    const lower = command.toLowerCase()
    return (
      lower.includes('codex ') || lower.includes('codex\n') ||
      lower.includes('gemini ') || lower.includes('gemini\n') ||
      lower.startsWith('codex') || lower.startsWith('gemini')
    )
  }

  onChange(callback: ModeChangeCallback): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback)
    }
  }

  /** Reset all zones — useful for cleanup */
  reset(): void {
    for (const [zoneId, state] of this.zones) {
      if (state.mode !== 'none') {
        this.deactivateImmediate(zoneId)
      }
    }
    this.zones.clear()
    for (const timer of this.deactivateTimers.values()) clearTimeout(timer)
    this.deactivateTimers.clear()
  }

  private getOrCreateState(zoneId: string): ZoneModeState {
    let state = this.zones.get(zoneId)
    if (!state) {
      state = { mode: 'none', activatedAt: 0, taskSpawnTimestamps: [] }
      this.zones.set(zoneId, state)
    }
    return state
  }

  private deactivateImmediate(zoneId: string): void {
    const state = this.zones.get(zoneId)
    if (!state || state.mode === 'none') return
    const oldMode = state.mode
    state.mode = 'none'
    state.taskSpawnTimestamps = []
    this.deactivateTimers.delete(zoneId)
    this.notify(zoneId, 'none', oldMode)
  }

  private clearDeactivateTimer(zoneId: string): void {
    const timer = this.deactivateTimers.get(zoneId)
    if (timer) {
      clearTimeout(timer)
      this.deactivateTimers.delete(zoneId)
    }
  }

  private notify(zoneId: string, newMode: SkillMode, oldMode: SkillMode): void {
    for (const cb of this.listeners) {
      cb(zoneId, newMode, oldMode)
    }
  }
}

export const modeManager = new ModeManager()
