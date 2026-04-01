/**
 * FeedManager - Task Tracker Panel
 *
 * Transforms raw Claude events into a high-level task memory:
 * - Each user_prompt_submit starts a new task
 * - pre/post_tool_use accumulate as work within the current task
 * - Task tool spawns sub-task branches
 * - stop with response completes a task turn
 *
 * Helps humans remember what's happening across long terminal sessions.
 */

import { getToolIcon } from '../utils/ToolUtils'
import type { ClaudeEvent, PreToolUseEvent, PostToolUseEvent } from '../../shared/types'

// ============================================================================
// Task Model
// ============================================================================

interface TaskTool {
  tool: string
  toolUseId: string
  file?: string
  command?: string
  success?: boolean
  duration?: number
}

interface SubTask {
  toolUseId: string
  description: string
  status: 'running' | 'done'
}

interface TaskSummary {
  id: string
  prompt: string
  timestamp: number
  sessionId: string
  status: 'working' | 'done'
  tools: TaskTool[]
  subTasks: SubTask[]
  response?: string
  filesChanged: Set<string>
  filesRead: Set<string>
}

// ============================================================================
// FeedManager (TaskTracker)
// ============================================================================

export class FeedManager {
  private feedEl: HTMLElement | null = null
  private scrollBtn: HTMLElement | null = null

  // Task state
  private tasks: TaskSummary[] = []
  private taskElements = new Map<string, HTMLElement>()
  private currentTaskId: string | null = null

  // Dedup & filter
  private eventIds = new Set<string>()
  private activeFilter: string | null = null
  private cwd = ''

  // Thinking indicator per session
  private thinkingIndicators = new Map<string, HTMLElement>()

  // Track completed tool data that arrives before pre_tool_use
  private completedData = new Map<string, { success: boolean; duration?: number }>()

  // Dedup assistant text
  private lastAssistantText: string | null = null
  private lastAssistantTextTime = 0

  constructor() {
    this.feedEl = document.getElementById('activity-feed')
    this.scrollBtn = document.getElementById('feed-scroll-bottom')
  }

  setCwd(cwd: string): void {
    this.cwd = cwd
  }

  private shortenPath(path: string): string {
    if (!this.cwd || !path) return path
    const cwdNorm = this.cwd.endsWith('/') ? this.cwd.slice(0, -1) : this.cwd
    if (path.startsWith(cwdNorm + '/')) {
      return path.slice(cwdNorm.length + 1)
    }
    // Also shorten home directory
    return path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
  }

  setupScrollButton(): void {
    if (!this.feedEl || !this.scrollBtn) return
    this.feedEl.addEventListener('scroll', () => this.updateScrollButton())
    this.scrollBtn.addEventListener('click', () => this.scrollToBottom())
  }

  setFilter(sessionId: string | null): void {
    if (!this.feedEl) return
    this.activeFilter = sessionId
    this.feedEl.querySelectorAll('.task-card').forEach((el) => {
      const card = el as HTMLElement
      const shouldShow = sessionId === null || card.dataset.sessionId === sessionId
      card.style.display = shouldShow ? '' : 'none'
    })
    this.scrollToBottom()
  }

  scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (this.feedEl) {
        this.feedEl.scrollTop = this.feedEl.scrollHeight
      }
    })
  }

  isNearBottom(): boolean {
    if (!this.feedEl) return true
    const threshold = 100
    return this.feedEl.scrollHeight - this.feedEl.scrollTop - this.feedEl.clientHeight < threshold
  }

  private updateScrollButton(): void {
    if (!this.scrollBtn) return
    this.scrollBtn.classList.toggle('visible', !this.isNearBottom())
  }

  showThinking(sessionId: string, sessionColor?: number): void {
    if (!this.feedEl) return
    if (this.thinkingIndicators.has(sessionId)) return

    this.removeEmptyState()

    const item = document.createElement('div')
    item.className = 'task-thinking'
    item.dataset.sessionId = sessionId

    if (sessionColor !== undefined) {
      item.style.borderLeftColor = `#${sessionColor.toString(16).padStart(6, '0')}`
      item.style.borderLeftWidth = '3px'
      item.style.borderLeftStyle = 'solid'
    }

    item.innerHTML = `
      <div class="task-thinking-inner">
        <span class="thinking-dot-pulse"></span>
        <span>Thinking...</span>
      </div>
    `

    this.thinkingIndicators.set(sessionId, item)
    this.feedEl.appendChild(item)

    if (this.activeFilter !== null && sessionId !== this.activeFilter) {
      item.style.display = 'none'
    } else {
      this.scrollToBottom()
    }
  }

  hideThinking(sessionId?: string): void {
    if (sessionId) {
      const indicator = this.thinkingIndicators.get(sessionId)
      if (indicator) {
        indicator.remove()
        this.thinkingIndicators.delete(sessionId)
      }
    } else {
      for (const indicator of this.thinkingIndicators.values()) {
        indicator.remove()
      }
      this.thinkingIndicators.clear()
    }
  }

  private removeEmptyState(): void {
    const empty = document.getElementById('feed-empty')
    if (empty) empty.remove()
  }

  // ============================================================================
  // Core: Process events into task model
  // ============================================================================

  add(event: ClaudeEvent, sessionColor?: number): void {
    if (!this.feedEl) return
    if (this.eventIds.has(event.id)) return
    this.eventIds.add(event.id)

    this.removeEmptyState()

    switch (event.type) {
      case 'user_prompt_submit':
        this.handlePrompt(event, sessionColor)
        break
      case 'pre_tool_use':
        this.handlePreTool(event as PreToolUseEvent)
        break
      case 'post_tool_use':
        this.handlePostTool(event as PostToolUseEvent)
        break
      case 'stop':
        this.handleStop(event)
        break
    }
  }

  // ── user_prompt_submit → new task ──

  private handlePrompt(event: ClaudeEvent, sessionColor?: number): void {
    const e = event as { prompt?: string; timestamp: number; sessionId: string; id: string }
    const prompt = e.prompt ?? ''

    // Skip duplicate prompts
    if (this.tasks.length > 0) {
      const last = this.tasks[this.tasks.length - 1]
      if (last.prompt === prompt && last.sessionId === event.sessionId) return
    }

    const task: TaskSummary = {
      id: event.id,
      prompt,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      status: 'working',
      tools: [],
      subTasks: [],
      filesChanged: new Set(),
      filesRead: new Set(),
    }

    this.tasks.push(task)
    this.currentTaskId = task.id

    const card = this.createTaskCard(task, sessionColor)
    this.taskElements.set(task.id, card)

    const shouldScroll = this.isNearBottom()
    this.feedEl!.appendChild(card)

    if (this.activeFilter !== null && event.sessionId !== this.activeFilter) {
      card.style.display = 'none'
    } else if (shouldScroll) {
      this.scrollToBottom()
    }

    this.updateScrollButton()
  }

  // ── pre_tool_use → add tool to current task ──

  private handlePreTool(event: PreToolUseEvent): void {
    const task = this.findTaskForSession(event.sessionId)
    if (!task) return

    const input = event.toolInput as Record<string, unknown>
    const filePath = (input.file_path as string) ?? (input.path as string) ?? ''
    const command = (input.command as string) ?? ''

    // Track files
    if (filePath) {
      const writingTools = ['Write', 'Edit', 'NotebookEdit']
      if (writingTools.includes(event.tool)) {
        task.filesChanged.add(filePath)
      } else {
        task.filesRead.add(filePath)
      }
    }

    // Sub-task branch (Task/Agent tool)
    if (event.tool === 'Task' || event.tool === 'Agent') {
      const desc = (input.description as string) ?? (input.prompt as string) ?? 'Sub-task'
      task.subTasks.push({
        toolUseId: event.toolUseId,
        description: desc.slice(0, 120),
        status: 'running',
      })
      this.rerenderTask(task)
      return
    }

    const toolEntry: TaskTool = {
      tool: event.tool,
      toolUseId: event.toolUseId,
      file: filePath ? this.shortenPath(filePath) : undefined,
      command: command ? command.slice(0, 100) : undefined,
    }

    // Check if completion data arrived early
    const completed = this.completedData.get(event.toolUseId)
    if (completed) {
      toolEntry.success = completed.success
      toolEntry.duration = completed.duration
      this.completedData.delete(event.toolUseId)
    }

    task.tools.push(toolEntry)

    // Show assistant text if present
    if (event.assistantText?.trim()) {
      const now = Date.now()
      const isDup = this.lastAssistantText === event.assistantText &&
        (now - this.lastAssistantTextTime) < 2000
      if (!isDup) {
        this.lastAssistantText = event.assistantText
        this.lastAssistantTextTime = now
        // Store on the task for display
        ;(task as any)._lastAssistantText = event.assistantText
      }
    }

    this.rerenderTask(task)
  }

  // ── post_tool_use → update tool status ──

  private handlePostTool(event: PostToolUseEvent): void {
    const task = this.findTaskForSession(event.sessionId)
    if (!task) {
      // Store for when pre arrives
      this.completedData.set(event.toolUseId, { success: event.success, duration: event.duration })
      return
    }

    // Check sub-tasks first
    const subTask = task.subTasks.find(s => s.toolUseId === event.toolUseId)
    if (subTask) {
      subTask.status = 'done'
      this.rerenderTask(task)
      return
    }

    // Update tool entry
    const tool = task.tools.find(t => t.toolUseId === event.toolUseId)
    if (tool) {
      tool.success = event.success
      tool.duration = event.duration
      this.rerenderTask(task)
    } else {
      // Pre hasn't arrived yet — store
      this.completedData.set(event.toolUseId, { success: event.success, duration: event.duration })
    }
  }

  // ── stop → mark task done ──

  private handleStop(event: ClaudeEvent): void {
    const e = event as { response?: string; sessionId: string }
    const task = this.findTaskForSession(e.sessionId)
    if (!task) return

    task.status = 'done'
    task.response = e.response?.trim() || undefined
    this.rerenderTask(task)
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private findTaskForSession(sessionId: string): TaskSummary | null {
    // Find the most recent working task for this session, or the latest one
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      if (this.tasks[i].sessionId === sessionId) {
        return this.tasks[i]
      }
    }
    return null
  }

  // ============================================================================
  // Rendering
  // ============================================================================

  private createTaskCard(task: TaskSummary, sessionColor?: number): HTMLElement {
    const card = document.createElement('div')
    card.className = 'task-card'
    card.dataset.taskId = task.id
    card.dataset.sessionId = task.sessionId

    if (sessionColor !== undefined) {
      card.style.setProperty('--session-color', `#${sessionColor.toString(16).padStart(6, '0')}`)
    }

    this.fillTaskCard(card, task)
    return card
  }

  private rerenderTask(task: TaskSummary): void {
    const card = this.taskElements.get(task.id)
    if (!card) return

    const shouldScroll = this.isNearBottom()
    this.fillTaskCard(card, task)

    if (shouldScroll) {
      this.scrollToBottom()
    }
  }

  private fillTaskCard(card: HTMLElement, task: TaskSummary): void {
    const isDone = task.status === 'done'
    const statusIcon = isDone ? '✅' : '🔵'
    const statusClass = isDone ? 'done' : 'working'

    // Prompt (truncated)
    const promptShort = task.prompt.length > 150
      ? task.prompt.slice(0, 150) + '...'
      : task.prompt

    // Tool summary
    const toolCount = task.tools.length
    const successCount = task.tools.filter(t => t.success === true).length
    const failCount = task.tools.filter(t => t.success === false).length
    const pendingCount = task.tools.filter(t => t.success === undefined).length

    // Files summary
    const changedFiles = [...task.filesChanged]
    const readFiles = [...task.filesRead].filter(f => !task.filesChanged.has(f))

    // Sub-tasks
    const branches = task.subTasks.length
    const branchesRunning = task.subTasks.filter(s => s.status === 'running').length
    const branchesDone = task.subTasks.filter(s => s.status === 'done').length

    // Time
    const timeStr = new Date(task.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    // Build HTML
    let html = `
      <div class="task-header ${statusClass}">
        <span class="task-status">${statusIcon}</span>
        <span class="task-prompt">${escapeHtml(promptShort)}</span>
        <span class="task-time">${timeStr}</span>
      </div>
    `

    // Progress bar (only when working)
    if (!isDone && toolCount > 0) {
      html += `
        <div class="task-progress">
          <div class="task-progress-bar">
            <div class="task-progress-fill" style="width: ${pendingCount > 0 ? '100' : '100'}%"></div>
          </div>
          <span class="task-progress-label">${toolCount} tool${toolCount !== 1 ? 's' : ''} used</span>
        </div>
      `
    }

    // Tool pills (compact)
    if (toolCount > 0) {
      const toolGroups = this.groupTools(task.tools)
      const pillsHtml = toolGroups.map(g => {
        const icon = getToolIcon(g.tool)
        const statusCls = g.allSuccess ? 'pill-ok' : g.anyFail ? 'pill-fail' : 'pill-pending'
        return `<span class="tool-pill ${statusCls}" title="${g.tool}: ${g.count}x">${icon} ${g.tool}${g.count > 1 ? ` ×${g.count}` : ''}</span>`
      }).join('')

      html += `<div class="task-tools">${pillsHtml}</div>`
    }

    // Files touched
    if (changedFiles.length > 0 || readFiles.length > 0) {
      let filesHtml = ''
      if (changedFiles.length > 0) {
        const fileList = changedFiles.slice(0, 5).map(f => escapeHtml(this.shortenPath(f))).join(', ')
        const more = changedFiles.length > 5 ? ` +${changedFiles.length - 5}` : ''
        filesHtml += `<span class="task-files-changed" title="Files modified">✏️ ${fileList}${more}</span>`
      }
      if (readFiles.length > 0) {
        const count = readFiles.length
        filesHtml += `<span class="task-files-read" title="${count} files read">📖 ${count} file${count !== 1 ? 's' : ''} read</span>`
      }
      html += `<div class="task-files">${filesHtml}</div>`
    }

    // Sub-task branches
    if (branches > 0) {
      const branchItems = task.subTasks.map(s => {
        const icon = s.status === 'done' ? '✅' : '⏳'
        return `<div class="task-branch">${icon} ${escapeHtml(s.description)}</div>`
      }).join('')

      html += `
        <div class="task-branches">
          <div class="task-branches-header" data-task-id="${task.id}">
            🌿 ${branches} branch${branches !== 1 ? 'es' : ''} (${branchesDone} done${branchesRunning > 0 ? `, ${branchesRunning} running` : ''})
          </div>
          <div class="task-branches-list" id="branches-${task.id}">
            ${branchItems}
          </div>
        </div>
      `
    }

    // Response summary (when done)
    if (isDone && task.response) {
      const responseShort = task.response.length > 300
        ? task.response.slice(0, 300) + '...'
        : task.response
      html += `
        <div class="task-response">
          <div class="task-response-text">${renderMarkdown(responseShort)}</div>
        </div>
      `
    }

    // Stats footer
    if (toolCount > 0 || branches > 0) {
      const parts: string[] = []
      if (toolCount > 0) parts.push(`${successCount}/${toolCount} tools`)
      if (failCount > 0) parts.push(`${failCount} failed`)
      if (branches > 0) parts.push(`${branches} branches`)
      html += `<div class="task-footer">${parts.join(' · ')}</div>`
    }

    card.innerHTML = html
    card.className = `task-card ${statusClass}`
    card.dataset.taskId = task.id
    card.dataset.sessionId = task.sessionId

    // Attach branch toggle
    const branchHeader = card.querySelector('.task-branches-header')
    if (branchHeader) {
      branchHeader.addEventListener('click', () => {
        const list = card.querySelector('.task-branches-list')
        if (list) list.classList.toggle('collapsed')
      })
    }
  }

  private groupTools(tools: TaskTool[]): Array<{ tool: string; count: number; allSuccess: boolean; anyFail: boolean }> {
    const groups = new Map<string, { count: number; allSuccess: boolean; anyFail: boolean }>()
    for (const t of tools) {
      const g = groups.get(t.tool) ?? { count: 0, allSuccess: true, anyFail: false }
      g.count++
      if (t.success !== true) g.allSuccess = false
      if (t.success === false) g.anyFail = true
      groups.set(t.tool, g)
    }
    return [...groups.entries()].map(([tool, g]) => ({ tool, ...g }))
  }
}

// ============================================================================
// Helper Functions (pure, stateless) — preserved exports
// ============================================================================

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`
  return `${tokens} tok`
}

export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 30) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

export function renderMarkdown(text: string): string {
  let html = escapeHtml(text)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
  html = html.replace(/\n/g, '<br>')
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_match, code) => {
    return '<pre><code>' + code.replace(/<br>/g, '\n') + '</code></pre>'
  })
  return html
}
