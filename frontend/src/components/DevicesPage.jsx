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
              <strong>{statusLabel(printerConnected, 'USB ONLINE', 'WAITING')}</strong>
            </div>
          </header>

          <PrinterSchematic connected={printerConnected} />

          <dl className="device-printer-readout">
            <div><dt>STATE</dt><dd>{printerStatus?.status || 'NOT CONNECTED'}</dd></div>
            <div><dt>PORT</dt><dd>{printerStatus?.port || 'NO USB DEVICE'}</dd></div>
            <div><dt>FIRMWARE</dt><dd>{printerStatus?.firmware || 'AWAITING HANDSHAKE'}</dd></div>
            <div><dt>JOB PROGRESS</dt><dd>{printerProgress === null ? 'NO ACTIVE JOB' : `${printerProgress.toFixed(1)}%`}</dd></div>
          </dl>

          <div className="device-printer-progress" data-active={printerProgress !== null ? 'true' : 'false'}>
            <span style={{ width: `${printerProgress ?? 0}%` }} />
          </div>

          {printerStatus?.raw && (
            <div className="device-printer-diagnostic" title={printerStatus.raw}>
              <span>LAST SERIAL SIGNAL</span>
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
              title={refreshAvailable ? 'Scan the USB printer and refresh telemetry' : 'Scan action is unavailable'}
            >
              {isRefreshing ? 'SCANNING…' : 'SCAN USB LINK'}
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
            <small>{printerStatus?.port || 'USB AUTO DETECTION'}</small>
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
