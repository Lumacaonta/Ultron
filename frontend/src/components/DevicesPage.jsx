import { useCallback, useEffect, useState } from 'react'
import { BACKEND_ORIGIN as BACKEND } from '../auth.js'

function isKnownNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function clampPercent(value) {
  if (!isKnownNumber(value)) return null

  const numeric = Number(value)

  return Math.max(0, Math.min(100, numeric))
}

function formatPercent(value) {
  const numeric = clampPercent(value)
  return numeric === null ? '—' : `${numeric.toFixed(1)}%`
}

function formatStorage(value) {
  if (!isKnownNumber(value)) return '—'

  const numeric = Number(value)
  return `${numeric.toFixed(1)} GB`
}

function formatRate(value) {
  if (!isKnownNumber(value)) return '—'

  const numeric = Number(value)
  return `${numeric.toFixed(2)} Mbps`
}

function formatUptime(value) {
  if (!isKnownNumber(value)) return '—'

  const seconds = Number(value)

  if (seconds < 0) return '—'

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (days) return `${days}D ${hours}H`
  if (hours) return `${hours}H ${minutes}M`
  return `${minutes}M`
}

function statusLabel(connected, onlineLabel, offlineLabel) {
  return connected ? onlineLabel : offlineLabel
}

function StatusPip({ active = false }) {
  return <i className="device-status-pip" data-active={active ? 'true' : 'false'} />
}

function MiniSparkline({ values = [], label }) {
  const points = Array.isArray(values)
    ? values.filter(isKnownNumber).map(Number)
    : []

  if (points.length < 2) {
    return <div className="device-sparkline-empty">NO TRACE</div>
  }

  const width = 160
  const height = 40
  const pad = 3
  const minimum = Math.min(...points)
  const maximum = Math.max(...points)
  const range = maximum - minimum || 1
  const polyline = points.map((point, index) => {
    const x = pad + (index / (points.length - 1)) * (width - pad * 2)
    const y = height - pad - ((point - minimum) / range) * (height - pad * 2)
    return `${x},${y}`
  }).join(' ')

  return (
    <svg
      className="device-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} recent activity`}
    >
      <polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function TelemetryMetric({ label, value, caption, progress, trace }) {
  const safeProgress = clampPercent(progress)

  return (
    <article className="device-telemetry-metric">
      <div className="device-telemetry-metric-head">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <small>{caption}</small>
      {safeProgress !== null && (
        <div className="device-meter" aria-label={`${label}: ${safeProgress.toFixed(1)} percent`}>
          <span style={{ width: `${safeProgress}%` }} />
        </div>
      )}
      {trace && <MiniSparkline values={trace} label={label} />}
    </article>
  )
}

function PrinterSchematic({ connected }) {
  return (
    <div className="device-printer-schematic" data-connected={connected ? 'true' : 'false'}>
      <svg viewBox="0 0 320 205" role="img" aria-label="3D printer schematic">
        <g className="device-printer-schematic-grid" fill="none">
          <path d="M28 164h264M46 180h228M68 193h184" />
          <path d="M32 27h256M32 27v151M288 27v151" />
        </g>
        <g className="device-printer-schematic-main" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M91 47v104M229 47v104M91 47h138M91 151h138" />
          <path d="M107 64h106v33H107z" />
          <path d="M114 116h92v10h-92zM105 128h110" />
          <path d="M143 97h34M160 81v35" />
          <path d="M96 151v22h21M224 151v22h-21" />
          <path d="M71 174h178" />
          <circle cx="160" cy="80" r="4" />
        </g>
        <g className="device-printer-schematic-signal">
          <circle cx="160" cy="80" r="13" />
          <circle cx="160" cy="80" r="25" />
          <path d="M160 40v18M160 102v19M120 80h18M182 80h18" />
        </g>
      </svg>
      <span className="device-printer-schematic-label">3D PRINTER // FABRICATION CELL</span>
    </div>
  )
}

function DeviceControl({ children, className = '', disabled, onClick, title }) {
  const canRun = !disabled && typeof onClick === 'function'

  return (
    <button
      type="button"
      className={`device-control ${className}`.trim()}
      disabled={!canRun}
      onClick={canRun ? onClick : undefined}
      title={title}
    >
      {children}
    </button>
  )
}

function connectionErrorMessage(payload, fallback) {
  if (typeof payload === 'string') return payload
  return payload?.detail || payload?.error || payload?.message || fallback
}

function PrinterConnectionHub({ backendOnline, printerStatus, onConnectionChanged }) {
  const [profiles, setProfiles] = useState([])
  const [ports, setPorts] = useState([])
  const [form, setForm] = useState({
    profileId: 'marlin-usb',
    usbPort: '',
    baudRate: '115200',
    baseUrl: '',
    monitoring: true,
    credential: '',
  })
  const [credentialState, setCredentialState] = useState('none')
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState('')
  const [notice, setNotice] = useState('CHOOSE A LOCAL LINK PROFILE TO BEGIN')
  const [error, setError] = useState('')

  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(`${BACKEND}${path}`, options)
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) {
      throw new Error(connectionErrorMessage(payload, 'The local printer command could not be completed.'))
    }
    return payload
  }, [])

  const updateFromConfig = useCallback((config, nextProfiles = []) => {
    const usableProfiles = Array.isArray(nextProfiles) ? nextProfiles : []
    const defaultProfile = usableProfiles.find(profile => profile.id === 'marlin-usb' && profile.available)
      || usableProfiles.find(profile => profile.available)

    setForm(current => ({
      ...current,
      profileId: config?.profileId || current.profileId || defaultProfile?.id || '',
      usbPort: config?.usbPort || current.usbPort || '',
      baudRate: String(config?.baudRate || current.baudRate || 115200),
      baseUrl: config?.baseUrl || current.baseUrl || '',
      monitoring: config?.monitoring ?? current.monitoring,
      credential: '',
    }))
    setCredentialState(config?.credentialStorage || 'none')
  }, [])

  const loadConnectionData = useCallback(async ({ refreshPorts = false } = {}) => {
    if (!backendOnline) {
      setProfiles([])
      setPorts([])
      setNotice('LOCAL CORE OFFLINE — PRINTER LINKS ARE UNAVAILABLE')
      return
    }

    setLoading(true)
    setError('')
    try {
      const jobs = refreshPorts
        ? [request('/api/printer/ports')]
        : [
            request('/api/printer/profiles'),
            request('/api/printer/ports'),
            request('/api/printer/config'),
          ]
      const results = await Promise.all(jobs)
      if (refreshPorts) {
        setPorts(Array.isArray(results[0]?.ports) ? results[0].ports : [])
        setNotice('USB PORT LIST REFRESHED — NO PORT WAS OPENED')
        return
      }

      const nextProfiles = Array.isArray(results[0]?.profiles) ? results[0].profiles : []
      setProfiles(nextProfiles)
      setPorts(Array.isArray(results[1]?.ports) ? results[1].ports : [])
      updateFromConfig(results[2], nextProfiles)
      setNotice(results[2]?.configured
        ? 'SAVED LOCAL PRINTER PROFILE READY'
        : 'CHOOSE A LOCAL LINK PROFILE TO BEGIN')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The printer connection center is unavailable.')
    } finally {
      setLoading(false)
    }
  }, [backendOnline, request, updateFromConfig])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConnectionData()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadConnectionData])

  const selectedProfile = profiles.find(profile => profile.id === form.profileId) || null
  const usesUsb = selectedProfile?.transport === 'usb'
  const usesLan = selectedProfile?.transport === 'lan'
  const profileAvailable = Boolean(selectedProfile?.available)
  const savePayload = useCallback(() => {
    const payload = {
      profileId: form.profileId,
      usbPort: form.usbPort.trim() || null,
      baudRate: Number(form.baudRate) || 115200,
      baseUrl: form.baseUrl.trim() || null,
      monitoring: Boolean(form.monitoring),
    }
    // Omitting a blank credential preserves an already stored Keychain entry.
    if (form.credential.trim()) payload.credential = form.credential.trim()
    return payload
  }, [form])

  const updateForm = (key, value) => {
    setForm(current => ({ ...current, [key]: value }))
    setError('')
  }

  const saveProfile = useCallback(async ({ quiet = false } = {}) => {
    if (!backendOnline || !form.profileId || !profileAvailable) return false
    setAction('save')
    setError('')
    try {
      const payload = await request('/api/printer/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload()),
      })
      updateFromConfig(payload?.config, profiles)
      if (!quiet) setNotice('LOCAL PRINTER PROFILE SAVED — CREDENTIALS STAY PRIVATE')
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The local printer profile could not be saved.')
      return false
    } finally {
      setAction('')
    }
  }, [backendOnline, form.profileId, profileAvailable, profiles, request, savePayload, updateFromConfig])

  const testConnection = useCallback(async () => {
    if (!backendOnline || !form.profileId || !profileAvailable) return
    setAction('test')
    setError('')
    try {
      const payload = await request('/api/printer/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload()),
      })
      const status = payload?.test || {}
      setNotice(`READ-ONLY TEST READY — ${status.status || 'LOCAL LINK RESPONDED'}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The local printer did not respond to the test.')
    } finally {
      setAction('')
    }
  }, [backendOnline, form.profileId, profileAvailable, request, savePayload])

  const connectPrinter = useCallback(async () => {
    if (!backendOnline || !form.profileId || !profileAvailable) return
    setAction('connect')
    setError('')
    try {
      const saved = await saveProfile({ quiet: true })
      if (!saved) return
      const payload = await request('/api/printer/connect', { method: 'POST' })
      setNotice(`PRINTER LINK ACTIVE — ${payload?.status?.status || 'CONNECTED'}`)
      setForm(current => ({ ...current, credential: '' }))
      if (typeof onConnectionChanged === 'function') await onConnectionChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The printer could not be connected.')
    } finally {
      setAction('')
    }
  }, [backendOnline, form.profileId, onConnectionChanged, profileAvailable, request, saveProfile])

  const disconnectPrinter = useCallback(async () => {
    if (!backendOnline) return
    setAction('disconnect')
    setError('')
    try {
      await request('/api/printer/disconnect', { method: 'POST' })
      setNotice('PRINTER LINK CLOSED — NO DEVICE IS BEING POLLED')
      if (typeof onConnectionChanged === 'function') await onConnectionChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The printer link could not be closed.')
    } finally {
      setAction('')
    }
  }, [backendOnline, onConnectionChanged, request])

  return (
    <section className="device-printer-connection" aria-label="3D printer connection center">
      <header className="device-printer-connection-header">
        <div>
          <span>FABRICATION LINK MATRIX // EXPLICIT LOCAL CONNECTIONS</span>
          <h2>Printer Connection Center</h2>
          <p>Save one local profile, test it read-only, then choose when ULTRON may monitor it.</p>
        </div>
        <div className="device-printer-connection-state" data-online={printerStatus?.connected ? 'true' : 'false'}>
          <StatusPip active={Boolean(printerStatus?.connected)} />
          <span>{printerStatus?.connected ? 'LINK ACTIVE' : 'NO ACTIVE LINK'}</span>
        </div>
      </header>

      <div className="device-printer-profile-grid" role="list" aria-label="Available printer profiles">
        {profiles.map(profile => (
          <button
            key={profile.id}
            type="button"
            className="device-printer-profile"
            data-selected={profile.id === form.profileId ? 'true' : 'false'}
            data-available={profile.available ? 'true' : 'false'}
            onClick={() => profile.available && updateForm('profileId', profile.id)}
            disabled={!profile.available || loading || Boolean(action)}
          >
            <span>{profile.transport === 'lan' ? 'WI-FI / LAN' : profile.transport === 'usb' ? 'USB SERIAL' : 'EXTERNAL APP'}</span>
            <strong>{profile.name}</strong>
            <small>{profile.available ? profile.limitation || profile.limitations : 'USE THE SOFTWARE BRIDGE IN MODEL DECK'}</small>
          </button>
        ))}
      </div>

      {selectedProfile && (
        <div className="device-printer-connection-fields">
          <div className="device-printer-selected-profile">
            <div>
              <span>SELECTED PROFILE</span>
              <strong>{selectedProfile.name}</strong>
            </div>
            <p>{selectedProfile.limitations || 'Read-only telemetry is available after an explicit connection.'}</p>
            <div className="device-printer-capabilities">
              {(selectedProfile.supports || []).map(capability => <span key={capability}>{String(capability).replaceAll('-', ' ')}</span>)}
            </div>
          </div>

          {usesUsb && (
            <>
              <label className="device-printer-field">
                <span>USB PORT</span>
                <select value={form.usbPort} onChange={event => updateForm('usbPort', event.target.value)}>
                  <option value="">Select detected USB port…</option>
                  {ports.map(port => <option key={port.device} value={port.device}>{port.label || port.device}</option>)}
                </select>
              </label>
              <label className="device-printer-field">
                <span>BAUD RATE</span>
                <select value={form.baudRate} onChange={event => updateForm('baudRate', event.target.value)}>
                  {[9600, 19200, 38400, 57600, 115200, 230400, 250000].map(rate => <option key={rate} value={String(rate)}>{rate}</option>)}
                </select>
              </label>
              <button type="button" className="device-control device-control-quiet" onClick={() => void loadConnectionData({ refreshPorts: true })} disabled={!backendOnline || loading || Boolean(action)}>
                {loading ? 'READING PORTS…' : 'REFRESH USB PORTS'}
              </button>
              <p className="device-printer-field-note">Port discovery only reads macOS metadata. ULTRON opens a selected port only when you test or connect it.</p>
            </>
          )}

          {usesLan && (
            <>
              <label className="device-printer-field device-printer-field-wide">
                <span>LOCAL PRINTER URL</span>
                <input value={form.baseUrl} onChange={event => updateForm('baseUrl', event.target.value)} placeholder="http://192.168.1.42:5000" inputMode="url" autoComplete="off" />
              </label>
              <label className="device-printer-field device-printer-field-wide">
                <span>{selectedProfile.id === 'octoprint-local' ? 'OCTOPRINT API KEY' : 'MOONRAKER TOKEN (OPTIONAL)'}</span>
                <input type="password" value={form.credential} onChange={event => updateForm('credential', event.target.value)} placeholder={credentialState === 'keychain' ? 'Stored in macOS Keychain — leave blank to keep it' : 'Enter only if this local printer requires one'} autoComplete="new-password" />
              </label>
              <p className="device-printer-field-note">Only your chosen local URL is contacted. A saved credential is held in macOS Keychain when available and is never shown again here.</p>
            </>
          )}

          <label className="device-printer-monitor-toggle">
            <input type="checkbox" checked={Boolean(form.monitoring)} onChange={event => updateForm('monitoring', event.target.checked)} />
            <span><strong>MONITOR AFTER CONNECTING</strong> Refresh read-only printer status while this app is open.</span>
          </label>

          <div className="device-printer-connection-actions">
            <button type="button" className="device-control device-control-quiet" disabled={!backendOnline || Boolean(action) || !profileAvailable} onClick={() => void saveProfile()}>{action === 'save' ? 'SAVING…' : 'SAVE PROFILE'}</button>
            <button type="button" className="device-control device-control-secondary" disabled={!backendOnline || Boolean(action) || !profileAvailable} onClick={() => void testConnection()}>{action === 'test' ? 'TESTING…' : 'READ-ONLY TEST'}</button>
            <button type="button" className="device-control device-control-primary" disabled={!backendOnline || Boolean(action) || !profileAvailable} onClick={() => void connectPrinter()}>{action === 'connect' ? 'CONNECTING…' : 'SAVE & CONNECT'}</button>
            <button type="button" className="device-control device-control-danger" disabled={!backendOnline || Boolean(action) || !printerStatus?.connected} onClick={() => void disconnectPrinter()}>{action === 'disconnect' ? 'CLOSING…' : 'DISCONNECT'}</button>
          </div>
        </div>
      )}

      <div className="device-printer-connection-message" data-error={error ? 'true' : 'false'} aria-live="polite">
        <StatusPip active={!error && Boolean(printerStatus?.connected)} />
        <span>{error || notice}</span>
      </div>
    </section>
  )
}

/**
 * Device command center for the ULTRON dashboard.
 *
 * `onRefresh`, `onOpenMakerWorld` and `onOpenModelDeck` stay optional on purpose: their
 * corresponding controls automatically become disabled until the parent has
 * wired a real local action.
 */
export default function DevicesPage({
  system = null,
  history = {},
  printerStatus = null,
  backendOnline = false,
  onRefresh,
  onOpenMakerWorld,
  onOpenModelDeck,
  isRefreshing = false,
}) {
  const printerConnected = Boolean(printerStatus?.connected)
  const printerProgress = clampPercent(printerStatus?.progress)
  const printerTransport = printerStatus?.transport === 'lan' ? 'WI-FI / LAN' : printerStatus?.transport === 'usb' ? 'USB SERIAL' : 'LOCAL LINK'
  const printerEndpoint = printerStatus?.port || printerStatus?.baseUrl || 'NO PRINTER CONFIGURED'
  const coreOnline = Boolean(backendOnline && system)
  const networkOnline = coreOnline && (
    isKnownNumber(system?.download_mbps) ||
    isKnownNumber(system?.upload_mbps)
  )
  const refreshAvailable = typeof onRefresh === 'function' && !isRefreshing
  const makerWorldAvailable = typeof onOpenMakerWorld === 'function'
  const modelDeckAvailable = typeof onOpenModelDeck === 'function'
  const telemetry = [
    { label: 'CPU LOAD', value: formatPercent(system?.cpu_percent), progress: system?.cpu_percent, caption: `${system?.process_count ?? '—'} PROCESSES`, trace: history?.cpu },
    { label: 'MEMORY', value: formatPercent(system?.ram_percent), progress: system?.ram_percent, caption: `${formatStorage(system?.ram_used_gb)} / ${formatStorage(system?.ram_total_gb)}`, trace: history?.ram },
    { label: 'SYSTEM DISK', value: formatPercent(system?.disk_percent), progress: system?.disk_percent, caption: `${formatStorage(system?.disk_free_gb)} FREE`, trace: null },
    { label: 'NETWORK', value: networkOnline ? 'LIVE' : '—', progress: null, caption: `↓ ${formatRate(system?.download_mbps)}  ↑ ${formatRate(system?.upload_mbps)}`, trace: history?.download },
  ]

  return (
    <section className="devices-command-center" aria-label="ULTRON device command center">
      <header className="devices-command-header">
        <div className="devices-command-title">
          <span>INFRASTRUCTURE CONTROL // LOCAL DOMAIN</span>
          <h1>Device Command</h1>
          <p>Monitor the machine, fabrication cell and connected control surfaces from one local channel.</p>
        </div>

        <div className="devices-command-actions">
          <div className="devices-core-state" data-online={coreOnline ? 'true' : 'false'} aria-live="polite">
            <StatusPip active={coreOnline} />
            <span>{statusLabel(coreOnline, 'SYSTEM LINK ONLINE', 'SYSTEM LINK OFFLINE')}</span>
          </div>
          <DeviceControl
            className="device-control-refresh"
            disabled={!refreshAvailable}
            onClick={onRefresh}
            title={refreshAvailable ? 'Refresh local device telemetry' : 'Refresh action is unavailable'}
          >
            {isRefreshing ? 'SCANNING…' : 'REFRESH TELEMETRY'}
          </DeviceControl>
        </div>
      </header>

      <div className="devices-command-grid">
        <section className="device-command-card device-mac-command-card">
          <header className="device-card-header">
            <div>
              <span>PRIMARY HOST // 01</span>
              <h2>{system?.hostname || 'Local host'}</h2>
            </div>
            <div className="device-card-state" data-online={coreOnline ? 'true' : 'false'}>
              <StatusPip active={coreOnline} />
              <strong>{statusLabel(coreOnline, 'LIVE', 'OFFLINE')}</strong>
            </div>
          </header>

          <div className="device-host-identity">
            <div className="device-host-orb" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <dl>
              <div><dt>HOST</dt><dd>{system?.hostname || 'LOCAL CORE'}</dd></div>
              <div><dt>ARCH</dt><dd>{system?.architecture || 'ARM64'}</dd></div>
              <div><dt>UPTIME</dt><dd>{formatUptime(system?.uptime_seconds)}</dd></div>
              <div><dt>THERMAL</dt><dd>{isKnownNumber(system?.temp_c) ? `${Number(system.temp_c).toFixed(1)}°C` : 'NO SENSOR'}</dd></div>
            </dl>
          </div>

          <div className="device-telemetry-grid">
            {telemetry.map(metric => (
              <TelemetryMetric key={metric.label} {...metric} />
            ))}
          </div>

          <footer className="device-host-footer">
            <span><StatusPip active={networkOnline} /> NETWORK {networkOnline ? 'UPLINK ACTIVE' : 'NO UPLINK TRACE'}</span>
            <span>GPU {isKnownNumber(system?.gpu_percent) ? formatPercent(system.gpu_percent) : 'UNAVAILABLE'}</span>
          </footer>
        </section>

        <section className="device-command-card device-printer-command-card">
          <header className="device-card-header">
            <div>
              <span>FABRICATION CELL // 02</span>
              <h2>3D Printer</h2>
            </div>
            <div className="device-card-state" data-online={printerConnected ? 'true' : 'false'}>
              <StatusPip active={printerConnected} />
              <strong>{statusLabel(printerConnected, `${printerTransport} ONLINE`, 'WAITING')}</strong>
            </div>
          </header>

          <PrinterSchematic connected={printerConnected} />

          <dl className="device-printer-readout">
            <div><dt>STATE</dt><dd>{printerStatus?.status || 'NOT CONNECTED'}</dd></div>
            <div><dt>LINK</dt><dd>{printerEndpoint}</dd></div>
            <div><dt>FIRMWARE</dt><dd>{printerStatus?.firmware || 'AWAITING HANDSHAKE'}</dd></div>
            <div><dt>JOB PROGRESS</dt><dd>{printerProgress === null ? 'NO ACTIVE JOB' : `${printerProgress.toFixed(1)}%`}</dd></div>
          </dl>

          <div className="device-printer-progress" data-active={printerProgress !== null ? 'true' : 'false'}>
            <span style={{ width: `${printerProgress ?? 0}%` }} />
          </div>

          {printerStatus?.raw && (
            <div className="device-printer-diagnostic" title={printerStatus.raw}>
              <span>LAST LOCAL SIGNAL</span>
              <code>{String(printerStatus.raw).replace(/\s+/g, ' ').slice(0, 140)}</code>
            </div>
          )}

          <div className="device-printer-actions">
            <DeviceControl
              className="device-control-model-vault"
              disabled={!modelDeckAvailable}
              onClick={onOpenModelDeck}
              title={modelDeckAvailable ? 'Open the 3D model vault' : '3D model vault is unavailable'}
            >
              <span>MODEL VAULT</span>
              <strong>3D ASSET CONTROL</strong>
            </DeviceControl>
            <DeviceControl
              className="device-control-primary"
              disabled={!refreshAvailable}
              onClick={onRefresh}
              title={refreshAvailable ? 'Refresh saved local telemetry without opening a printer port' : 'Refresh action is unavailable'}
            >
              {isRefreshing ? 'REFRESHING…' : 'REFRESH STATUS'}
            </DeviceControl>
            <DeviceControl
              className="device-control-secondary"
              disabled={!makerWorldAvailable}
              onClick={onOpenMakerWorld}
              title={makerWorldAvailable ? 'Open MakerWorld in the browser' : 'MakerWorld action is unavailable'}
            >
              OPEN MAKERWORLD ↗
            </DeviceControl>
          </div>
        </section>
      </div>

      <PrinterConnectionHub
        backendOnline={backendOnline}
        printerStatus={printerStatus}
        onConnectionChanged={onRefresh}
      />

      <section className="device-network-roster" aria-label="Device network roster">
        <header>
          <span>NETWORK ROSTER</span>
          <strong>{coreOnline ? 'LOCAL COMMAND FABRIC ACTIVE' : 'AWAITING CORE TELEMETRY'}</strong>
        </header>
        <div className="device-network-roster-grid">
          <article data-online={coreOnline ? 'true' : 'false'}>
            <StatusPip active={coreOnline} />
            <div><span>ULTRON BACKEND</span><strong>{coreOnline ? 'ONLINE' : 'OFFLINE'}</strong></div>
            <small>127.0.0.1 // LOCAL</small>
          </article>
          <article data-online={printerConnected ? 'true' : 'false'}>
            <StatusPip active={printerConnected} />
            <div><span>3D PRINTER</span><strong>{printerConnected ? 'LINKED' : 'STANDBY'}</strong></div>
            <small>{printerEndpoint}</small>
          </article>
          <article data-online="false">
            <StatusPip active={false} />
            <div><span>HOME ASSISTANT</span><strong>UNCONFIGURED</strong></div>
            <small>CONTROL BRIDGE RESERVED</small>
          </article>
          <article data-online="false">
            <StatusPip active={false} />
            <div><span>ALEXA</span><strong>UNCONFIGURED</strong></div>
            <small>VOICE BRIDGE RESERVED</small>
          </article>
        </div>
      </section>
    </section>
  )
}
