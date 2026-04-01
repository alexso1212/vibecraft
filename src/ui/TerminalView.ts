/**
 * TerminalView - Embeds a real terminal (xterm.js) in VibeCraft's feed area
 *
 * Connects to the server's TerminalBridge via WebSocket to mirror
 * the tmux session running Claude Code.
 */

import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'xterm/css/xterm.css'

export class TerminalView {
  private terminal: Terminal
  private fitAddon: FitAddon
  private containerEl: HTMLElement
  private feedWrapperEl: HTMLElement
  private ws: WebSocket | null = null
  private currentSessionId: string | null = null
  private visible = false
  private resizeObserver: ResizeObserver

  // Callbacks for WebSocket message sending
  private sendMessage: (msg: Record<string, unknown>) => void

  constructor(
    containerEl: HTMLElement,
    feedWrapperEl: HTMLElement,
    sendMessage: (msg: Record<string, unknown>) => void,
  ) {
    this.containerEl = containerEl
    this.feedWrapperEl = feedWrapperEl
    this.sendMessage = sendMessage

    this.terminal = new Terminal({
      theme: {
        background: '#0a0a0f',
        foreground: '#e4e4e8',
        cursor: '#58a6ff',
        cursorAccent: '#0a0a0f',
        selectionBackground: 'rgba(88, 166, 255, 0.3)',
        black: '#1a1a2e',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#ffd43b',
        blue: '#58a6ff',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e8',
        brightBlack: '#4a4a5e',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#74b9ff',
        brightMagenta: '#d4a0ff',
        brightCyan: '#45e8f0',
        brightWhite: '#ffffff',
      },
      fontSize: 13,
      fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", Menlo, monospace',
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
    })

    this.fitAddon = new FitAddon()
    this.terminal.loadAddon(this.fitAddon)

    // Forward keyboard input to server
    this.terminal.onData((data) => {
      if (this.currentSessionId) {
        this.sendMessage({
          type: 'terminal_input',
          payload: { sessionId: this.currentSessionId, data },
        })
      }
    })

    // Auto-fit on resize
    this.resizeObserver = new ResizeObserver(() => {
      if (this.visible) {
        this.fit()
      }
    })
    this.resizeObserver.observe(containerEl)
  }

  /**
   * Show terminal view, hide feed
   */
  show(): void {
    this.visible = true
    this.containerEl.classList.remove('hidden')
    this.feedWrapperEl.style.display = 'none'

    // Initialize terminal in DOM if not done
    const outputEl = this.containerEl.querySelector('#terminal-output')
    if (outputEl && !outputEl.querySelector('.xterm')) {
      this.terminal.open(outputEl as HTMLElement)
    }

    // Fit after showing
    requestAnimationFrame(() => this.fit())
  }

  /**
   * Hide terminal view, show feed
   */
  hide(): void {
    this.visible = false
    this.containerEl.classList.add('hidden')
    this.feedWrapperEl.style.display = ''
    this.detach()
  }

  /**
   * Attach to a managed session's tmux terminal
   */
  attach(managedSessionId: string): void {
    // Detach from previous session
    if (this.currentSessionId && this.currentSessionId !== managedSessionId) {
      this.sendMessage({
        type: 'terminal_detach',
        payload: { sessionId: this.currentSessionId },
      })
    }

    this.currentSessionId = managedSessionId
    this.terminal.clear()

    // Request server to attach PTY
    this.sendMessage({
      type: 'terminal_attach',
      payload: { sessionId: managedSessionId },
    })

    // Send initial size
    requestAnimationFrame(() => {
      this.fit()
    })
  }

  /**
   * Detach from current session
   */
  detach(): void {
    if (this.currentSessionId) {
      this.sendMessage({
        type: 'terminal_detach',
        payload: { sessionId: this.currentSessionId },
      })
      this.currentSessionId = null
    }
  }

  /**
   * Handle incoming WebSocket message (called from main event client)
   */
  handleMessage(msg: { type: string; sessionId?: string; data?: string; exitCode?: number }): void {
    if (msg.type === 'terminal_output' && msg.sessionId === this.currentSessionId && msg.data) {
      this.terminal.write(msg.data)
    } else if (msg.type === 'terminal_exit' && msg.sessionId === this.currentSessionId) {
      this.terminal.writeln('\r\n\x1b[90m[Terminal disconnected]\x1b[0m')
    }
  }

  /**
   * Fit terminal to container
   */
  fit(): void {
    try {
      this.fitAddon.fit()
      // Notify server of new size
      if (this.currentSessionId) {
        this.sendMessage({
          type: 'terminal_resize',
          payload: {
            sessionId: this.currentSessionId,
            cols: this.terminal.cols,
            rows: this.terminal.rows,
          },
        })
      }
    } catch {
      // Ignore fit errors when not visible
    }
  }

  /**
   * Focus the terminal input
   */
  focus(): void {
    this.terminal.focus()
  }

  /**
   * Check if terminal view is currently visible
   */
  isVisible(): boolean {
    return this.visible
  }

  /**
   * Get the current attached session ID
   */
  getSessionId(): string | null {
    return this.currentSessionId
  }

  /**
   * Clean up
   */
  dispose(): void {
    this.resizeObserver.disconnect()
    this.detach()
    this.terminal.dispose()
  }
}
