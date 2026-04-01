/**
 * DirectoryAutocomplete - Autocomplete for directory paths
 *
 * Fetches suggestions from the server (known projects + filesystem)
 * and shows a dropdown with keyboard navigation.
 */

// Injected by Vite at build time
declare const __VIBECRAFT_DEFAULT_PORT__: number
const API_PORT = __VIBECRAFT_DEFAULT_PORT__
const API_URL = `http://localhost:${API_PORT}`

interface AutocompleteItem {
  path: string
  name: string
  type?: 'session' | 'project'
  status?: string
}

/**
 * Setup directory autocomplete on an input element
 */
export function setupDirectoryAutocomplete(
  input: HTMLInputElement,
  onSelect?: (path: string) => void
): () => void {
  let dropdown: HTMLElement | null = null
  let selectedIndex = 0
  let items: AutocompleteItem[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const createDropdown = () => {
    if (dropdown) return dropdown

    dropdown = document.createElement('div')
    dropdown.className = 'directory-autocomplete-dropdown'
    dropdown.style.cssText = `
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 300px;
      overflow-y: auto;
      background: rgba(20, 20, 25, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      margin-top: 4px;
      display: none;
      z-index: 1001;
      backdrop-filter: blur(8px);
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.25) transparent;
    `
    // Ensure parent has relative positioning
    const parent = input.parentElement
    if (parent) {
      parent.style.position = 'relative'
      parent.appendChild(dropdown)
    }
    return dropdown
  }

  const renderDropdown = () => {
    const dd = createDropdown()
    if (items.length === 0) {
      dd.style.display = 'none'
      return
    }

    dd.innerHTML = items.map((item, i) => {
      const shortPath = shortenPath(item.path)
      const isSession = item.type === 'session'
      const badge = isSession
        ? `<span class="dir-badge session">${statusDot(item.status)} session</span>`
        : ''

      return `
        <div class="dir-item${i === selectedIndex ? ' selected' : ''}${isSession ? ' is-session' : ''}" data-index="${i}">
          <div class="dir-item-header">
            <span class="dir-name">${escapeHtml(item.name)}</span>
            ${badge}
          </div>
          <span class="dir-path">${escapeHtml(shortPath)}</span>
        </div>
      `
    }).join('')

    // Style items
    dd.querySelectorAll('.dir-item').forEach((el) => {
      const item = el as HTMLElement
      item.style.cssText = `
        padding: 10px 12px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        transition: background 0.1s;
      `
      if (item.classList.contains('selected')) {
        item.style.background = 'rgba(167, 139, 250, 0.25)'
      }
      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(255,255,255,0.08)'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = item.classList.contains('selected')
          ? 'rgba(167, 139, 250, 0.25)'
          : ''
      })
    })

    dd.querySelectorAll('.dir-item-header').forEach((el) => {
      (el as HTMLElement).style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      `
    })

    dd.querySelectorAll('.dir-name').forEach((el) => {
      (el as HTMLElement).style.cssText = `
        color: #c4b5fd;
        font-weight: 600;
        font-size: 13px;
      `
    })

    dd.querySelectorAll('.dir-badge').forEach((el) => {
      (el as HTMLElement).style.cssText = `
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        background: rgba(56, 189, 248, 0.15);
        color: #7dd3fc;
        white-space: nowrap;
        flex-shrink: 0;
      `
    })

    dd.querySelectorAll('.dir-path').forEach((el) => {
      (el as HTMLElement).style.cssText = `
        color: rgba(255, 255, 255, 0.4);
        font-size: 11px;
        font-family: ui-monospace, monospace;
      `
    })

    dd.style.display = 'block'

    // Scroll selected into view
    const selectedEl = dd.querySelector('.selected')
    selectedEl?.scrollIntoView({ block: 'nearest' })
  }

  const hideDropdown = () => {
    if (dropdown) {
      dropdown.style.display = 'none'
    }
    items = []
    selectedIndex = 0
  }

  const selectResult = (item: AutocompleteItem) => {
    input.value = item.path
    input.focus()
    hideDropdown()
    // Trigger input event so name auto-fill works
    input.dispatchEvent(new Event('input', { bubbles: true }))
    onSelect?.(item.path)
  }

  const fetchResults = async (query: string) => {
    try {
      const response = await fetch(`${API_URL}/projects/autocomplete?q=${encodeURIComponent(query)}`)
      const data = await response.json()
      if (data.ok && Array.isArray(data.items)) {
        items = data.items
        selectedIndex = 0
        renderDropdown()
      } else if (data.ok && Array.isArray(data.results)) {
        // Fallback for old API format
        items = data.results.map((path: string) => ({
          path,
          name: path.replace(/\/+$/, '').split('/').pop() || path,
        }))
        selectedIndex = 0
        renderDropdown()
      }
    } catch (e) {
      // Silently fail - autocomplete is a nice-to-have
      console.error('Autocomplete fetch error:', e)
    }
  }

  const handleInput = () => {
    const value = input.value

    // Debounce API calls
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    if (value.length === 0) {
      // Show all known projects when empty
      debounceTimer = setTimeout(() => fetchResults(''), 100)
    } else {
      debounceTimer = setTimeout(() => fetchResults(value), 150)
    }
  }

  const handleFocus = () => {
    // Show suggestions on focus if empty or has value
    handleInput()
  }

  const handleKeydown = (e: KeyboardEvent) => {
    if (items.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        selectedIndex = (selectedIndex + 1) % items.length
        renderDropdown()
        break

      case 'ArrowUp':
        e.preventDefault()
        selectedIndex = (selectedIndex - 1 + items.length) % items.length
        renderDropdown()
        break

      case 'Tab':
        if (items.length > 0) {
          e.preventDefault()
          selectResult(items[selectedIndex])
        }
        break

      case 'Enter':
        if (items.length > 0 && dropdown?.style.display !== 'none') {
          e.preventDefault()
          e.stopPropagation()
          selectResult(items[selectedIndex])
        }
        break

      case 'Escape':
        hideDropdown()
        break
    }
  }

  const handleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const item = target.closest('.dir-item') as HTMLElement
    if (item) {
      const index = parseInt(item.dataset.index || '0', 10)
      selectResult(items[index])
    }
  }

  const handleBlur = (e: FocusEvent) => {
    // Delay to allow click events to fire on dropdown
    setTimeout(() => {
      // Only hide if focus didn't go to the dropdown
      if (!dropdown?.contains(document.activeElement)) {
        hideDropdown()
      }
    }, 150)
  }

  // Attach listeners
  input.addEventListener('input', handleInput)
  input.addEventListener('focus', handleFocus)
  input.addEventListener('keydown', handleKeydown)
  input.addEventListener('blur', handleBlur)
  createDropdown().addEventListener('click', handleClick)

  // Return cleanup function
  return () => {
    input.removeEventListener('input', handleInput)
    input.removeEventListener('focus', handleFocus)
    input.removeEventListener('keydown', handleKeydown)
    input.removeEventListener('blur', handleBlur)
    if (debounceTimer) clearTimeout(debounceTimer)
    dropdown?.remove()
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Shorten an absolute path for display (replace home dir with ~) */
function shortenPath(path: string): string {
  // Match /Users/xxx or /home/xxx prefix
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

/**
 * Setup the native OS directory picker (Browse button).
 * Calls /choose-directory on the server which opens macOS Finder dialog.
 */
export function setupBrowseButton(
  button: HTMLElement,
  input: HTMLInputElement,
  onSelect?: (path: string) => void,
): void {
  let picking = false

  button.addEventListener('click', async () => {
    if (picking) return
    picking = true
    button.classList.add('picking')

    try {
      const response = await fetch(`${API_URL}/choose-directory`)
      const data = await response.json()
      if (data.ok && data.path) {
        input.value = data.path
        input.dispatchEvent(new Event('input', { bubbles: true }))
        onSelect?.(data.path)
      }
    } catch {
      // Server unreachable or error
    } finally {
      picking = false
      button.classList.remove('picking')
    }
  })
}

/** Status dot for session items */
function statusDot(status?: string): string {
  const colors: Record<string, string> = {
    working: '#22d3ee',
    idle: '#4ade80',
    offline: '#f87171',
    waiting: '#fbbf24',
  }
  const color = colors[status || ''] || '#94a3b8'
  return `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};margin-right:3px;"></span>`
}
