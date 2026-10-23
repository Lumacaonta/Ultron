import { useEffect, useMemo, useState } from 'react'
import { BACKEND_ORIGIN as BACKEND } from '../auth.js'

function formatDate(value) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return 'UNKNOWN'

  return date.toLocaleString('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).toUpperCase()
}

function formatSize(bytes) {
  const value = Number(bytes || 0)

  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function MemoryOffline({ onOpenSettings }) {
  return (
    <section className="memory-workspace memory-offline">
      <div className="memory-offline-core">
        <span>VAULT LINK // OFFLINE</span>
        <h2>Obsidian memory is not connected.</h2>
        <p>Connect a local vault to inspect its real Markdown files, search their contents and open each note here.</p>
        <button type="button" className="memory-primary" onClick={onOpenSettings}>
          CONNECT OBSIDIAN VAULT
        </button>
      </div>
    </section>
  )
}

export default function MemoryPage({
  obsidianStatus,
  obsidianGraph,
  onOpenSettings,
}) {
  if (!obsidianStatus?.connected) {
    return <MemoryOffline onOpenSettings={onOpenSettings} />
  }

  return (
    <ConnectedMemoryPage
      obsidianStatus={obsidianStatus}
      obsidianGraph={obsidianGraph}
    />
  )
}

function ConnectedMemoryPage({
  obsidianStatus,
  obsidianGraph,
}) {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState([])
  const [total, setTotal] = useState(0)
  const [fileFilter, setFileFilter] = useState('all')
  const [selectedPath, setSelectedPath] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [error, setError] = useState('')

  const graphNodes = Array.isArray(obsidianGraph?.nodes)
    ? obsidianGraph.nodes.length
    : 0
  const graphEdges = Array.isArray(obsidianGraph?.edges)
    ? obsidianGraph.edges.length
    : 0

  const selectedListItem = useMemo(
    () => files.find(file => file.path === selectedPath) || null,
    [files, selectedPath]
  )

  const filterCounts = useMemo(() => ({
    all: files.length,
    tagged: files.filter(file => Array.isArray(file.tags) && file.tags.length > 0).length,
    linked: files.filter(file => Number(file.linkCount || 0) > 0).length,
  }), [files])

  const visibleFiles = useMemo(() => {
    if (fileFilter === 'tagged') {
      return files.filter(file => Array.isArray(file.tags) && file.tags.length > 0)
    }

    if (fileFilter === 'linked') {
      return files.filter(file => Number(file.linkCount || 0) > 0)
    }

    return files
  }, [fileFilter, files])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const timer = window.setTimeout(async () => {
      setLoadingFiles(true)
      setError('')

      try {
        const response = await fetch(
          `${BACKEND}/api/obsidian/files?q=${encodeURIComponent(query)}&limit=120`,
          { signal: controller.signal }
        )
        const result = await response.json().catch(() => ({}))

        if (!response.ok || !result.ok) {
          throw new Error(result.detail || result.error || 'Unable to index the vault.')
        }

        if (cancelled) return

        const nextFiles = Array.isArray(result.files) ? result.files : []
        setFiles(nextFiles)
        setTotal(Number(result.total || 0))
        setSelectedPath(current => {
          if (nextFiles.some(file => file.path === current)) return current
          return nextFiles[0]?.path || ''
        })
      } catch (requestError) {
        if (!cancelled && requestError.name !== 'AbortError') {
          setError(requestError.message || 'Unable to index the vault.')
          setFiles([])
          setTotal(0)
        }
      } finally {
        if (!cancelled) setLoadingFiles(false)
      }
    }, query ? 160 : 0)

    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [query, obsidianStatus?.path])

  useEffect(() => {
    if (!selectedPath) return undefined

    let cancelled = false
    const controller = new AbortController()

    async function loadSelectedFile() {
      setLoadingFile(true)
      setError('')

      try {
        const response = await fetch(
          `${BACKEND}/api/obsidian/file?path=${encodeURIComponent(selectedPath)}`,
          { signal: controller.signal }
        )
        const result = await response.json().catch(() => ({}))

        if (!response.ok || !result.ok || !result.file) {
          throw new Error(result.detail || result.error || 'Unable to read this note.')
        }

        if (!cancelled) setSelectedFile(result.file)
      } catch (requestError) {
        if (!cancelled && requestError.name !== 'AbortError') {
          setError(requestError.message || 'Unable to read this note.')
          setSelectedFile(null)
        }
      } finally {
        if (!cancelled) setLoadingFile(false)
      }
    }

    void loadSelectedFile()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [selectedPath])

  const activeSelectedFile = selectedFile?.path === selectedPath
    ? selectedFile
    : null
  const note = activeSelectedFile || selectedListItem
  const selectedTags = Array.isArray(note?.tags) ? note.tags : []
  const selectedLinkCount = Number(note?.linkCount || 0)
  const indexIntegrity = loadingFiles
    ? 'SCANNING'
    : error
      ? 'CHECK LINK'
      : 'STABLE'

  return (
    <section className="memory-workspace">
      <header className="memory-command-header">
        <div>
          <span>KNOWLEDGE VAULT // LOCAL INDEX</span>
          <h2>Vault Control Center</h2>
          <p>{obsidianStatus.path}</p>
        </div>
        <div className="memory-status-cluster">
          <div><strong>{obsidianStatus.markdown_count || 0}</strong><span>NOTES</span></div>
          <div><strong>{graphNodes}</strong><span>NODES</span></div>
          <div><strong>{graphEdges}</strong><span>LINKS</span></div>
        </div>
      </header>

      <section className="memory-intel-strip" aria-label="Vault intelligence status">
        <div className="memory-intel-cell memory-integrity-cell">
          <span>INDEX INTEGRITY</span>
          <strong data-state={indexIntegrity.toLowerCase().replace(' ', '-')}>{indexIntegrity}</strong>
          <small>{loadingFiles ? 'Rebuilding local index' : `${total || 0} records available`}</small>
        </div>
        <div className="memory-intel-cell">
          <span>VAULT NOTES</span>
          <strong>{obsidianStatus.markdown_count || 0}</strong>
          <small>{filterCounts.tagged} tagged dossiers</small>
        </div>
        <div className="memory-intel-cell">
          <span>GRAPH LINKS</span>
          <strong>{graphEdges}</strong>
          <small>{graphNodes} indexed entities</small>
        </div>
      </section>

      <div className="memory-browser">
        <aside className="memory-file-rail">
          <header className="memory-rail-head">
            <div>
              <span>LOCAL ARCHIVE</span>
              <h3>Vault Control</h3>
            </div>
            <div className="memory-rail-signal" title="Vault connected" aria-label="Vault connected" />
          </header>

          <nav className="memory-filter-menu" aria-label="Memory file filters">
            {[
              ['all', 'ALL FILES', filterCounts.all],
              ['tagged', 'TAGGED', filterCounts.tagged],
              ['linked', 'LINKED', filterCounts.linked],
            ].map(([filter, label, count]) => (
              <button
                key={filter}
                type="button"
                className={fileFilter === filter ? 'active' : ''}
                aria-pressed={fileFilter === filter}
                onClick={() => setFileFilter(filter)}
              >
                <span>{label}</span>
                <strong>{count}</strong>
              </button>
            ))}
          </nav>

          <label className="memory-search">
            <span>SEARCH VAULT</span>
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Name, path or text…"
            />
          </label>

          <div className="memory-file-summary">
            <span>{loadingFiles ? 'SCANNING…' : `${visibleFiles.length} DISPLAYED // ${total} MATCHES`}</span>
            {query && <button type="button" onClick={() => setQuery('')}>CLEAR</button>}
          </div>

          <div className="memory-file-list">
            {visibleFiles.map(file => (
              <button
                key={file.path}
                type="button"
                className={file.path === selectedPath ? 'active' : ''}
                onClick={() => setSelectedPath(file.path)}
              >
                <strong>{file.name}</strong>
                <span>{file.path}</span>
                <small>
                  {formatDate(file.modifiedAt)} · {formatSize(file.size)}
                  {Number(file.linkCount || 0) > 0 ? ` · ${file.linkCount} LINKS` : ''}
                </small>
              </button>
            ))}
            {!loadingFiles && !visibleFiles.length && (
              <div className="memory-empty-list">NO DOSSIERS MATCH THIS FILTER</div>
            )}
          </div>
        </aside>

        <article className="memory-note-viewer">
          {error && <div className="memory-error">{error}</div>}

          {note ? (
            <>
              <header className="memory-note-head memory-dossier-head">
                <div>
                  <span>SELECTED DOSSIER</span>
                  <h3>{note.name}</h3>
                  <p>{note.path}</p>
                </div>
                <div className="memory-note-meta memory-dossier-meta">
                  <span><small>MODIFIED</small>{formatDate(note.modifiedAt)}</span>
                  <span><small>VOLUME</small>{formatSize(note.size)}</span>
                  <span><small>RELATIONS</small>{selectedLinkCount} LINKS</span>
                </div>
              </header>

              <section className="memory-dossier-signals" aria-label="Selected dossier signals">
                <div className="memory-signal-group">
                  <span>TAG SIGNALS</span>
                  <div className="memory-tags">
                    {selectedTags.length > 0
                      ? selectedTags.map(tag => <span key={tag}>#{tag}</span>)
                      : <em>NO TAGS DETECTED</em>}
                  </div>
                </div>
                <div className="memory-signal-group memory-link-signal">
                  <span>LINK SIGNAL</span>
                  <strong>{selectedLinkCount > 0 ? `${selectedLinkCount} ACTIVE` : 'NO LINKS'}</strong>
                </div>
                <div className="memory-signal-group memory-size-signal">
                  <span>DATA MASS</span>
                  <strong>{formatSize(note.size)}</strong>
                </div>
              </section>

              <div className="memory-note-content">
                {loadingFile
                  ? <div className="memory-reading">DECRYPTING NOTE DATA…</div>
                  : <pre>{activeSelectedFile?.content || note.preview || 'This note has no readable text.'}</pre>}
              </div>

              {activeSelectedFile?.truncated && (
                <p className="memory-truncated">Preview truncated after 160 KB.</p>
              )}
            </>
          ) : (
            <div className="memory-empty-viewer">SELECT A NOTE TO INSPECT ITS CONTENTS</div>
          )}
        </article>
      </div>
    </section>
  )
}
