import { useEffect, useMemo, useState } from 'react'
import GlobalPositionGlobe from './GlobalPositionGlobe.jsx'
import { BACKEND_ORIGIN as BACKEND } from '../auth.js'

const SECTIONS = [
  ['general', 'GENERAL'],
  ['appearance', 'APPEARANCE'],
  ['integrations', 'INTEGRATIONS'],
  ['email', 'EMAIL'],
  ['skills', 'SKILLS'],
  ['advanced', 'ADVANCED'],
]

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
}) {
  const [activeSection, setActiveSection] = useState('general')
  const [skills, setSkills] = useState([])
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
  const hasLockedPosition = [globeLatitude, globeLongitude].every(value => (
    value !== '' && value !== null && value !== undefined
  ))

  useEffect(() => {
    void loadSkills()
  }, [])

  useEffect(() => {
    if (!selectedLocation && weatherConfig?.label && weatherConfig.label !== 'LOCAL AREA') {
      setLocationQuery(weatherConfig.label)
    }
  }, [weatherConfig?.label, selectedLocation])

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

    if (query.length < 2) {
      setLocationFeedback('Enter a city, address or place name first.')
      setLocationResults([])
      setSelectedLocation(null)
      return
    }

    setLocationLoading(true)
    setLocationFeedback('')
    setLocationResults([])
    setSelectedLocation(null)

    try {
      const response = await fetch(`${BACKEND}/api/location/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const result = await readJson(response)

      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Location lookup unavailable.')
      }

      const matches = Array.isArray(result.results) ? result.results : []
      setLocationResults(matches)

      if (!matches.length) {
        setLocationFeedback('No global position matched this request.')
        return
      }

      setSelectedLocation(matches[0])
      setLocationFeedback('Choose the exact match, then confirm the global position.')
    } catch (error) {
      setLocationFeedback(error?.message || 'Location lookup unavailable.')
    } finally {
      setLocationLoading(false)
    }
  }

  function confirmGlobalPosition() {
    if (!selectedLocation) return

    onSaveGlobalPosition?.(selectedLocation)
    setLocationQuery(selectedLocation.label || selectedLocation.shortLabel || '')
    setLocationFeedback('Global position locked locally. Weather telemetry is updating.')
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
      setSkillsError(error?.message || 'ULTRON Core is unavailable.')
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

  async function chooseMacApp() {
    setSkillsError('')
    try {
      const response = await fetch(`${BACKEND}/api/system/choose-app`)
      const result = await readJson(response)
      if (result.cancelled) return
      if (!response.ok || !result.ok || !result.path) {
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
              placeholder="/Applications/YourApp.app"
            />
            <button type="button" className="settings-secondary" onClick={chooseMacApp}>
              CHOOSE APP
            </button>
          </div>
          <small>Choose an installed macOS application.</small>
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
          ? 'The command will send its text to ULTRON Web Research.'
          : 'The command will continue in the normal ULTRON conversation.'}
      </p>
    )
  }

  function renderGeneral() {
    return (
      <>
        <SettingsCard title="Core status" kicker="LOCAL ASSISTANT">
          <SettingRow title="ULTRON Core" description="The local backend that powers chat, memory and telemetry.">
            <span className={`settings-status ${backendOnline ? 'online' : ''}`}>
              {backendOnline ? '● ONLINE' : '○ OFFLINE'}
            </span>
          </SettingRow>
          <SettingRow title="Voice replies" description="Speak ULTRON replies through the configured voice.">
            <Toggle
              label="Voice replies"
              value={preferences.voiceEnabled}
              onChange={value => setPreference('voiceEnabled', value)}
            />
          </SettingRow>
        </SettingsCard>
        <SettingsCard title="Global position" kicker="WORLD CONTROL">
          <div className="global-position-layout">
            <GlobalPositionGlobe
              latitude={globeLatitude}
              longitude={globeLongitude}
              label={selectedLocation?.shortLabel || weatherConfig.label}
              active={Boolean(selectedLocation || hasLockedPosition)}
            />

            <div className="global-position-command">
              <div className="settings-field">
                <label>LOCATION OR PRECISE ADDRESS</label>
                <input
                  className="settings-input"
                  value={locationQuery}
                  onChange={event => {
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
                  placeholder="City, street or landmark…"
                />
              </div>

              <button
                type="button"
                className="settings-primary global-position-locate"
                onClick={() => void locatePosition()}
                disabled={locationLoading || locationQuery.trim().length < 2}
              >
                {locationLoading ? 'LOCATING…' : 'LOCATE ON GLOBE'}
              </button>

              <p className="global-position-privacy">Address lookup runs only when you press LOCATE ON GLOBE.</p>

              {locationResults.length > 0 && (
                <div className="global-position-results" role="listbox" aria-label="Location matches">
                  {locationResults.map(result => {
                    const selectedMatch = selectedLocation?.lat === result.lat && selectedLocation?.lon === result.lon
                    return (
                      <button
                        key={`${result.lat}:${result.lon}:${result.label}`}
                        type="button"
                        className={selectedMatch ? 'active' : ''}
                        aria-pressed={selectedMatch}
                        onClick={() => setSelectedLocation(result)}
                      >
                        <span>{result.shortLabel || 'UNNAMED POSITION'}</span>
                        <small>{result.label}</small>
                        <em>{result.kind || 'PLACE'}</em>
                      </button>
                    )
                  })}
                </div>
              )}

              <div className="position-coordinate-readout">
                <span>LAT {Number(globeLatitude ?? 0).toFixed(5)}</span>
                <span>LON {Number(globeLongitude ?? 0).toFixed(5)}</span>
                <strong>{selectedLocation ? 'POSITION STAGED' : hasLockedPosition ? 'POSITION LOCKED' : 'NO POSITION LOCK'}</strong>
              </div>

              <div className="settings-actions">
                {selectedLocation ? (
                  <button type="button" className="settings-primary" onClick={confirmGlobalPosition}>
                    CONFIRM GLOBAL POSITION
                  </button>
                ) : (
                  <button type="button" className="settings-primary" onClick={saveWeather} disabled={!hasLockedPosition}>
                    REFRESH WEATHER LINK
                  </button>
                )}
              </div>

              {locationFeedback && <p className="global-position-feedback">{locationFeedback}</p>}
            </div>
          </div>
        </SettingsCard>
      </>
    )
  }

  function renderAppearance() {
    return (
      <SettingsCard title="Interface" kicker="APPEARANCE">
        <SettingRow title="Interface scale" description="Adjust text and controls across ULTRON.">
          <div className="settings-range-wrap">
            <input type="range" min="90" max="125" step="5" value={preferences.scale} onChange={event => setPreference('scale', Number(event.target.value))} />
            <strong>{preferences.scale}%</strong>
          </div>
        </SettingRow>
        <SettingRow title="Ambient motion" description="Animate the dashboard background and interface feedback.">
          <Toggle label="Ambient motion" value={preferences.motionEnabled} onChange={value => setPreference('motionEnabled', value)} />
        </SettingRow>
        <SettingRow title="Dock icon" description="The ULTRON neural-core mark is installed with the desktop app.">
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
            <button type="button" className="settings-primary" onClick={saveObsidian}>SAVE VAULT</button>
            <span className={`settings-status ${obsidianStatus?.connected ? 'online' : ''}`}>
              {obsidianStatus?.connected ? `● ${obsidianStatus.markdown_count} NOTES` : '○ NOT CONNECTED'}
            </span>
          </div>
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
          <SettingRow title="Google sign-in" description="Connect Gmail through macOS Internet Accounts. ULTRON never stores your Google password or token.">
            <button type="button" className="settings-primary" onClick={connectGmail}>CONNECT GMAIL</button>
          </SettingRow>
          <SettingRow title="Mail.app" description="Use the accounts already configured on this Mac for reading, drafting and approved transmissions.">
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
          <p className="settings-note">After signing in, use Check status to confirm the account. Every message is prepared in Agent Chat and sends only after you press SEND NOW.</p>
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
                  <button type="button" className="skill-edit" onClick={() => editSkill(skill)}>EDIT</button>
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
              <div className="settings-field"><label>COMMAND</label><input className="settings-input" value={skillTrigger} onChange={event => setSkillTrigger(event.target.value)} placeholder="apri docker" /><small>The phrase you say to ULTRON.</small></div>
              <div className="settings-field"><label>ACTION</label><select className="settings-select" value={skillAction} onChange={event => setSkillAction(event.target.value)}><option value="open_app">OPEN MAC APP</option><option value="open_url">OPEN URL</option><option value="research">WEB RESEARCH</option><option value="ask_ai">AI REQUEST</option></select></div>
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
      <SettingsCard title="Local configuration" kicker="ADVANCED">
        <p className="settings-note">Interface preferences are stored locally on this Mac. The Neural Core configuration is left unchanged.</p>
        <div className="settings-actions">
          <button type="button" className="settings-secondary" onClick={() => setPreferences({ scale: 100, motionEnabled: true, voiceEnabled: true })}>RESET INTERFACE</button>
        </div>
      </SettingsCard>
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
          <div><span>ULTRON CONTROL CENTER</span><h2>{SECTIONS.find(([id]) => id === activeSection)?.[1] || 'GENERAL'}</h2></div>
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
