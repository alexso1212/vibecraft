/**
 * TerminalBridge - Bridges tmux sessions to WebSocket clients via pipe-pane + send-keys
 *
 * Architecture:
 *   Output: tmux pipe-pane → log file → tail -f → broadcast to clients
 *   Input:  buffer keystrokes → tmux send-keys -H (hex encoded)
 *   Resize: tmux resize-window
 *
 * This avoids node-pty + tmux attach-session which does full-screen rendering
 * and breaks xterm.js native scrollback.
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { WebSocket } from 'ws'

interface TerminalSession {
  tmuxSession: string
  clients: Set<WebSocket>
  logFile: string
  tailProcess: ChildProcess | null
  inputBuffer: string
  inputTimer: ReturnType<typeof setTimeout> | null
}

const LOG_DIR = join(tmpdir(), 'vibecraft-terminal')

export class TerminalBridge {
  private sessions = new Map<string, TerminalSession>()

  constructor() {
    // Ensure log directory exists
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true })
    }
  }

  /**
   * Attach a WebSocket client to a tmux session
   */
  attach(managedSessionId: string, tmuxSession: string, ws: WebSocket): void {
    let session = this.sessions.get(managedSessionId)

    if (session) {
      // Session already running, add client and send existing log content
      session.clients.add(ws)
      this.sendLogHistory(session, ws)
    } else {
      const logFile = join(LOG_DIR, `${managedSessionId}.log`)

      // Clear any stale log file
      writeFileSync(logFile, '')

      session = {
        tmuxSession,
        clients: new Set([ws]),
        logFile,
        tailProcess: null,
        inputBuffer: '',
        inputTimer: null,
      }

      this.sessions.set(managedSessionId, session)

      // Send initial scrollback from tmux capture-pane
      this.sendScrollback(managedSessionId, tmuxSession, ws)

      // Start pipe-pane to capture raw output to log file
      try {
        execSync(
          `tmux pipe-pane -O -t ${JSON.stringify(tmuxSession)} 'cat >> ${JSON.stringify(logFile)}'`,
          { timeout: 3000 },
        )
      } catch {
        // pipe-pane failed, session may not exist
      }

      // Start tail -f to stream new output to clients
      this.startTail(managedSessionId, session)
    }

    // Clean up when client disconnects
    ws.on('close', () => {
      this.detachClient(managedSessionId, ws)
    })
  }

  /**
   * Start tail -f on the log file and broadcast output to clients
   */
  private startTail(managedSessionId: string, session: TerminalSession): void {
    // Use tail -f to follow the log file
    const tail = spawn('tail', ['-f', session.logFile], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    session.tailProcess = tail

    tail.stdout.on('data', (chunk: Buffer) => {
      const data = chunk.toString()
      const msg = JSON.stringify({
        type: 'terminal_output',
        sessionId: managedSessionId,
        data,
      })

      for (const client of session.clients) {
        if (client.readyState === 1) {
          client.send(msg)
        }
      }
    })

    tail.on('exit', () => {
      // If tail exits unexpectedly and session still exists, notify clients
      if (this.sessions.has(managedSessionId)) {
        const msg = JSON.stringify({
          type: 'terminal_exit',
          sessionId: managedSessionId,
          exitCode: 0,
        })
        for (const client of session.clients) {
          if (client.readyState === 1) {
            client.send(msg)
          }
        }
      }
    })
  }

  /**
   * Send existing log file content to a newly connected client
   */
  private sendLogHistory(session: TerminalSession, ws: WebSocket): void {
    try {
      if (existsSync(session.logFile)) {
        const content = readFileSync(session.logFile, 'utf8')
        if (content && ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'terminal_output',
            sessionId: [...this.sessions.entries()]
              .find(([, s]) => s === session)?.[0] ?? '',
            data: content,
          }))
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  /**
   * Capture tmux scrollback and send to client as initial content
   */
  private sendScrollback(managedSessionId: string, tmuxSession: string, ws: WebSocket): void {
    try {
      const history = execSync(
        `tmux capture-pane -p -e -S -2000 -t ${JSON.stringify(tmuxSession)}`,
        { encoding: 'utf8', timeout: 3000 },
      )
      if (history && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'terminal_output',
          sessionId: managedSessionId,
          data: history.replace(/\n/g, '\r\n'),
        }))
      }
    } catch {
      // Ignore - scrollback is a nice-to-have
    }
  }

  /**
   * Send input to the tmux pane using send-keys -H (hex encoded)
   * Batches rapid keystrokes for efficiency (~8ms window)
   */
  write(managedSessionId: string, data: string): void {
    const session = this.sessions.get(managedSessionId)
    if (!session) return

    session.inputBuffer += data

    // Clear existing timer and set new one for batching
    if (session.inputTimer) {
      clearTimeout(session.inputTimer)
    }

    session.inputTimer = setTimeout(() => {
      this.flushInput(session)
    }, 8)
  }

  /**
   * Flush buffered input to tmux as hex-encoded send-keys
   */
  private flushInput(session: TerminalSession): void {
    if (!session.inputBuffer) return

    const hex = Buffer.from(session.inputBuffer, 'utf8')
      .toString('hex')
      .match(/.{1,2}/g)!
      .join(' ')

    session.inputBuffer = ''
    session.inputTimer = null

    try {
      execSync(
        `tmux send-keys -t ${JSON.stringify(session.tmuxSession)} -H ${hex}`,
        { timeout: 3000 },
      )
    } catch {
      // Ignore send errors (session may have died)
    }
  }

  /**
   * Resize the tmux window
   */
  resize(managedSessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(managedSessionId)
    if (!session) return

    try {
      execSync(
        `tmux resize-window -t ${JSON.stringify(session.tmuxSession)} -x ${cols} -y ${rows}`,
        { timeout: 3000 },
      )
    } catch {
      // Ignore resize errors
    }
  }

  /**
   * Detach a single client
   */
  detachClient(managedSessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(managedSessionId)
    if (!session) return

    session.clients.delete(ws)

    // If no clients left, clean up everything
    if (session.clients.size === 0) {
      this.cleanup(managedSessionId, session)
    }
  }

  /**
   * Destroy a session (detach all clients and clean up)
   */
  destroy(managedSessionId: string): void {
    const session = this.sessions.get(managedSessionId)
    if (!session) return

    this.cleanup(managedSessionId, session)
  }

  /**
   * Clean up pipe-pane, tail process, and log file
   */
  private cleanup(managedSessionId: string, session: TerminalSession): void {
    // Stop pipe-pane
    try {
      execSync(
        `tmux pipe-pane -t ${JSON.stringify(session.tmuxSession)}`,
        { timeout: 3000 },
      )
    } catch {
      // Ignore - tmux session may already be gone
    }

    // Kill tail process
    if (session.tailProcess) {
      session.tailProcess.kill()
      session.tailProcess = null
    }

    // Clear input timer
    if (session.inputTimer) {
      clearTimeout(session.inputTimer)
      session.inputTimer = null
    }

    // Remove log file
    try {
      if (existsSync(session.logFile)) {
        unlinkSync(session.logFile)
      }
    } catch {
      // Ignore
    }

    this.sessions.delete(managedSessionId)
  }

  /**
   * Check if a session has an active terminal
   */
  isActive(managedSessionId: string): boolean {
    return this.sessions.has(managedSessionId)
  }

  /**
   * Clean up all sessions
   */
  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.destroy(id)
    }
  }
}
