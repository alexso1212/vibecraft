/**
 * TerminalBridge - Bridges tmux sessions to WebSocket clients via node-pty
 *
 * Each managed session can have one active PTY attached to its tmux session.
 * Multiple browser clients can connect to the same PTY (shared view).
 */

import * as pty from 'node-pty'
import type { WebSocket } from 'ws'

interface TerminalSession {
  ptyProcess: pty.IPty
  clients: Set<WebSocket>
  tmuxSession: string
}

export class TerminalBridge {
  private sessions = new Map<string, TerminalSession>()

  /**
   * Attach a WebSocket client to a tmux session's PTY
   */
  attach(managedSessionId: string, tmuxSession: string, ws: WebSocket): void {
    let session = this.sessions.get(managedSessionId)

    if (session) {
      // PTY already running, just add this client
      session.clients.add(ws)
    } else {
      // Spawn new PTY attached to tmux
      const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSession], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.env.HOME ?? '/',
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
      })

      session = {
        ptyProcess,
        clients: new Set([ws]),
        tmuxSession,
      }

      // Forward PTY output to all connected clients
      ptyProcess.onData((data: string) => {
        const msg = JSON.stringify({ type: 'terminal_output', sessionId: managedSessionId, data })
        for (const client of session!.clients) {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(msg)
          }
        }
      })

      ptyProcess.onExit(({ exitCode }) => {
        // Notify clients that terminal closed
        const msg = JSON.stringify({ type: 'terminal_exit', sessionId: managedSessionId, exitCode })
        for (const client of session!.clients) {
          if (client.readyState === 1) {
            client.send(msg)
          }
        }
        this.sessions.delete(managedSessionId)
      })

      this.sessions.set(managedSessionId, session)
    }

    // When this client disconnects, clean up
    ws.on('close', () => {
      this.detachClient(managedSessionId, ws)
    })
  }

  /**
   * Send input from a client to the PTY
   */
  write(managedSessionId: string, data: string): void {
    const session = this.sessions.get(managedSessionId)
    if (session) {
      session.ptyProcess.write(data)
    }
  }

  /**
   * Resize the PTY
   */
  resize(managedSessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(managedSessionId)
    if (session) {
      session.ptyProcess.resize(cols, rows)
    }
  }

  /**
   * Detach a single client
   */
  detachClient(managedSessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(managedSessionId)
    if (!session) return

    session.clients.delete(ws)

    // If no clients left, kill the PTY (detach from tmux)
    if (session.clients.size === 0) {
      session.ptyProcess.kill()
      this.sessions.delete(managedSessionId)
    }
  }

  /**
   * Detach all clients and kill PTY for a session
   */
  destroy(managedSessionId: string): void {
    const session = this.sessions.get(managedSessionId)
    if (!session) return

    session.ptyProcess.kill()
    this.sessions.delete(managedSessionId)
  }

  /**
   * Check if a session has an active PTY
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
