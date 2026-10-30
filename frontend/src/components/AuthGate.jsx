import { useEffect, useMemo, useState } from 'react'
import {
  clearLegacySharedUiState,
  clearSessionToken,
  getAuthConfig,
  getCurrentAccount,
  getSessionToken,
  installAuthenticatedFetch,
  loginAccount,
  logoutAccount,
  registerAccount,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  setSessionToken,
  verifyEmail,
} from '../auth.js'
import './AuthGate.css'

const EMPTY_FORM = {
  displayName: '',
  email: '',
  password: '',
  confirmPassword: '',
  token: '',
}

function isVerified(user) {
  return user?.email_verified === true || user?.emailVerified === true
}

function AuthField({ id, label, type = 'text', value, onChange, autoComplete, hint, required = true }) {
  return (
    <label className="auth-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={event => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
      />
      {hint && <small>{hint}</small>}
    </label>
  )
}

function AuthShell({ children, mode, setMode, feedback, feedbackTone, submitting, registrationEnabled }) {
  const isLogin = mode === 'login'

  return (
    <main className="auth-gate">
      <div className="auth-gate-grid" aria-hidden="true" />
      <section className="auth-card" aria-label="Accesso all’account locale Ultron AI">
        <header className="auth-brand">
          <img src="./ultron-mark.png" alt="Ultron AI" />
          <div>
            <span>Ultron AI</span>
            <strong>INTELLIGENZA LOCALE</strong>
          </div>
          <i aria-hidden="true" />
        </header>

        <div className="auth-copy">
          <span className="auth-kicker">ACCESSO PRIVATO</span>
          <h1>{isLogin ? 'Apri il tuo spazio locale' : mode === 'register' ? 'Crea il tuo spazio locale' : mode === 'verify' ? 'Verifica la tua email' : mode === 'request-reset' ? 'Recupera l’accesso' : 'Scegli una nuova password'}</h1>
          <p>
            Account e memoria restano su questo computer. L’email serve solo se scegli di attivare verifica o recupero accesso.
          </p>
        </div>

        {children}

        {feedback && (
          <p className={`auth-feedback ${feedbackTone === 'error' ? 'error' : 'success'}`} role="status">
            {feedback}
          </p>
        )}

        <footer className="auth-footer">
          {isLogin && registrationEnabled !== false && (
            <button type="button" onClick={() => setMode('register')} disabled={submitting}>
              Crea un account locale
            </button>
          )}
          {isLogin && (
            <button type="button" onClick={() => setMode('request-reset')} disabled={submitting}>
              Hai dimenticato la password?
            </button>
          )}
          {mode === 'register' && (
            <button type="button" onClick={() => setMode('login')} disabled={submitting}>
              Torna all’accesso
            </button>
          )}
          {mode === 'verify' && (
            <button type="button" onClick={() => setMode('login')} disabled={submitting}>
              Usa un altro account
            </button>
          )}
          {(mode === 'request-reset' || mode === 'reset') && (
            <button type="button" onClick={() => setMode('login')} disabled={submitting}>
              Torna all’accesso
            </button>
          )}
        </footer>
      </section>
    </main>
  )
}

export default function AuthGate({ children }) {
  const [booting, setBooting] = useState(true)
  const [user, setUser] = useState(null)
  const [authConfig, setAuthConfig] = useState(null)
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState(EMPTY_FORM)
  const [pendingEmail, setPendingEmail] = useState('')
  const [feedback, setFeedback] = useState('')
  const [feedbackTone, setFeedbackTone] = useState('success')
  const [submitting, setSubmitting] = useState(false)

  const registrationEnabled = authConfig?.registration_enabled
  const verificationRequired = Boolean(authConfig?.email_verification_required)
  const passwordMinimum = authConfig?.password_min_length || 12

  const updateField = (field, value) => {
    setForm(current => ({ ...current, [field]: value }))
    setFeedback('')
  }

  const leaveAccount = () => {
    clearSessionToken()
    setUser(null)
    setPendingEmail('')
    setForm(EMPTY_FORM)
    setMode('login')
  }

  useEffect(() => {
    clearLegacySharedUiState()
    const uninstallFetch = installAuthenticatedFetch(() => {
      leaveAccount()
      setFeedbackTone('error')
      setFeedback('La sessione locale è scaduta. Accedi di nuovo per continuare.')
    })
    let disposed = false

    async function initialize() {
      const savedSession = getSessionToken()
      // Restored session storage needs the Electron-main bridge too, otherwise
      // authenticated native file dialogs would lose the signed-in account.
      if (savedSession) {
        await setSessionToken(savedSession)
      }

      const [configResult, accountResult] = await Promise.allSettled([
        getAuthConfig(),
        savedSession ? getCurrentAccount() : Promise.resolve(null),
      ])

      if (disposed) return

      const loadedConfig = configResult.status === 'fulfilled'
        ? configResult.value
        : null

      if (loadedConfig) {
        setAuthConfig(loadedConfig)
      } else {
        setFeedbackTone('error')
        setFeedback('Il servizio locale non è disponibile. Riavvia Ultron AI e riprova.')
      }

      if (accountResult.status === 'fulfilled' && accountResult.value?.user) {
        const savedUser = accountResult.value.user

        if (loadedConfig?.email_verification_required && !isVerified(savedUser)) {
          setPendingEmail(savedUser.email || '')
          setMode('verify')
        } else {
          setUser(savedUser)
        }
      } else if (getSessionToken()) {
        clearSessionToken()
      }

      setBooting(false)
    }

    void initialize()
    return () => {
      disposed = true
      uninstallFetch()
    }
  }, [])

  const visibleEmail = useMemo(() => pendingEmail || form.email, [pendingEmail, form.email])

  async function beginSession(result, fallbackEmail = '') {
    if (!result?.token || !result?.user) {
      throw new Error('Ultron AI non ha completato l’accesso. Riprova.')
    }

    await setSessionToken(result.token)
    const nextUser = result.user
    const requiresVerification = result.verification_required === true || (verificationRequired && !isVerified(nextUser))

    if (requiresVerification && !isVerified(nextUser)) {
      setPendingEmail(nextUser.email || fallbackEmail)
      setMode('verify')
      setFeedbackTone('success')
      setFeedback(result.verification_email_sent === false
        ? 'Serve la verifica: usa il codice del tuo servizio email oppure richiedine uno nuovo qui sotto.'
        : 'Ti abbiamo inviato un codice via email. Incollalo qui sotto per aprire Ultron AI.')
      return
    }

    setUser(nextUser)
    setForm(EMPTY_FORM)
    setFeedback('')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setFeedback('')

    if (mode === 'register' && form.password !== form.confirmPassword) {
      setFeedbackTone('error')
      setFeedback('Le due password non coincidono.')
      return
    }

    setSubmitting(true)
    try {
      if (mode === 'login') {
        const result = await loginAccount({ email: form.email.trim(), password: form.password })
        await beginSession(result, form.email.trim())
      }

      if (mode === 'register') {
        const result = await registerAccount({
          email: form.email.trim(),
          password: form.password,
          displayName: form.displayName.trim(),
        })
        await beginSession(result, form.email.trim())
      }

      if (mode === 'verify') {
        const result = await verifyEmail(form.token.trim())
        if (!result?.user) throw new Error('La verifica non ha restituito un account valido.')
        setPendingEmail('')
        setForm(EMPTY_FORM)

        if (getSessionToken()) {
          setUser(result.user)
          setFeedback('')
        } else {
          setMode('login')
          setFeedbackTone('success')
          setFeedback('Email verificata. Accedi per aprire il tuo spazio locale.')
        }
      }

      if (mode === 'request-reset') {
        const result = await requestPasswordReset(form.email.trim())
        setPendingEmail(form.email.trim())
        setMode('reset')
        setFeedbackTone('success')
        setFeedback(result.message || 'If the account exists, a recovery token is on its way to your email.')
      }

      if (mode === 'reset') {
        if (form.password !== form.confirmPassword) {
          throw new Error('The two passphrases do not match.')
        }
        await resetPassword({ token: form.token.trim(), password: form.password })
        setForm(EMPTY_FORM)
        setMode('login')
        setFeedbackTone('success')
        setFeedback('Password aggiornata. Ora puoi accedere.')
      }
    } catch (error) {
      setFeedbackTone('error')
      setFeedback(error?.message || 'Non è stato possibile completare la richiesta.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResendVerification() {
    const email = visibleEmail.trim()
    if (!email) {
      setFeedbackTone('error')
      setFeedback('Inserisci l’indirizzo email che deve ricevere il codice.')
      return
    }

    setSubmitting(true)
    try {
      const result = await resendVerification(email)
      setFeedbackTone('success')
      setFeedback(result.message || 'Se la verifica è attiva per questo account, ti abbiamo inviato un nuovo codice.')
    } catch (error) {
      setFeedbackTone('error')
      setFeedback(error?.message || 'Non è stato possibile inviare un nuovo codice.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleLogout() {
    try {
      await logoutAccount()
    } catch {
      // The local session is always removed, even if the Core is already closed.
    } finally {
      leaveAccount()
    }
  }

  if (booting) {
    return (
      <main className="auth-gate auth-gate-loading" aria-live="polite">
        <div className="auth-loading-mark"><img src="./ultron-mark.png" alt="" /></div>
        <strong>CONNESSIONE A Ultron AI</strong>
        <span>Connessione allo spazio locale…</span>
      </main>
    )
  }

  if (user) {
    return children({ user, onLogout: handleLogout })
  }

  return (
    <AuthShell
      mode={mode}
      setMode={nextMode => {
        setMode(nextMode)
        setFeedback('')
      }}
      feedback={feedback}
      feedbackTone={feedbackTone}
      submitting={submitting}
      registrationEnabled={registrationEnabled}
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {mode === 'register' && (
          <AuthField
            id="auth-display-name"
            label="Nome"
            value={form.displayName}
            onChange={value => updateField('displayName', value)}
            autoComplete="name"
            hint="Visibile solo dentro questa installazione di Ultron AI."
            required={false}
          />
        )}

        {(mode === 'login' || mode === 'register' || mode === 'request-reset') && (
          <AuthField
            id="auth-email"
            label="Indirizzo email"
            type="email"
            value={form.email}
            onChange={value => updateField('email', value)}
            autoComplete="email"
          />
        )}

        {(mode === 'login' || mode === 'register' || mode === 'reset') && (
          <AuthField
            id="auth-password"
            label={mode === 'reset' ? 'Nuova password' : 'Password'}
            type="password"
            value={form.password}
            onChange={value => updateField('password', value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            hint={mode === 'register' ? `Usa almeno ${passwordMinimum} caratteri.` : undefined}
          />
        )}

        {(mode === 'register' || mode === 'reset') && (
          <AuthField
            id="auth-confirm-password"
            label="Conferma password"
            type="password"
            value={form.confirmPassword}
            onChange={value => updateField('confirmPassword', value)}
            autoComplete="new-password"
          />
        )}

        {(mode === 'verify' || mode === 'reset') && (
          <AuthField
            id="auth-token"
            label={mode === 'verify' ? 'Codice di verifica' : 'Codice di recupero'}
            value={form.token}
            onChange={value => updateField('token', value)}
            autoComplete="one-time-code"
            hint={mode === 'verify'
              ? `Incolla il codice inviato a ${visibleEmail || 'questa email'}.`
              : `Incolla il codice inviato a ${visibleEmail || 'questa email'}.`}
          />
        )}

        <button className="auth-primary" type="submit" disabled={submitting || (mode === 'register' && registrationEnabled === false)}>
          {submitting
            ? 'ATTENDI…'
            : mode === 'login'
              ? 'Apri Ultron AI'
              : mode === 'register'
                ? 'CREA ACCOUNT LOCALE'
                : mode === 'verify'
                  ? 'VERIFICA EMAIL'
                  : mode === 'request-reset'
                    ? 'INVIA CODICE DI RECUPERO'
                    : 'AGGIORNA PASSWORD'}
        </button>

        {mode === 'verify' && (
          <button className="auth-secondary" type="button" onClick={handleResendVerification} disabled={submitting}>
            INVIA UN NUOVO CODICE
          </button>
        )}

        {mode === 'register' && registrationEnabled === false && (
          <p className="auth-inline-note">La creazione di nuovi account non è attiva in questa installazione.</p>
        )}
      </form>
    </AuthShell>
  )
}
