import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { BACKEND_ORIGIN as BACKEND } from '../auth.js'

const GlobalPositionGlobe = lazy(() => import('./GlobalPositionGlobe.jsx'))

const SECTIONS = [
  ['general', 'GENERAL'],
  ['appearance', 'APPEARANCE'],
  ['integrations', 'INTEGRATIONS'],
  ['email', 'EMAIL'],
  ['skills', 'SKILLS'],
  ['advanced', 'ADVANCED'],
]

const LOCATION_QUERY_MIN_LENGTH = 2

function desktopSkillPicker() {
  if (typeof window === 'undefined') return null
  const picker = window.ultronDesktop?.selectSkillApp
  return typeof picker === 'function' ? picker : null
}

function isCoordinate(value, minimum, maximum) {
  if (value === '' || value === null || value === undefined) return false

  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum
}

function hasValidCoordinates(latitude, longitude) {
  return isCoordinate(latitude, -90, 90) && isCoordinate(longitude, -180, 180)
}

function normalizeLocation(candidate, source = 'search') {
  const latitude = Number(candidate?.lat)
  const longitude = Number(candidate?.lon)
  if (!hasValidCoordinates(latitude, longitude)) return null

  const label = String(candidate?.label || candidate?.shortLabel || 'Global position')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 320)
  const shortLabel = String(candidate?.shortLabel || label || 'GLOBAL POSITION')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120)

  return {
    label: label || 'Global position',
    shortLabel: shortLabel || 'GLOBAL POSITION',
    kind: String(candidate?.kind || (source === 'device' ? 'DEVICE POSITION' : source === 'coordinates' ? 'COORDINATES' : 'PLACE'))
      .trim()
      .slice(0, 80),
    lat: Number(latitude.toFixed(6)),
    lon: Number(longitude.toFixed(6)),
    source,
    accuracy: Number.isFinite(Number(candidate?.accuracy)) ? Number(candidate.accuracy) : null,
  }
}

function parseCoordinateQuery(value) {
  const match = String(value || '')
    .trim()
    .match(/^([+-]?\d{1,2}(?:\.\d+)?)\s*(?:,|;|\s)\s*([+-]?\d{1,3}(?:\.\d+)?)$/)

  if (!match) return null

  const location = normalizeLocation(
    {
      lat: match[1],
      lon: match[2],
      shortLabel: 'MANUAL POSITION',
      label: 'Manual coordinates',
      kind: 'COORDINATES',
    },
    'coordinates'
  )

  if (!location) return null

  location.label = 'Manual coordinates · ' + location.lat.toFixed(5) + ', ' + location.lon.toFixed(5)
  return location
}

function formatCoordinate(value) {
  return isCoordinate(value, -180, 180) ? Number(value).toFixed(5) : '—'
}

function Toggle({ value, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      className={`settings-toggle ${value ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      aria-pressed={value}
      aria-label={label}
    >
      <span />
      {value ? 'ON' : 'OFF'}
    </button>
  )
}

function SettingsCard({ title, kicker, children }) {
  return (
    <section className="settings-card">
      <header className="settings-card-head">
        <span>{kicker}</span>
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  )
}

function SettingRow({ title, description, children }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

function EmailMessage({ message }) {
  const receivedAt = message.receivedAt
    ? new Date(message.receivedAt)
    : null
  const receivedLabel = receivedAt && !Number.isNaN(receivedAt.getTime())
    ? receivedAt.toLocaleString('it-IT', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''

  return (
    <article className="email-message">
      <strong>{message.sender || 'Unknown sender'}</strong>
      <span>{message.subject || '(No subject)'}</span>
      <time>{receivedLabel}</time>
    </article>
  )
}

export default function SettingsPage({
  obsidianPath,
  setObsidianPath,
  saveObsidian,
  obsidianStatus,
  weatherConfig,
  saveWeather,
  onSaveGlobalPosition,
  preferences,
  setPreferences,
  backendOnline,
  printerStatus,
  onOpenTutorial = () => {},
}) {
  const [activeSection, setActiveSection] = useState('general')
  const [skills, setSkills] = useState([])
  const [obsidianFeedback, setObsidianFeedback] = useState('')
  const [obsidianFeedbackTone, setObsidianFeedbackTone] = useState('success')
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState('')
  const [showSkillEditor, setShowSkillEditor] = useState(false)
  const [editingSkillId, setEditingSkillId] = useState(null)
  const [skillName, setSkillName] = useState('')
  const [skillDescription, setSkillDescription] = useState('')
  const [skillTrigger, setSkillTrigger] = useState('')
  const [skillAction, setSkillAction] = useState('open_app')
  const [skillTarget, setSkillTarget] = useState('')
  const [emailStatus, setEmailStatus] = useState(null)
  const [emailMessages, setEmailMessages] = useState([])
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailFeedback, setEmailFeedback] = useState('')
  const [locationQuery, setLocationQuery] = useState('')
  const [locationResults, setLocationResults] = useState([])
  const [selectedLocation, setSelectedLocation] = useState(null)
  const [locationLoading, setLocationLoading] = useState(false)
  const [locationFeedback, setLocationFeedback] = useState('')
  const locationRequestRef = useRef(null)

  const enabledSkills = useMemo(
    () => skills.filter(skill => skill.enabled).length,
    [skills]
  )
  const emailSkill = useMemo(
    () => skills.find(skill => skill.id === 'email'),
    [skills]
  )
  const globeLatitude = selectedLocation?.lat ?? weatherConfig?.lat ?? ''
  const globeLongitude = selectedLocation?.lon ?? weatherConfig?.lon ?? ''
  const hasLockedPosition = hasValidCoordinates(globeLatitude, globeLongitude)

  useEffect(() => {
    void loadSkills()
  }, [])

  useEffect(() => () => {
    locationRequestRef.current?.controller?.abort()
    locationRequestRef.current = null
  }, [])

  function setPreference(key, value) {
    setPreferences(current => ({ ...current, [key]: value }))
  }

  async function readJson(response) {
    try {
      return await response.json()
    } catch {
      return {}
    }
  }

  async function locatePosition() {
    const query = locationQuery.trim()

    if (query.length < LOCATION_QUERY_MIN_LENGTH) {
      setLocationFeedback('Enter a city, address, landmark, or coordinates first.')
      setLocationResults([])
      setSelectedLocation(null)
      return
    }

    const coordinateLocation = parseCoordinateQuery(query)
    if (coordinateLocation) {
      locationRequestRef.current?.controller?.abort()
      locationRequestRef.current = null
      setLocationLoading(false)
      setLocationResults([coordinateLocation])
      setSelectedLocation(coordinateLocation)
      setLocationFeedback('Coordinates ready. Confirm to save them to this local account.')
      return
    }

    locationRequestRef.current?.controller?.abort()
    const controller = new AbortController()
    const request = { controller }
    locationRequestRef.current = request
    setLocationLoading(true)
    setLocationFeedback('')
    setLocationResults([])
    setSelectedLocation(null)

    try {
      const response = await fetch(`${BACKEND}/api/location/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      })
      const result = await readJson(response)

      if (locationRequestRef.current !== request) return
      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Location lookup unavailable.')
      }

      const matches = Array.isArray(result.results)
        ? result.results
          .map(item => normalizeLocation(item, 'search'))
          .filter(Boolean)
        : []
      setLocationResults(matches)

      if (!matches.length) {
        setLocationFeedback('No position matched that request. Try a more complete address or coordinates such as 45.4642, 9.1900.')
        return
      }

      setSelectedLocation(matches[0])
      setLocationFeedback('Review the suggested position, then confirm it to save it locally.')
    } catch (error) {
      if (error?.name === 'AbortError') return
      setLocationFeedback(error?.message || 'Location lookup unavailable.')
    } finally {
      if (locationRequestRef.current === request) {
        locationRequestRef.current = null
        setLocationLoading(false)
      }
    }
  }

  function useCurrentDevicePosition() {
    if (!navigator.geolocation) {
      setLocationFeedback('This device does not make its position available. Search an address or enter coordinates instead.')
      return
    }

    locationRequestRef.current?.controller?.abort()
    const request = { controller: null }
    locationRequestRef.current = request
    setLocationLoading(true)
    setLocationFeedback('Requesting this device position…')
    setLocationResults([])
    setSelectedLocation(null)

    navigator.geolocation.getCurrentPosition(
      position => {
        if (locationRequestRef.current !== request) return
        const location = normalizeLocation(
          {
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            shortLabel: 'THIS DEVICE',
            label: 'Current device position',
            kind: 'DEVICE POSITION',
            accuracy: position.coords.accuracy,
          },
          'device'
        )
        locationRequestRef.current = null
        setLocationLoading(false)

        if (!location) {
          setLocationFeedback('The device returned invalid coordinates. Search an address or enter coordinates instead.')
          return
        }

        setLocationQuery(location.lat.toFixed(5) + ', ' + location.lon.toFixed(5))
        setLocationResults([location])
        setSelectedLocation(location)
        setLocationFeedback('Device position ready. Confirm to save it to this local account.')
      },
      error => {
        if (locationRequestRef.current !== request) return
        locationRequestRef.current = null
        setLocationLoading(false)
        const messages = {
          1: 'Location permission was denied. Search an address or enter coordinates instead.',
          2: 'This device cannot determine its position right now. Search an address or enter coordinates instead.',
          3: 'The location request timed out. Search an address or enter coordinates instead.',
        }
        setLocationFeedback(messages[error?.code] || 'Device location is unavailable. Search an address or enter coordinates instead.')
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 60000,
      }
    )
  }

  function confirmGlobalPosition() {
    if (!selectedLocation) return

    onSaveGlobalPosition?.(selectedLocation)
    setLocationQuery('')
    setLocationResults([])
    setSelectedLocation(null)
    setLocationFeedback('Position saved to this local account. Weather telemetry is updating.')
  }

  async function saveVault() {
    setObsidianFeedback('')

    try {
      const result = await saveObsidian()

      if (!result?.ok) {
        throw new Error(result?.error || 'Obsidian could not connect to this vault.')
      }

      setObsidianFeedbackTone('success')
      setObsidianFeedback(result.message || 'Obsidian vault connected for this local account.')
    } catch (error) {
      setObsidianFeedbackTone('error')
      setObsidianFeedback(error?.message || 'Obsidian could not connect to this vault.')
    }
  }

  async function loadSkills() {
    setSkillsLoading(true)
    setSkillsError('')
    try {
      const response = await fetch(`${BACKEND}/api/skills`)
      const result = await readJson(response)
      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Unable to load skills.')
      }
      setSkills(Array.isArray(result.skills) ? result.skills : [])
    } catch (error) {
      setSkillsError(error?.message || 'Il Core di Ultron AI non è disponibile.')
    } finally {
      setSkillsLoading(false)
    }
  }

  async function updateSkill(skill, changes) {
    if (!skill) return
    setSkillsError('')
    try {
      const response = await fetch(
        `${BACKEND}/api/skills/${encodeURIComponent(skill.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: skill.id,
            name: skill.name,
            description: skill.description || '',
            trigger: skill.trigger || '',
            action: skill.action || 'ask_ai',
            target: skill.target || '',
            enabled: Boolean(skill.enabled),
            ...changes,
          }),
        }
      )
      const result = await readJson(response)
      if (!response.ok || !result.ok || !result.skill) {
        throw new Error(result.detail || result.error || 'Unable to update skill.')
      }
      setSkills(current => current.map(item =>
        item.id === skill.id ? result.skill : item
      ))
    } catch (error) {
      setSkillsError(error?.message || 'Unable to update skill.')
    }
  }

  function resetSkillEditor() {
    setEditingSkillId(null)
    setSkillName('')
    setSkillDescription('')
    setSkillTrigger('')
    setSkillAction('open_app')
    setSkillTarget('')
  }

  function editSkill(skill) {
    setEditingSkillId(skill.id)
    setSkillName(skill.name || '')
    setSkillDescription(skill.description || '')
    setSkillTrigger(skill.trigger || '')
    setSkillAction(skill.action || 'ask_ai')
    setSkillTarget(skill.target || '')
    setShowSkillEditor(true)
  }

  async function chooseLocalApp() {
    setSkillsError('')
    try {
      const nativePicker = desktopSkillPicker()
      let result

      if (nativePicker) {
        result = await nativePicker()
      } else {
        const response = await fetch(`${BACKEND}/api/system/choose-app`)
        result = await readJson(response)
        if (!response.ok) {
          throw new Error(result.error || 'Unable to choose an application.')
        }
      }

      if (result.cancelled) return
      if (!result.ok && !result.path) {
        throw new Error(result.error || 'Unable to choose an application.')
      }
      setSkillTarget(result.path)
    } catch (error) {
      setSkillsError(error?.message || 'Unable to choose an application.')
    }
  }

  async function saveSkill(event) {
    event.preventDefault()
    setSkillsError('')
    if (!skillName.trim() || !skillTrigger.trim()) {
      setSkillsError('Name and command are required.')
      return
    }
    if (['open_app', 'open_url'].includes(skillAction) && !skillTarget.trim()) {
      setSkillsError('Choose a target for this action.')
      return
    }

    const payload = {
      ...(editingSkillId ? { id: editingSkillId } : {}),
      name: skillName.trim(),
      description: skillDescription.trim(),
      trigger: skillTrigger.trim(),
      action: skillAction,
      target: skillTarget.trim(),
      enabled: editingSkillId
        ? Boolean(skills.find(skill => skill.id === editingSkillId)?.enabled)
        : true,
    }
    const endpoint = editingSkillId
      ? `${BACKEND}/api/skills/${encodeURIComponent(editingSkillId)}`
      : `${BACKEND}/api/skills`

    try {
      const response = await fetch(endpoint, {
        method: editingSkillId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await readJson(response)
      if (!response.ok || !result.ok || !result.skill) {
        throw new Error(result.detail || result.error || 'Unable to save skill.')
      }
      setSkills(current => editingSkillId
        ? current.map(skill => skill.id === editingSkillId ? result.skill : skill)
        : [...current, result.skill]
      )
      resetSkillEditor()
      setShowSkillEditor(false)
    } catch (error) {
      setSkillsError(error?.message || 'Unable to save skill.')
    }
  }

  async function deleteSkill(skill) {
    if (!skill || skill.builtin) return
    setSkillsError('')
    try {
      const response = await fetch(
        `${BACKEND}/api/skills/${encodeURIComponent(skill.id)}`,
        { method: 'DELETE' }
      )
      const result = await readJson(response)
      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Unable to delete skill.')
      }
      setSkills(current => current.filter(item => item.id !== skill.id))
    } catch (error) {
      setSkillsError(error?.message || 'Unable to delete skill.')
    }
  }

  async function loadEmailStatus() {
    try {
      const response = await fetch(`${BACKEND}/api/email/status`)
      const result = await readJson(response)
      setEmailStatus(result)
      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Email integration unavailable.')
      }
      setEmailFeedback('')
    } catch (error) {
      setEmailFeedback(error?.message || 'Email integration is unavailable.')
    }
  }

  async function connectGmail() {
    setEmailFeedback('')
    try {
      const response = await fetch(`${BACKEND}/api/email/setup`, {
        method: 'POST',
      })
      const result = await readJson(response)
      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Unable to open Google account setup.')
      }
      setEmailFeedback(result.message || 'Internet Accounts opened.')
    } catch (error) {
      setEmailFeedback(error?.message || 'Unable to open Google account setup.')
    }
  }

  async function openEmail(provider) {
    setEmailFeedback('')
    try {
      const response = await fetch(`${BACKEND}/api/email/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const result = await readJson(response)
      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Unable to open email.')
      }
      setEmailFeedback(result.message || 'Email opened.')
    } catch (error) {
      setEmailFeedback(error?.message || 'Unable to open email.')
    }
  }

  async function composeEmail() {
    setEmailFeedback('')
    try {
      const response = await fetch(`${BACKEND}/api/email/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const result = await readJson(response)
      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Unable to open a draft.')
      }
      setEmailFeedback(result.message || 'New draft opened.')
    } catch (error) {
      setEmailFeedback(error?.message || 'Unable to open a draft.')
    }
  }

  async function loadInbox() {
    setEmailLoading(true)
    setEmailFeedback('')
    try {
      const response = await fetch(`${BACKEND}/api/email/inbox?limit=8`)
      const result = await readJson(response)
      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Unable to read the inbox.')
      }
      const messages = Array.isArray(result.messages) ? result.messages : []
      setEmailMessages(messages)
      setEmailFeedback(messages.length ? '' : 'No recent messages were found in Mail.')
    } catch (error) {
      setEmailFeedback(error?.message || 'Unable to read the inbox.')
    } finally {
      setEmailLoading(false)
    }
  }

  function renderSkillTarget() {
    if (skillAction === 'open_app') {
      return (
        <div className="settings-field">
          <label>APPLICATION</label>
          <div className="settings-field-action">
            <input
              className="settings-input"
              value={skillTarget}
              onChange={event => setSkillTarget(event.target.value)}
              placeholder="Choose a local application"
            />
            <button type="button" className="settings-secondary" onClick={chooseLocalApp}>
              CHOOSE APP
            </button>
          </div>
          <small>Choose an installed local application.</small>
        </div>
      )
    }
    if (skillAction === 'open_url') {
      return (
        <div className="settings-field">
          <label>URL</label>
          <input
            className="settings-input"
            value={skillTarget}
            onChange={event => setSkillTarget(event.target.value)}
            placeholder="https://example.com"
          />
        </div>
      )
    }
    return (
      <p className="settings-note">
        {skillAction === 'research'
          ? 'Il comando invierà il testo alla ricerca web di Ultron AI.'
          : 'Il comando continuerà nella normale conversazione con Ultron AI.'}
      </p>
    )
  }

  function renderGeneral() {
    return (
      <>
        <SettingsCard title="Core status" kicker="LOCAL ASSISTANT">
          <SettingRow title="Core Ultron AI" description="Il backend locale che gestisce chat, memoria e telemetria.">
            <span className={`settings-status ${backendOnline ? 'online' : ''}`}>
              {backendOnline ? '● ONLINE' : '○ OFFLINE'}
            </span>
          </SettingRow>
          <SettingRow title="Risposte vocali" description="Leggi le risposte di Ultron AI con la voce configurata.">
            <Toggle
              label="Voice replies"
              value={preferences.voiceEnabled}
              onChange={value => setPreference('voiceEnabled', value)}
            />
          </SettingRow>
        </SettingsCard>
        <SettingsCard title="Global position" kicker="PRIVATE LOCATION">
          <div className="global-position-layout">
            <Suspense
              fallback={(
                <div className="global-position-globe global-position-globe-fallback" role="status" aria-live="polite">
                  <div className="global-position-fallback-message">
                    <i aria-hidden="true" />
                    <strong>INITIALIZING GLOBE</strong>
                    <span>LOADING LOCAL MAP</span>
                  </div>
                </div>
              )}
            >
              <GlobalPositionGlobe
                latitude={globeLatitude}
                longitude={globeLongitude}
                label={selectedLocation?.shortLabel || weatherConfig.label}
                active={Boolean(selectedLocation || hasLockedPosition)}
              />
            </Suspense>

            <div className="global-position-command">
              <div className="settings-field">
                <label>SEARCH OR COORDINATES</label>
                <input
                  className="settings-input"
                  value={locationQuery}
                  aria-describedby="global-position-help"
                  onChange={event => {
                    locationRequestRef.current?.controller?.abort()
                    locationRequestRef.current = null
                    setLocationLoading(false)
                    setLocationQuery(event.target.value)
                    setLocationResults([])
                    setSelectedLocation(null)
                    setLocationFeedback('')
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void locatePosition()
                    }
                  }}
                  placeholder="City, address, landmark, or 45.4642, 9.1900"
                />
              </div>

              <div className="global-position-actions">
                <button
                  type="button"
                  className="settings-primary global-position-locate"
                  onClick={() => void locatePosition()}
                  disabled={locationLoading || locationQuery.trim().length < LOCATION_QUERY_MIN_LENGTH}
                >
                  {locationLoading ? 'LOCATING…' : 'FIND ON GLOBE'}
                </button>
                <button
                  type="button"
                  className="settings-secondary global-position-device"
                  onClick={useCurrentDevicePosition}
                  disabled={locationLoading}
                >
                  USE MY DEVICE
                </button>
              </div>

              <p id="global-position-help" className="global-position-privacy">
                Enter coordinates directly to keep the lookup local. Address searches run only when you choose FIND ON GLOBE; your device position is requested only when you choose USE MY DEVICE.
              </p>

              {locationResults.length > 0 && (
                <div className="global-position-results" role="listbox" aria-label="Location matches">
                  {locationResults.map(result => {
                    const selectedMatch = selectedLocation?.lat === result.lat && selectedLocation?.lon === result.lon
                    return (
                      <button
                        key={result.lat + ':' + result.lon + ':' + result.label}
                        type="button"
                        className={selectedMatch ? 'active' : ''}
                        role="option"
                        aria-selected={selectedMatch}
                        onClick={() => {
                          setSelectedLocation(result)
                          setLocationFeedback('Position selected. Confirm to save it to this local account.')
                        }}
                      >
                        <span>{result.shortLabel || 'UNNAMED POSITION'}</span>
                        <small>{result.label}</small>
                        <em>{(result.kind || 'PLACE') + ' · ' + formatCoordinate(result.lat) + ', ' + formatCoordinate(result.lon)}</em>
                      </button>
                    )
                  })}
                </div>
              )}

              <div className="position-coordinate-readout">
                <span>LAT {formatCoordinate(globeLatitude)}</span>
                <span>LON {formatCoordinate(globeLongitude)}</span>
                <strong>{selectedLocation ? 'READY TO SAVE' : hasLockedPosition ? 'SAVED ON THIS DEVICE' : 'NO POSITION SAVED'}</strong>
                {selectedLocation?.accuracy && (
                  <em>DEVICE PRECISION ABOUT {Math.max(1, Math.round(selectedLocation.accuracy))} M</em>
                )}
              </div>

              <div className="settings-actions">
                {selectedLocation ? (
                  <button type="button" className="settings-primary" onClick={confirmGlobalPosition}>
                    CONFIRM AND SAVE POSITION
                  </button>
                ) : (
                  <button type="button" className="settings-primary" onClick={saveWeather} disabled={!hasLockedPosition}>
                    REFRESH WEATHER
                  </button>
                )}
              </div>

              {locationFeedback && (
                <p className="global-position-feedback" role="status" aria-live="polite">
                  {locationFeedback}
                </p>
              )}
            </div>
          </div>
        </SettingsCard>
      </>
    )
  }

  function renderAppearance() {
    return (
      <SettingsCard title="Interface" kicker="APPEARANCE">
        <SettingRow title="Scala interfaccia" description="Regola testo e controlli in Ultron AI.">
          <div className="settings-range-wrap">
            <input type="range" min="90" max="125" step="5" value={preferences.scale} onChange={event => setPreference('scale', Number(event.target.value))} />
            <strong>{preferences.scale}%</strong>
          </div>
        </SettingRow>
        <SettingRow title="Ambient motion" description="Animate the dashboard background and interface feedback.">
          <Toggle label="Ambient motion" value={preferences.motionEnabled} onChange={value => setPreference('motionEnabled', value)} />
        </SettingRow>
        <SettingRow title="Icona Dock" description="Il simbolo del Neural Core di Ultron AI viene installato con l’app desktop.">
          <span className="settings-status online">● READY</span>
        </SettingRow>
      </SettingsCard>
    )
  }

  function renderIntegrations() {
    const printerState = printerStatus?.connected ? '● ONLINE' : '○ WAITING'
    return (
      <>
        <SettingsCard title="Obsidian" kicker="KNOWLEDGE VAULT">
          <div className="settings-field">
            <label>VAULT PATH</label>
            <input className="settings-input" value={obsidianPath} onChange={event => setObsidianPath(event.target.value)} placeholder="Select your local Obsidian vault" />
          </div>
          <div className="settings-actions">
            <button type="button" className="settings-primary" onClick={() => void saveVault()}>SAVE VAULT</button>
            <span className={`settings-status ${obsidianStatus?.connected ? 'online' : ''}`}>
              {obsidianStatus?.connected ? `● ${obsidianStatus.markdown_count} NOTES` : '○ NOT CONNECTED'}
            </span>
          </div>
          {obsidianFeedback && (
            <p className={`settings-feedback ${obsidianFeedbackTone === 'error' ? 'settings-error' : ''}`} role="status" aria-live="polite">
              {obsidianFeedback}
            </p>
          )}
        </SettingsCard>
        <SettingsCard title="Hardware" kicker="LOCAL DEVICES">
          <SettingRow title="Mac telemetry" description="CPU, memory, disk and network are read locally.">
            <span className={`settings-status ${backendOnline ? 'online' : ''}`}>{backendOnline ? '● ONLINE' : '○ OFFLINE'}</span>
          </SettingRow>
          <SettingRow title="3D printer" description="USB printer discovery is active when a compatible printer is connected.">
            <span className={`settings-status ${printerStatus?.connected ? 'online' : ''}`}>{printerState}</span>
          </SettingRow>
        </SettingsCard>
      </>
    )
  }

  function renderEmail() {
    const accountCount = emailStatus?.accounts?.length || 0
    const mailAvailable = Boolean(emailStatus?.available)
    const mailReady = Boolean(emailStatus?.ok && mailAvailable)
    const inboxAvailable = Boolean(mailReady && emailStatus?.configured)
    const mailLabel = !emailStatus
      ? '○ NOT CHECKED'
      : !mailAvailable
        ? '○ NOT FOUND'
        : !mailReady
          ? '○ PERMISSION REQUIRED'
          : !emailStatus?.configured
            ? '○ NO ACCOUNT'
            : '● READY'
    return (
      <>
        <SettingsCard title="Mail & Gmail" kicker="LOCAL ACCOUNT LINK">
          <SettingRow title="Accesso Google" description="Apri l’accesso Google nel browser. Su macOS puoi aggiungere Gmail anche da Account Internet. Ultron AI non conserva mai la password o i token Google.">
            <button type="button" className="settings-primary" onClick={connectGmail}>CONNECT GMAIL</button>
          </SettingRow>
          <SettingRow title="Local mail" description="macOS Mail can read configured accounts. Every desktop build can open Gmail and a reviewed draft in your own mail application.">
            <span className={`settings-status ${inboxAvailable ? 'online' : ''}`}>{mailLabel}</span>
          </SettingRow>
          <SettingRow title="Email command" description="Allow Agent Chat to check unread messages, read a selected message and prepare email drafts.">
            <Toggle label="Email command" value={Boolean(emailSkill?.enabled)} disabled={!emailSkill} onChange={value => updateSkill(emailSkill, { enabled: value })} />
          </SettingRow>
          <div className="email-actions">
            <button type="button" className="settings-secondary" onClick={loadEmailStatus}>CHECK STATUS</button>
            <button type="button" className="settings-primary" onClick={() => openEmail('mail')}>OPEN MAIL</button>
            <button type="button" className="settings-secondary" onClick={() => openEmail('gmail')}>OPEN GMAIL</button>
            <button type="button" className="settings-secondary" onClick={composeEmail}>NEW DRAFT</button>
          </div>
          <p className="settings-note">On macOS, Check status confirms the Mail account. Every message is prepared in Agent Chat and sends only after you press SEND NOW.</p>
          {emailFeedback && <p className="settings-feedback">{emailFeedback}</p>}
        </SettingsCard>
        <SettingsCard title="Inbox" kicker="ON-DEMAND READ">
          <div className="email-inbox-head">
            <div><strong>{accountCount}</strong><span>CONFIGURED ACCOUNTS</span></div>
            <button type="button" className="settings-secondary" onClick={loadInbox} disabled={emailLoading || !inboxAvailable}>
              {emailLoading ? 'LOADING…' : 'REFRESH INBOX'}
            </button>
          </div>
          <p className="settings-note">Recent messages are read only when you choose Refresh Inbox.</p>
          {emailMessages.length > 0 && (
            <div className="email-message-list">
              {emailMessages.map((message, index) => <EmailMessage key={`${message.id || message.subject || 'message'}-${index}`} message={message} />)}
            </div>
          )}
        </SettingsCard>
      </>
    )
  }

  function renderSkills() {
    return (
      <>
        <SettingsCard title="Skills" kicker="AUTOMATION">
          <div className="skills-summary">
            <div><strong>{enabledSkills}</strong><span>ACTIVE SKILLS</span></div>
            <div className="settings-actions">
              <button type="button" className="settings-secondary" onClick={loadSkills} disabled={skillsLoading}>REFRESH</button>
              <button type="button" className="settings-primary" onClick={() => { resetSkillEditor(); setShowSkillEditor(true) }}>+ ADD SKILL</button>
            </div>
          </div>
          {skillsError && <p className="settings-error">{skillsError}</p>}
          <div className="skills-list">
            {skills.map(skill => (
              <article className="skill-card" key={skill.id}>
                <div className="skill-card-copy">
                  <strong>{skill.name}</strong>
                  <span>{skill.description || 'No description.'}</span>
                  <small>COMMAND · {skill.trigger || '—'}</small>
                </div>
                <div className="skill-card-actions">
                  {!skill.builtin && <button type="button" className="skill-edit" onClick={() => editSkill(skill)}>EDIT</button>}
                  <Toggle label={`Enable ${skill.name}`} value={Boolean(skill.enabled)} onChange={value => updateSkill(skill, { enabled: value })} />
                  {!skill.builtin && <button type="button" className="skill-delete" onClick={() => deleteSkill(skill)}>DELETE</button>}
                </div>
              </article>
            ))}
          </div>
        </SettingsCard>
        {showSkillEditor && (
          <section className="skill-editor">
            <header className="skill-editor-head">
              <div><span>SKILL BUILDER</span><h3>{editingSkillId ? 'Edit skill' : 'Create skill'}</h3></div>
              <button type="button" className="settings-close" onClick={() => { resetSkillEditor(); setShowSkillEditor(false) }} aria-label="Close skill editor">×</button>
            </header>
            <form onSubmit={saveSkill}>
              <div className="settings-field"><label>NAME</label><input className="settings-input" value={skillName} onChange={event => setSkillName(event.target.value)} placeholder="Open Docker" /></div>
              <div className="settings-field"><label>DESCRIPTION</label><textarea className="settings-textarea" value={skillDescription} onChange={event => setSkillDescription(event.target.value)} placeholder="Open Docker Desktop." /></div>
              <div className="settings-field"><label>COMMAND</label><input className="settings-input" value={skillTrigger} onChange={event => setSkillTrigger(event.target.value)} placeholder="apri docker" /><small>La frase da dire a Ultron AI.</small></div>
              <div className="settings-field"><label>ACTION</label><select className="settings-select" value={skillAction} onChange={event => setSkillAction(event.target.value)}><option value="open_app">OPEN LOCAL APP</option><option value="open_url">OPEN URL</option><option value="research">WEB RESEARCH</option><option value="ask_ai">AI REQUEST</option></select></div>
              {renderSkillTarget()}
              <div className="settings-actions">
                <button type="button" className="settings-secondary" onClick={() => { resetSkillEditor(); setShowSkillEditor(false) }}>CANCEL</button>
                <button type="submit" className="settings-primary">{editingSkillId ? 'UPDATE SKILL' : 'SAVE SKILL'}</button>
              </div>
            </form>
          </section>
        )}
      </>
    )
  }

  function renderAdvanced() {
    return (
      <>
        <SettingsCard title="Local configuration" kicker="ADVANCED">
          <p className="settings-note">Interface preferences are stored locally on this Mac. The Neural Core configuration is left unchanged.</p>
          <div className="settings-actions">
            <button type="button" className="settings-secondary" onClick={() => setPreferences({ scale: 100, motionEnabled: true, voiceEnabled: true })}>RESET INTERFACE</button>
          </div>
        </SettingsCard>
        <SettingsCard title="Quick tour" kicker="GUIDED START">
          <SettingRow title="First-launch guide" description="Review the setup for your local account, Ollama, Obsidian, Mail, devices and privacy whenever you need it.">
            <button type="button" className="settings-primary" onClick={onOpenTutorial}>OPEN QUICK TOUR</button>
          </SettingRow>
        </SettingsCard>
      </>
    )
  }

  function renderSection() {
    if (activeSection === 'appearance') return renderAppearance()
    if (activeSection === 'integrations') return renderIntegrations()
    if (activeSection === 'email') return renderEmail()
    if (activeSection === 'skills') return renderSkills()
    if (activeSection === 'advanced') return renderAdvanced()
    return renderGeneral()
  }

  return (
    <div className="settings-workspace">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-title"><span>CONTROL CENTER</span><strong>SETTINGS</strong></div>
        <nav aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" className={activeSection === id ? 'active' : ''} onClick={() => setActiveSection(id)}>
              <span>{label}</span>{id === 'skills' && <em>{enabledSkills}</em>}
            </button>
          ))}
        </nav>
      </aside>
      <section className="settings-content">
        <header className="settings-header">
          <div><span>Ultron AI Control Center</span><h2>{SECTIONS.find(([id]) => id === activeSection)?.[1] || 'GENERAL'}</h2></div>
          <span className={`settings-header-status ${backendOnline ? 'online' : ''}`}>{backendOnline ? '● CORE ONLINE' : '○ CORE OFFLINE'}</span>
        </header>
        <div className="settings-scroll">
          <section className="settings-hero">
            <div>
              <span>CONTROL SURFACE // {activeSection.toUpperCase()}</span>
              <strong>Configure the system that powers your private intelligence network.</strong>
            </div>
            <div className="settings-hero-signals">
              <span><i className={backendOnline ? 'online' : ''} />CORE</span>
              <span><i className={obsidianStatus?.connected ? 'online' : ''} />VAULT</span>
              <span><i className={emailStatus?.configured ? 'online' : ''} />MAIL</span>
            </div>
          </section>
          {renderSection()}
        </div>
      </section>
    </div>
  )
}
