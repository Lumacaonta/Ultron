import DevicesPage from './components/DevicesPage.jsx'
import MemoryPage from './components/MemoryPage.jsx'
import SettingsPage from './components/SettingsPage.jsx'
import OnboardingTutorial from './components/OnboardingTutorial.jsx'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BACKEND_ORIGIN as BACKEND } from './auth.js'
import './App.css'
import { CORE_NODES, describeCoreNode } from './components/neuralCoreData.js'

const ModelDeckPage = lazy(() => import('./components/ModelDeckPage.jsx'))
const NeuralCore = lazy(() => import('./components/NeuralCore.jsx'))

const INITIAL_CHAT_TIMESTAMP = Date.now()

const DEFAULT_PREFERENCES = {
  scale: 100,
  motionEnabled: true,
  voiceEnabled: true,
}

const DEFAULT_WEATHER_CONFIG = {
  label: 'LOCAL AREA',
  lat: '',
  lon: '',
}

function weatherIcon(code) {
  const value = Number(code)

  if (!Number.isFinite(value)) return '☁'
  if (value === 0) return '☀'
  if (value === 1 || value === 2) return '⛅'
  if (value === 3) return '☁'
  if (value === 45 || value === 48) return '〰'
  if (value >= 51 && value <= 57) return '🌦'
  if (value >= 61 && value <= 67) return '🌧'
  if (value >= 71 && value <= 77) return '❄'
  if (value >= 80 && value <= 82) return '🌧'
  if (value >= 85 && value <= 86) return '🌨'
  if (value >= 95) return '⛈'

  return '☁'
}

const NAVIGATION_ITEMS = [
  { id: 'AGENT', label: 'Agent', icon: 'agent' },
  { id: 'MEMORY', label: 'Memory', icon: 'memory' },
  { id: 'DEVICES', label: 'Devices', icon: 'devices' },
  { id: 'SETTINGS', label: 'Settings', icon: 'settings' },
]

function loadPreferences(storageKey) {
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey) || '{}'
    )

    return {
      ...DEFAULT_PREFERENCES,
      ...saved,
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function loadWeatherConfig(storageKey) {
  try {
    const saved = localStorage.getItem(storageKey)

    if (!saved) return { ...DEFAULT_WEATHER_CONFIG }

    const config = JSON.parse(saved)
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { ...DEFAULT_WEATHER_CONFIG }
    }

    return {
      label: typeof config.label === 'string' ? config.label : DEFAULT_WEATHER_CONFIG.label,
      lat: config.lat ?? '',
      lon: config.lon ?? '',
    }
  } catch {
    return { ...DEFAULT_WEATHER_CONFIG }
  }
}

const ONBOARDING_VERSION = '1'

function onboardingStorageKey(accountScope) {
  return `ultron-onboarding:${accountScope}:v${ONBOARDING_VERSION}`
}

function shouldShowOnboarding(accountScope) {
  try {
    return localStorage.getItem(onboardingStorageKey(accountScope)) !== 'complete'
  } catch {
    // A locked-down browser cannot remember completion, but the guide remains usable.
    return true
  }
}

function markOnboardingComplete(accountScope) {
  try {
    localStorage.setItem(onboardingStorageKey(accountScope), 'complete')
  } catch {
    // Do not block the interface if browser storage is unavailable.
  }
}

function createChatMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createChatMessageTimestamp() {
  return Date.now()
}

function hasStoredCoordinates(config = {}) {
  return [config?.lat, config?.lon].every(value => (
    value !== '' && value !== null && value !== undefined
  ))
}

let currentFishAudio = null

async function speakWithFish(text) {

  const clean =
    String(text || "").trim()

  if (!clean) {
    return
  }

  try {

    if (currentFishAudio) {
      try {
        currentFishAudio.pause()
        currentFishAudio.currentTime = 0
      } catch {
        // Ignore cleanup errors.
      }
    }

    const url =
      `${BACKEND}/api/tts/stream?text=${
        encodeURIComponent(clean)
      }`

    const audio =
      new Audio(url)

    audio.preload = "auto"

    currentFishAudio = audio

    audio.addEventListener(
      "ended",
      () => {
        if (currentFishAudio === audio) {
          currentFishAudio = null
        }
      },
      { once: true }
    )

    audio.addEventListener(
      "error",
      () => {
        console.warn(
          "Fish Audio playback failed."
        )

        if (currentFishAudio === audio) {
          currentFishAudio = null
        }
      },
      { once: true }
    )

    await audio.play()

  } catch (error) {

    console.warn(
      "Fish TTS unavailable:",
      error
    )
  }
}


function NavIcon({ name }) {
  const iconProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.7',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  if (name === 'memory') {
    return (
      <svg {...iconProps}>
        <path d="M5 7.5 12 4l7 3.5-7 3.5-7-3.5Z" />
        <path d="M5 12l7 3.5 7-3.5" />
        <path d="M5 16.5 12 20l7-3.5" />
      </svg>
    )
  }

  if (name === 'devices') {
    return (
      <svg {...iconProps}>
        <rect x="4" y="4" width="16" height="11" rx="2" />
        <path d="M9 20h6M12 15v5" />
        <path d="M8 8h.01M12 8h.01M16 8h.01" />
      </svg>
    )
  }

  if (name === 'settings') {
    return (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.1 2.1-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56v.1h-3v-.1a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.1-2.1.06-.06A1.7 1.7 0 0 0 7.04 15 1.7 1.7 0 0 0 5.5 13.96h-.1v-3h.1A1.7 1.7 0 0 0 7.04 9.4a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.1-2.1.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.04-1.56v-.1h3v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.1 2.1-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.04h.1v3h-.1A1.7 1.7 0 0 0 19.4 15Z" />
      </svg>
    )
  }

  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="7" />
      <path d="M9.4 12h5.2M12 9.4v5.2" />
      <path d="M5 5l2.1 2.1M19 5l-2.1 2.1" />
    </svg>
  )
}


function formatChatTime(value) {
  const date = new Date(value || Date.now())

  return date.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function MemoryProposalCard({ proposal, onCommit, onDiscard }) {
  const status = proposal?.status || 'pending'
  const items = Array.isArray(proposal?.items) ? proposal.items : []
  const isSaving = status === 'saving'
  const isDone = status === 'saved' || status === 'discarded'

  return (
    <section className={`agent-action-card memory-proposal ${status}`}>
      <header>
        <span>MEMORY STAGING AREA</span>
        <strong>{status === 'saved' ? 'CORE UPDATED' : status === 'discarded' ? 'DISCARDED' : 'CONFIRM REQUIRED'}</strong>
      </header>
      <div className="memory-proposal-list">
        {items.map((item, index) => (
          <div key={`${item.subject}-${item.predicate}-${index}`}>
            <span>{item.subject}</span>
            <i>{item.predicate}</i>
            <strong>{item.object}</strong>
          </div>
        ))}
      </div>
      {proposal?.error && <p className="agent-action-error">{proposal.error}</p>}
      {!isDone && (
        <div className="agent-action-controls">
          <button
            type="button"
            className="agent-action-primary"
            onClick={() => onCommit(proposal)}
            disabled={isSaving}
          >
            {isSaving ? 'SYNCING…' : 'ADD TO NEURAL CORE'}
          </button>
          <button
            type="button"
            className="agent-action-secondary"
            onClick={() => onDiscard(proposal)}
            disabled={isSaving}
          >
            DISCARD
          </button>
        </div>
      )}
    </section>
  )
}

function ObsidianArchiveCard({ archive }) {
  const ok = Boolean(archive?.ok)
  const saved = Number(archive?.saved || 0)

  return (
    <section className={`agent-action-card obsidian-archive ${ok ? 'saved' : 'failed'}`}>
      <header>
        <span>OBSIDIAN VAULT</span>
        <strong>{ok ? 'ARCHIVED' : 'ARCHIVE FAILED'}</strong>
      </header>
      {ok ? (
        <div className="obsidian-archive-details">
          <strong>{archive.title || 'NEURAL CORE ENTRY'}</strong>
          <span>{archive.path || 'ULTRON/Neural Core.md'}</span>
          <em>{saved ? `${saved} CORE LINK${saved === 1 ? '' : 'S'} UPDATED` : 'VAULT ENTRY SAVED'}</em>
        </div>
      ) : (
        <p className="agent-action-error">
          {archive?.error || 'Connect an Obsidian vault in Settings first.'}
        </p>
      )}
    </section>
  )
}

function EmailDraftCard({ draft, onSend }) {
  const status = draft?.status || 'pending'
  const canSend = status === 'pending' || status === 'failed'

  return (
    <section className={`agent-action-card email-draft ${status}`}>
      <header>
        <span>OUTBOUND TRANSMISSION</span>
        <strong>{status === 'sent' ? 'SENT' : status === 'sending' ? 'TRANSMITTING' : 'REVIEW REQUIRED'}</strong>
      </header>
      <dl className="email-draft-details">
        <div><dt>TO</dt><dd>{(draft?.to || []).join(', ')}</dd></div>
        <div><dt>SUBJECT</dt><dd>{draft?.subject || '(no subject)'}</dd></div>
        <div><dt>MESSAGE</dt><dd>{draft?.body || '(no message)'}</dd></div>
      </dl>
      {draft?.error && <p className="agent-action-error">{draft.error}</p>}
      {canSend && (
        <div className="agent-action-controls">
          <button
            type="button"
            className="agent-action-primary"
            onClick={() => onSend(draft)}
            disabled={status === 'sending'}
          >
            {status === 'sending' ? 'TRANSMITTING…' : 'SEND NOW'}
          </button>
        </div>
      )}
    </section>
  )
}

function normaliseVoiceText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function getVoiceRecognitionConstructor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function useUltronVoice({ onCommand, onWake }) {
  const [supported, setSupported] = useState(() => Boolean(getVoiceRecognitionConstructor()))
  const [phase, setPhase] = useState('off')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const recognitionRef = useRef(null)
  const shouldRunRef = useRef(false)
  const phaseRef = useRef('off')
  const draftRef = useRef('')
  const silenceTimerRef = useRef(0)
  const restartTimerRef = useRef(0)
  const dispatchingRef = useRef(false)
  const onCommandRef = useRef(onCommand)
  const onWakeRef = useRef(onWake)

  useEffect(() => {
    onCommandRef.current = onCommand
    onWakeRef.current = onWake
  }, [onCommand, onWake])

  function setVoicePhase(next) {
    phaseRef.current = next
    setPhase(next)
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = 0
    }
  }

  function clearRestartTimer() {
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current)
      restartTimerRef.current = 0
    }
  }

  function startRecognition() {
    const Recognition = getVoiceRecognitionConstructor()

    if (!Recognition || !shouldRunRef.current || dispatchingRef.current) {
      return
    }

    setSupported(true)

    if (!recognitionRef.current) {
      const recognition = new Recognition()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'it-IT'
      recognition.maxAlternatives = 1

      recognition.onresult = event => {
        let interim = ''

        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          const phrase = String(result?.[0]?.transcript || '').trim()

          if (!phrase) continue

          if (!result.isFinal) {
            interim = phrase
            continue
          }

          ingestFinalPhrase(phrase)
        }

        if (interim) {
          clearSilenceTimer()
          setLiveTranscript(interim)
        }
      }

      recognition.onspeechstart = () => {
        clearSilenceTimer()
      }

      recognition.onspeechend = () => {
        if (phaseRef.current === 'listening' && draftRef.current) {
          scheduleDispatch()
        }
      }

      recognition.onerror = event => {
        const code = event?.error || 'voice-error'

        if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(code)) {
          shouldRunRef.current = false
          clearSilenceTimer()
          setVoicePhase('error')
          setError(code === 'not-allowed'
            ? 'Microphone access was not granted.'
            : 'Voice channel is unavailable.')
          return
        }

        if (code !== 'aborted' && code !== 'no-speech') {
          setError('Voice channel interrupted. Retrying…')
        }
      }

      recognition.onend = () => {
        if (!shouldRunRef.current || dispatchingRef.current || phaseRef.current === 'error') {
          return
        }

        clearRestartTimer()
        restartTimerRef.current = window.setTimeout(() => {
          startRecognition()
        }, 260)
      }

      recognitionRef.current = recognition
    }

    try {
      recognitionRef.current.start()
    } catch (startError) {
      if (startError?.name !== 'InvalidStateError') {
        setError('Unable to start the voice channel.')
      }
    }
  }

  function appendFragment(fragment) {
    const clean = String(fragment || '').replace(/\s+/g, ' ').trim()
    if (!clean) return

    const next = [draftRef.current, clean].filter(Boolean).join(' ').trim()
    draftRef.current = next
    setDraft(next)
    setLiveTranscript('')
    setVoicePhase('listening')
    scheduleDispatch()
  }

  function scheduleDispatch() {
    clearSilenceTimer()

    if (phaseRef.current !== 'listening' || !draftRef.current) return

    silenceTimerRef.current = window.setTimeout(async () => {
      const command = draftRef.current.trim()

      if (!command || phaseRef.current !== 'listening' || dispatchingRef.current) return

      dispatchingRef.current = true
      setVoicePhase('sending')
      setLiveTranscript('')

      try {
        if (recognitionRef.current) {
          recognitionRef.current.abort()
        }
      } catch {}

      try {
        await onCommandRef.current?.(command)
        draftRef.current = ''
        setDraft('')
        setError('')
      } finally {
        dispatchingRef.current = false

        if (shouldRunRef.current) {
          setVoicePhase('armed')
          restartTimerRef.current = window.setTimeout(startRecognition, 360)
        } else {
          setVoicePhase('off')
        }
      }
    }, 5000)
  }

  function ingestFinalPhrase(phrase) {
    const original = String(phrase || '').replace(/\s+/g, ' ').trim()
    const normalized = normaliseVoiceText(original).toLowerCase()

    if (!original || !shouldRunRef.current) return

    clearSilenceTimer()
    setLiveTranscript(original)

    const waitingForCommand = phaseRef.current === 'holding' || phaseRef.current === 'listening'
    const hasWakeWord = /\bultron\b/.test(normalized)
    const holdMatch = normalized.match(/\bultron\s+aspetta\b/)

    if (!waitingForCommand) {
      if (!hasWakeWord) return

      const commandAfterWake = original
        .replace(/^.*?\bultron\b\s*/i, '')
        .replace(/^aspetta\b[\s,:;.!-]*/i, '')
        .trim()

      if (holdMatch || !commandAfterWake) {
        setVoicePhase('holding')
        setLiveTranscript('')
        onWakeRef.current?.()
        return
      }

      appendFragment(commandAfterWake)
      return
    }

    const fragment = hasWakeWord
      ? original.replace(/^.*?\bultron\b\s*/i, '').trim()
      : original

    if (normaliseVoiceText(fragment).toLowerCase() === 'aspetta') {
      setVoicePhase('holding')
      onWakeRef.current?.()
      return
    }

    appendFragment(fragment)
  }

  function start() {
    const Recognition = getVoiceRecognitionConstructor()

    if (!Recognition) {
      setSupported(false)
      setVoicePhase('error')
      setError('Voice input is not available in this runtime.')
      return
    }

    shouldRunRef.current = true
    dispatchingRef.current = false
    draftRef.current = ''
    setDraft('')
    setLiveTranscript('')
    setError('')
    setVoicePhase('armed')
    startRecognition()
  }

  function stop() {
    shouldRunRef.current = false
    dispatchingRef.current = false
    clearSilenceTimer()
    clearRestartTimer()
    draftRef.current = ''
    setDraft('')
    setLiveTranscript('')
    setError('')
    setVoicePhase('off')

    try {
      recognitionRef.current?.abort()
    } catch {}
  }

  useEffect(() => {
    return () => {
      shouldRunRef.current = false
      clearSilenceTimer()
      clearRestartTimer()

      if (recognitionRef.current) {
        recognitionRef.current.onresult = null
        recognitionRef.current.onend = null
        recognitionRef.current.onerror = null
        try {
          recognitionRef.current.abort()
        } catch {}
      }
    }
  }, [])

  return {
    supported,
    phase,
    liveTranscript,
    draft,
    error,
    start,
    stop,
  }
}

function AgentChat({
  messages,
  input,
  setInput,
  sending,
  onSend,
  onCommitMemory,
  onDiscardMemory,
  onSendEmail,
  obsidianArmed,
  onToggleObsidian,
  voice,
}) {
  function submit() {
    const value = input.trim()

    if (!value || sending) {
      return
    }

    onSend(value, {
      archiveToObsidian: obsidianArmed,
    })
  }

  function handleKeyDown(event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="agent-chat">
      <div className="agent-chat-head">
        <div className="agent-identity">
          <span>PRIVATE CHANNEL // 01</span>
          <strong>AGENT CONSOLE</strong>
        </div>
        <button
          type="button"
          className={`agent-channel-state agent-vault-toggle ${obsidianArmed ? 'armed' : ''}`}
          onClick={onToggleObsidian}
          disabled={sending}
          aria-pressed={obsidianArmed}
          title="Archive the next command in the connected Obsidian vault"
        >
          <i />
          <em>{obsidianArmed ? 'VAULT ARMED' : 'VAULT'}</em>
        </button>
      </div>

      <div className="agent-messages">
        {messages.map((message, index) => (
          <div
            key={message.id || `${message.role}-${index}`}
            className={`agent-message ${message.role}`}
          >
            <div className="agent-message-meta">
              <span className="agent-message-role">
                {message.role === "user"
                  ? "YOU"
                  : "ULTRON"}
              </span>
              <time>{formatChatTime(message.createdAt)}</time>
            </div>

            <div className="agent-message-text">
              {message.text}
            </div>

            {message.memoryProposal && (
              <MemoryProposalCard
                proposal={message.memoryProposal}
                onCommit={proposal => onCommitMemory(message.id, proposal)}
                onDiscard={proposal => onDiscardMemory(message.id, proposal)}
              />
            )}

            {message.emailDraft && (
              <EmailDraftCard
                draft={message.emailDraft}
                onSend={draft => onSendEmail(message.id, draft)}
              />
            )}

            {message.obsidianArchive && (
              <ObsidianArchiveCard
                archive={message.obsidianArchive}
              />
            )}
          </div>
        ))}

        {sending && (
          <div className="agent-message assistant">
            <span className="agent-message-role">
              ULTRON
            </span>

            <div className="agent-thinking">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      {(voice.liveTranscript || voice.draft || voice.error) && (
        <div className={`agent-voice-readout ${voice.phase === 'error' ? 'error' : ''}`}>
          <span>{voice.error ? 'VOICE LINK // ERROR' : `VOICE LINK // ${voice.phase.toUpperCase()}`}</span>
          <strong>{voice.error || voice.liveTranscript || voice.draft}</strong>
        </div>
      )}

      <div className="agent-input-wrap">
        <textarea
          value={input}
          onChange={(event) =>
            setInput(event.target.value)
          }
          onKeyDown={handleKeyDown}
          placeholder="Issue command…"
          rows={1}
          disabled={sending}
        />

        <button
          type="button"
          className={`agent-voice ${voice.phase !== 'off' ? 'active' : ''}`}
          onClick={voice.phase === 'off' || voice.phase === 'error' ? voice.start : voice.stop}
          disabled={!voice.supported && voice.phase === 'off'}
          title={voice.supported ? 'Arm ULTRON voice command' : 'Voice input unavailable'}
          aria-label={voice.supported ? 'Arm ULTRON voice command' : 'Voice input unavailable'}
        >
          <span>◉</span>
        </button>
      </div>

      <div className="agent-hint">
        {obsidianArmed
          ? 'VAULT ARMED // ENTER COMMITS THIS COMMAND TO OBSIDIAN'
          : voice.supported
            ? (voice.phase === 'off' ? 'ENTER // EXECUTE · MIC TO ADDRESS ULTRON' : `VOICE // ${voice.phase.toUpperCase()} · 5S SILENCE TO EXECUTE`)
            : 'ENTER // EXECUTE · VOICE UNAVAILABLE'}
      </div>
    </div>
  )
}


function SystemCard({
  label,
  value,
  sub = "",
  progress,
  values = [],
}) {
  const points = Array.isArray(values)
    ? values
        .filter(
          item =>
            typeof item === "number" &&
            Number.isFinite(item)
        )
    : []

  const normalized =
    points.length > 0
      ? points
      : [0]

  const min = Math.min(...normalized)
  const max = Math.max(...normalized)
  const range =
    max - min === 0
      ? 1
      : max - min

  const width = 180
  const height = 42
  const pad = 3

  const polyline = normalized
    .map((point, index) => {
      const x =
        normalized.length === 1
          ? width / 2
          : pad +
            (index /
              (normalized.length - 1)) *
              (width - pad * 2)

      const y =
        height -
        pad -
        ((point - min) / range) *
          (height - pad * 2)

      return `${x},${y}`
    })
    .join(" ")

  const safeProgress =
    typeof progress === "number" &&
    Number.isFinite(progress)
      ? Math.max(
          0,
          Math.min(100, progress)
        )
      : null

  return (
    <section className="ultron-metric-card">
      <div className="ultron-metric-card-top">
        <div>
          <div className="ultron-metric-card-label">
            {label}
          </div>

          {sub && (
            <div className="ultron-metric-card-sub">
              {sub}
            </div>
          )}
        </div>

        <div className="ultron-metric-card-value">
          {value}
        </div>
      </div>

      {safeProgress !== null && (
        <div className="ultron-metric-card-progress">
          <div
            className="ultron-metric-card-progress-fill"
            style={{
              width:
                `${safeProgress}%`,
            }}
          />
        </div>
      )}

      {points.length > 0 && (
        <svg
          className="ultron-metric-card-chart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id={`system-gradient-${label}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor="#ff2727"
                stopOpacity=".28"
              />
              <stop
                offset="100%"
                stopColor="#ff2727"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>

          <polyline
            points={polyline}
            fill="none"
            stroke="#ff2727"
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
          />

          <polyline
            points={`0,${height} ${polyline} ${width},${height}`}
            fill={`url(#system-gradient-${label})`}
            stroke="none"
          />
        </svg>
      )}

      {!points.length &&
        safeProgress === null && (
          <div className="ultron-metric-card-empty">
            NO SENSOR DATA
          </div>
        )}
    </section>
  )
}


function App({ user = null, onLogout = () => {} }) {
  const accountScope = String(
    user?.id || user?.email || 'local-operator'
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')

  const preferencesStorageKey = `ultron-preferences:${accountScope}`
  const weatherStorageKey = `ultron-weather:${accountScope}`
  const accountName = String(
    user?.display_name || user?.displayName || user?.email || 'LOCAL OPERATOR'
  )

  const [activePage, setActivePage] =
    useState('AGENT')

  const [onboardingOpen, setOnboardingOpen] =
    useState(() => shouldShowOnboarding(accountScope))

  const [selected, setSelected] =
    useState(() => describeCoreNode(CORE_NODES[0]))

  const [system, setSystem] =
    useState(null)

  const [history, setHistory] =
    useState({
      cpu: [],
      ram: [],
      download: [],
      upload: [],
    })

  const [time, setTime] =
    useState('')

  const [date, setDate] =
    useState('')

  const [weather, setWeather] =
    useState(null)

  const [agentMessages, setAgentMessages] =
    useState([
      {
        id: 'ultron-bootstrap',
        role: "assistant",
        text: "ULTRON online. I'm listening.",
        speak: false,
        createdAt: INITIAL_CHAT_TIMESTAMP,
      },
    ])

  const agentMessagesRef = useRef(agentMessages)
  const agentSendingRef = useRef(false)

  const [agentInput, setAgentInput] =
    useState("")

  const [agentSending, setAgentSending] =
    useState(false)

  const [obsidianArmed, setObsidianArmed] =
    useState(false)

  const [printerStatus, setPrinterStatus] =
    useState({
      connected: false,
      status: 'NOT CONNECTED',
      port: null,
      progress: null,
    })

  const [preferences, setPreferences] =
    useState(() => loadPreferences(preferencesStorageKey))

  const [backendOnline, setBackendOnline] =
    useState(false)

  const [isRefreshing, setIsRefreshing] =
    useState(false)


  const [obsidianPath, setObsidianPath] =
    useState('')

  const [obsidianStatus, setObsidianStatus] =
    useState({
      connected: false,
      markdown_count: 0,
    })

  const [obsidianGraph, setObsidianGraph] =
    useState({
      nodes: [],
      edges: [],
    })

  const [weatherConfig, setWeatherConfig] =
    useState(() => loadWeatherConfig(weatherStorageKey))

  useEffect(() => {
    agentMessagesRef.current = agentMessages
  }, [agentMessages])

  useEffect(() => {
    localStorage.setItem(
      preferencesStorageKey,
      JSON.stringify(preferences)
    )

    document.documentElement.style.setProperty(
      '--ultron-ui-scale',
      String(preferences.scale / 100)
    )

    document.documentElement.classList.toggle(
      'ultron-reduced-motion',
      !preferences.motionEnabled
    )
  }, [preferences, preferencesStorageKey])

  useEffect(() => {
    const updateClock = () => {
      const now =
        new Date()

      setTime(
        new Intl.DateTimeFormat(
          'it-IT',
          {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }
        ).format(now)
      )

      setDate(
        new Intl.DateTimeFormat(
          'it-IT',
          {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          }
        ).format(now)
      )
    }

    updateClock()

    const interval =
      setInterval(
        updateClock,
        1000
      )

    return () =>
      clearInterval(
        interval
      )
  }, [])

  async function loadSystem() {
    try {
      const response =
        await fetch(
          `${BACKEND}/api/system`
        )

      if (!response.ok) {
        setBackendOnline(false)
        return
      }

      const data =
        await response.json()

      setSystem(data)
      setBackendOnline(true)

      setHistory(
        previous => ({
          cpu: [
            ...previous.cpu,
            data.cpu_percent,
          ].slice(-40),

          ram: [
            ...previous.ram,
            data.ram_percent,
          ].slice(-40),

          download: [
            ...previous.download,
            data.download_mbps,
          ].slice(-40),

          upload: [
            ...previous.upload,
            data.upload_mbps,
          ].slice(-40),
        })
      )
    } catch {
      setBackendOnline(false)
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadSystem()
    }, 0)

    const interval =
      setInterval(
        loadSystem,
        1500
      )

    return () => {
      window.clearTimeout(initialLoad)
      clearInterval(
        interval
      )
    }
  }, [])

  async function loadPrinterStatus() {
    try {
      const response =
        await fetch(
          `${BACKEND}/api/printer/status`
        )

      if (!response.ok)
        return

      const data =
        await response.json()

      setPrinterStatus(data)
    } catch {
      setPrinterStatus({
        connected: false,
        status: 'NOT CONNECTED',
        port: null,
        progress: null,
      })
    }
  }

  async function refreshDevices() {
    if (isRefreshing) return

    setIsRefreshing(true)

    try {
      await Promise.all([
        loadSystem(),
        loadPrinterStatus(),
      ])
    } finally {
      setIsRefreshing(false)
    }
  }

  async function openMakerWorld() {
    try {
      const response = await fetch(
        `${BACKEND}/api/system/open-makerworld`,
        { method: 'POST' }
      )

      if (!response.ok) {
        throw new Error('MakerWorld unavailable')
      }
    } catch {
      window.open(
        'https://makerworld.com/',
        '_blank',
        'noopener,noreferrer'
      )
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadPrinterStatus()
    }, 0)

    const timer =
      setInterval(
        loadPrinterStatus,
        2500
      )

    return () => {
      window.clearTimeout(initialLoad)
      clearInterval(timer)
    }
  }, [])

  async function archiveChatMessage(text) {
    try {
      const response = await fetch(`${BACKEND}/api/obsidian/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const result = await response.json().catch(() => ({}))

      if (!response.ok || !result.ok) {
        return {
          ok: false,
          error: result.detail || result.error || 'ULTRON could not write this command to Obsidian.',
        }
      }

      void loadObsidian()
      return result
    } catch (error) {
      return {
        ok: false,
        error: error?.message || 'ULTRON Core is unavailable.',
      }
    }
  }

  async function sendAgentMessage(
    message,
    options = {}
  ) {
    const clean =
      message.trim()

    const archiveToObsidian = Boolean(
      options?.archiveToObsidian
    )

    if (!clean || agentSendingRef.current) {
      return
    }

    agentSendingRef.current = true

    if (archiveToObsidian) {
      setObsidianArmed(false)
    }

    const archivePromise = archiveToObsidian
      ? archiveChatMessage(clean)
      : null

    const userMessage = {
      id: createChatMessageId(),
      role: "user",
      text: clean,
      speak: false,
      createdAt: createChatMessageTimestamp(),
    }

    const conversationHistory = agentMessagesRef.current
      .slice(-8)
      .filter(item => item?.text && ['user', 'assistant'].includes(item.role))
      .map(item => ({
        role: item.role,
        text: String(item.text).slice(0, 1600),
      }))

    setAgentMessages(
      previous => {
        const next = [...previous, userMessage]
        agentMessagesRef.current = next
        return next
      }
    )

    setAgentInput("")
    setAgentSending(true)

    try {
      const response =
        await fetch(
          `${BACKEND}/api/agent`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              message: clean,
              history: conversationHistory,
            }),
          }
        )

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        )
      }

      const data =
        await response.json()

      const obsidianArchive = archivePromise
        ? await archivePromise
        : null

      const reply =
        data.reply ||
        "Command received."

      setAgentMessages(
        previous => {
          const next = [
            ...previous,
            {
              id: createChatMessageId(),
              role: "assistant",
              text: reply,
              speak: true,
              createdAt: Date.now(),
              memoryProposal: data.memory_proposal
                ? { ...data.memory_proposal, status: 'pending' }
                : null,
              emailDraft: data.email_draft
                ? { ...data.email_draft, status: 'pending' }
                : null,
              obsidianArchive,
            },
          ]
          agentMessagesRef.current = next
          return next
        }
      )

      if (preferences.voiceEnabled) {
        void speakWithFish(reply)
      }

    } catch {
      const obsidianArchive = archivePromise
        ? await archivePromise
        : null

      const reply =
        "I can't reach the ULTRON core right now."

      setAgentMessages(
        previous => {
          const next = [
            ...previous,
            {
              id: createChatMessageId(),
              role: "assistant",
              text: reply,
              speak: true,
              createdAt: Date.now(),
              obsidianArchive,
            },
          ]
          agentMessagesRef.current = next
          return next
        }
      )

      if (preferences.voiceEnabled) {
        void speakWithFish(reply)
      }
    } finally {
      agentSendingRef.current = false
      setAgentSending(false)
    }
  }

  function updateAgentAction(messageId, actionKey, changes) {
    setAgentMessages(previous => previous.map(message => (
      message.id === messageId
        ? {
            ...message,
            [actionKey]: {
              ...message[actionKey],
              ...changes,
            },
          }
        : message
    )))
  }

  async function commitMemoryProposal(messageId, proposal) {
    if (!proposal?.id || proposal.status === 'saving' || proposal.status === 'saved') return

    updateAgentAction(messageId, 'memoryProposal', {
      status: 'saving',
      error: '',
    })

    try {
      const response = await fetch(`${BACKEND}/api/memory/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal_id: proposal.id }),
      })
      const result = await response.json().catch(() => ({}))

      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Unable to save the memory.')
      }

      updateAgentAction(messageId, 'memoryProposal', {
        status: 'saved',
        error: '',
      })
      setAgentMessages(previous => [
        ...previous,
        {
          id: createChatMessageId(),
          role: 'assistant',
          text: `${result.saved || proposal.items?.length || 1} element${Number(result.saved || proposal.items?.length || 1) === 1 ? '' : 's'} committed to the Neural Core.`,
          speak: false,
          createdAt: Date.now(),
        },
      ])
    } catch (error) {
      updateAgentAction(messageId, 'memoryProposal', {
        status: 'pending',
        error: error?.message || 'Unable to save the memory.',
      })
    }
  }

  function discardMemoryProposal(messageId, proposal) {
    if (proposal?.status === 'saving' || proposal?.status === 'saved') return

    updateAgentAction(messageId, 'memoryProposal', {
      status: 'discarded',
      error: '',
    })
  }

  async function sendEmailDraft(messageId, draft) {
    if (!draft || draft.status === 'sending' || draft.status === 'sent') return

    updateAgentAction(messageId, 'emailDraft', {
      status: 'sending',
      error: '',
    })

    try {
      const response = await fetch(`${BACKEND}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: draft.to || [],
          subject: draft.subject || '',
          body: draft.body || '',
        }),
      })
      const result = await response.json().catch(() => ({}))

      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Mail could not send this transmission.')
      }

      updateAgentAction(messageId, 'emailDraft', {
        status: 'sent',
        error: '',
      })
      setAgentMessages(previous => [
        ...previous,
        {
          id: createChatMessageId(),
          role: 'assistant',
          text: result.message || 'Transmission sent through Mail.',
          speak: false,
          createdAt: Date.now(),
        },
      ])
    } catch (error) {
      updateAgentAction(messageId, 'emailDraft', {
        status: 'failed',
        error: error?.message || 'Mail could not send this transmission.',
      })
    }
  }

  async function loadWeather(
    latitude,
    longitude,
    label
  ) {
    try {
      const response =
        await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,weather_code&timezone=auto`
        )

      if (!response.ok)
        return

      const data =
        await response.json()

      setWeather({
        temperature:
          data.current
            .temperature_2m,

        code:
          data.current
            .weather_code,

        label,
      })
    } catch {
      // Weather unavailable.
    }
  }

  useEffect(() => {
    if (!hasStoredCoordinates(weatherConfig)) return

    void loadWeather(
      weatherConfig.lat,
      weatherConfig.lon,
      weatherConfig.label || 'LOCAL AREA'
    )
    // This app instance is mounted for one signed-in account; later edits load via saveWeather.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadObsidian() {
    try {
      const statusResponse =
        await fetch(
          `${BACKEND}/api/obsidian/status`
        )

      if (!statusResponse.ok)
        return

      const status =
        await statusResponse.json()

      setObsidianStatus(
        status
      )

      if (status.path) {
        setObsidianPath(
          status.path
        )
      }

      if (status.connected) {
        const graphResponse =
          await fetch(
            `${BACKEND}/api/obsidian/graph`
          )

        if (!graphResponse.ok)
          return

        const graph =
          await graphResponse.json()

        setObsidianGraph(
          graph
        )
      }
    } catch {
      // Backend offline.
    }
  }

  useEffect(() => {
    loadObsidian()
  }, [])

  async function saveObsidian() {
    try {
      const response =
        await fetch(
          `${BACKEND}/api/obsidian/config`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body: JSON.stringify({
              path:
                obsidianPath,
            }),
          }
        )

      const result =
        await response.json()

      if (!response.ok || !result.ok) {
        return {
          ok: false,
          error: result.error || result.detail || 'Obsidian could not connect to this vault.',
        }
      }

      await loadObsidian()

      return {
        ok: true,
        message: result.message || 'Obsidian vault connected for this local account.',
      }
    } catch {
      return {
        ok: false,
        error: 'The ULTRON Core is unavailable. Restart ULTRON and try again.',
      }
    }
  }

  function saveWeather(config = weatherConfig) {
    localStorage.setItem(
      weatherStorageKey,
      JSON.stringify(
        config
      )
    )

    if (hasStoredCoordinates(config)) {
      loadWeather(
        config.lat,
        config.lon,
        config.label ||
          'LOCAL AREA'
      )
    }
  }

  function applyGlobalPosition(location) {
    const next = {
      label: String(location?.shortLabel || location?.label || 'LOCAL AREA').slice(0, 120),
      lat: String(location?.lat ?? ''),
      lon: String(location?.lon ?? ''),
    }

    setWeatherConfig(next)
    saveWeather(next)
  }

  function handleVoiceWake() {
    const reply = 'Dimmi pure.'

    setAgentMessages(previous => {
      const last = previous[previous.length - 1]
      if (last?.role === 'assistant' && last.text === reply) return previous

      const next = [
        ...previous,
        {
          id: createChatMessageId(),
          role: 'assistant',
          text: reply,
          speak: false,
          createdAt: createChatMessageTimestamp(),
        },
      ]
      agentMessagesRef.current = next
      return next
    })

  }

  const voice = useUltronVoice({
    onCommand: sendAgentMessage,
    onWake: handleVoiceWake,
  })

  function dismissOnboarding() {
    markOnboardingComplete(accountScope)
    setOnboardingOpen(false)
  }

  const cpu =
    system?.cpu_percent

  const ram =
    system?.ram_percent

  const disk =
    system?.disk_percent

  const download =
    system?.download_mbps

  const upload =
    system?.upload_mbps

  return (
    <div
      className={`ultron page-${activePage.toLowerCase().replace(/_/g, '-')}`}
    >

      <div className="honeycomb-bg">
        <svg
          viewBox="0 0 900 700"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern
              id="hex"
              width="86"
              height="100"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M43 2L84 26V74L43 98L2 74V26L43 2Z"
                fill="none"
                stroke="#ff2525"
                strokeOpacity="0.13"
                strokeWidth="1"
              />
            </pattern>
          </defs>

          <rect
            width="100%"
            height="100%"
            fill="url(#hex)"
          />
        </svg>
      </div>

      <div className="ground-glow" />

      <header className="topbar">
        <div className="logo">
          <img
            className="brand-mark"
            src="./ultron-mark.png"
            alt=""
          />

          <div className="logo-copy">
            <span className="logo-word">
              ULTRON
            </span>

            <span className="logo-ai">
              PRIVATE INTELLIGENCE
            </span>
          </div>
        </div>

        <div className="top-status">
          <div className="top-online" role="status" aria-label="ULTRON online">
            <span className="status-dot" />
            <span>ONLINE</span>
          </div>

          <div className="top-status-meta">
            <span>
              {weather
                ? `${weatherIcon(
                    weather.code
                  )} ${weather.temperature}°C`
                : '☁ —'}
            </span>

            <span>
              {weather?.label ||
                'LOCAL AREA'}
            </span>

            <span>
              {date}
            </span>

            <strong>
              {time}
            </strong>
          </div>
        </div>

        <div className="top-account" aria-label="Current local account">
          <div>
            <span>OPERATOR</span>
            <strong title={accountName}>{accountName}</strong>
          </div>
          <button type="button" onClick={onLogout} title="Sign out of this local account">
            SIGN OUT
          </button>
        </div>
      </header>

      <aside className="menu">

        <div className="menu-label">COMMAND</div>

        {NAVIGATION_ITEMS.map(
          item => (
            <button
              key={item.id}
              className={
                activePage ===
                item.id
                  ? 'active'
                  : ''
              }
              onClick={() =>
                setActivePage(
                  item.id
                )
              }
            >
              <span className="menu-button-main">
                <NavIcon name={item.icon} />
                <span>{item.label}</span>
              </span>
              <span className="menu-indicator" />
            </button>
          )
        )}

      </aside>

      <main className="brain-area">

        <div
          className="core-hud"
          aria-hidden="true"
        >
          <i className="hud-corner hud-corner-nw" />
          <i className="hud-corner hud-corner-ne" />
          <i className="hud-corner hud-corner-sw" />
          <i className="hud-corner hud-corner-se" />
          <span className="hud-readout hud-readout-left">
            CORE LINK // 01
          </span>
          <span className="hud-readout hud-readout-right">
            NEURAL LOCK
          </span>
        </div>

        <div className="brain-title">
          <span>COGNITIVE DOMINION</span>
          NEURAL CORE
        </div>

        <Suspense
          fallback={(
            <div className="brain-renderer brain-renderer-fallback" role="status" aria-live="polite">
              <span>INITIALIZING NEURAL VISUALIZER</span>
            </div>
          )}
        >
          <NeuralCore onSelect={setSelected} />
        </Suspense>


        {selected && (
          <div
            key={selected.id}
            className="selection-card"
          >
            <div className="selection-card-head">
              <div className="selection-label">SELECTED NODE</div>
              <span>LOCKED</span>
            </div>

            <div className="selection-name">
              {selected.name}
            </div>

            <p className="selection-description">
              {selected.description}
            </p>

            <div className="selection-data">
              <div><span>RELATION</span><strong>{selected.relation}</strong></div>
              <div><span>TYPE</span><strong>{selected.type}</strong></div>
              <div><span>SOURCE</span><strong>{selected.source}</strong></div>
              <div><span>LINKS</span><strong>{selected.linkCount || 0}</strong></div>
            </div>

            {selected.path && <div className="selection-path">{selected.path}</div>}

            <button
              type="button"
              className="selection-open-memory"
              onClick={() => setActivePage('MEMORY')}
            >
              OPEN MEMORY ARCHIVE
            </button>
          </div>
        )}

        <div className="page-panel">

          {activePage ===
            'AGENT' && (
              <AgentChat
                messages={agentMessages}
                input={agentInput}
                setInput={setAgentInput}
                sending={agentSending}
                onSend={sendAgentMessage}
                onCommitMemory={commitMemoryProposal}
                onDiscardMemory={discardMemoryProposal}
                onSendEmail={sendEmailDraft}
                obsidianArmed={obsidianArmed}
                onToggleObsidian={() => setObsidianArmed(current => !current)}
                voice={voice}
              />
          )}

          {activePage ===
            'MEMORY' && (
            <MemoryPage
              obsidianStatus={obsidianStatus}
              obsidianGraph={obsidianGraph}
              onOpenSettings={() => setActivePage('SETTINGS')}
            />
          )}

          {activePage ===
            'SETTINGS' && (
            <SettingsPage
              obsidianPath={obsidianPath}
              setObsidianPath={setObsidianPath}
              saveObsidian={saveObsidian}
              obsidianStatus={obsidianStatus}
              weatherConfig={weatherConfig}
              saveWeather={saveWeather}
              onSaveGlobalPosition={applyGlobalPosition}
              preferences={preferences}
              setPreferences={setPreferences}
              backendOnline={backendOnline}
              printerStatus={printerStatus}
              onOpenTutorial={() => setOnboardingOpen(true)}
            />
          )}

          {activePage ===
            'DEVICES' && (
            <DevicesPage
              system={system}
              history={history}
              printerStatus={printerStatus}
              backendOnline={backendOnline}
              onRefresh={refreshDevices}
              onOpenMakerWorld={openMakerWorld}
              onOpenModelDeck={() => setActivePage('MODEL_DECK')}
              isRefreshing={isRefreshing}
            />
          )}

          {activePage ===
            'MODEL_DECK' && (
            <Suspense fallback={<div className="model-deck-loading">LOADING MODEL DECK…</div>}>
              <ModelDeckPage
                onBack={() => setActivePage('DEVICES')}
                backendOnline={backendOnline}
                printerStatus={printerStatus}
              />
            </Suspense>
          )}

        </div>

      </main>

      <aside className="system-panel">

        <div className="panel-title">
          <div>
            <span>LOCAL SYSTEM</span>
            <strong>{system?.hostname || 'LOCAL HOST'}</strong>
          </div>
          <span className="system-live">LIVE</span>
        </div>

        <SystemCard
          label="CPU"
          value={
            cpu === undefined
              ? '—'
              : `${cpu}%`
          }
          progress={cpu}
          values={
            history.cpu
          }
        />

        <SystemCard
          label="RAM"
          value={
            ram === undefined
              ? '—'
              : `${ram}%`
          }
          sub={
            system
              ? `${system.ram_used_gb} / ${system.ram_total_gb} GB`
              : ''
          }
          progress={ram}
          values={
            history.ram
          }
        />

        <SystemCard
          label="DISCO"
          value={
            system
              ? `${system.disk_free_gb} GB`
              : '—'
          }
          sub={
            system
              ? `${system.disk_total_gb} GB TOTAL`
              : ''
          }
          progress={
            disk !== undefined
              ? 100 - disk
              : undefined
          }
        />

        <SystemCard
          label="RETE"
          value="ONLINE"
          sub={`${download ?? '—'} ↓ / ${upload ?? '—'} ↑ Mbps`}
          values={[
            ...history.download,
            ...history.upload,
          ]}
        />

        <SystemCard
          label="3D PRINTER"
          value={
            printerStatus.connected
              ? 'ONLINE'
              : 'WAITING'
          }
          sub={
            printerStatus.connected
              ? `${printerStatus.status} · ${
                  printerStatus.port
                    ? printerStatus.port
                        .split('/')
                        .pop()
                    : printerStatus.baseUrl
                      ? 'WI-FI / LAN'
                      : 'LOCAL LINK'
                }`
              : printerStatus.profileId
                ? 'PROFILE SAVED · NOT CONNECTED'
                : 'CONFIGURE IN DEVICES'
          }
          progress={
            typeof printerStatus.progress === 'number'
              ? printerStatus.progress
              : undefined
          }
        />

      </aside>

      {onboardingOpen && (
        <OnboardingTutorial
          accountName={accountName}
          onDismiss={dismissOnboarding}
          onOpenSettings={() => setActivePage('SETTINGS')}
          onOpenDevices={() => setActivePage('DEVICES')}
        />
      )}

    </div>
  )
}

export default App
