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
      <section className="auth-card" aria-label="ULTRON local account access">
        <header className="auth-brand">
          <img src="./ultron-mark.png" alt="ULTRON" />
          <div>
            <span>ULTRON</span>
            <strong>LOCAL INTELLIGENCE</strong>
          </div>
          <i aria-hidden="true" />
        </header>

        <div className="auth-copy">
          <span className="auth-kicker">PRIVATE ACCESS CHANNEL</span>
          <h1>{isLogin ? 'Unlock your local core' : mode === 'register' ? 'Create a local operator' : mode === 'verify' ? 'Verify email access' : mode === 'request-reset' ? 'Recover your access' : 'Set a new passphrase'}</h1>
          <p>
            Account records and ULTRON memory stay on this computer. A mail server is used only when email verification or recovery is enabled.
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
              Create a local account
            </button>
          )}
          {isLogin && (
            <button type="button" onClick={() => setMode('request-reset')} disabled={submitting}>
              Forgot passphrase?
            </button>
          )}
          {mode === 'register' && (
            <button type="button" onClick={() => setMode('login')} disabled={submitting}>
              Back to sign in
            </button>
          )}
          {mode === 'verify' && (
            <button type="button" onClick={() => setMode('login')} disabled={submitting}>
              Use another account
            </button>
          )}
          {(mode === 'request-reset' || mode === 'reset') && (
            <button type="button" onClick={() => setMode('login')} disabled={submitting}>
              Back to sign in
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
      setFeedback('Your local session expired. Sign in again to continue.')
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
        setFeedback('The local authentication service is unavailable. Start the ULTRON Core and retry.')
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
      throw new Error('The local core returned an incomplete session. Please try again.')
    }

    await setSessionToken(result.token)
    const nextUser = result.user
    const requiresVerification = result.verification_required === true || (verificationRequired && !isVerified(nextUser))

    if (requiresVerification && !isVerified(nextUser)) {
      setPendingEmail(nextUser.email || fallbackEmail)
      setMode('verify')
      setFeedbackTone('success')
      setFeedback(result.verification_email_sent === false
        ? 'Verification is required. Use the token sent by your mail service, or request a new one below.'
        : 'A verification token was sent to your email address. Paste it below to unlock ULTRON.')
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
      setFeedback('The two passphrases do not match.')
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
        if (!result?.user) throw new Error('The verification response did not contain an account.')
        setPendingEmail('')
        setForm(EMPTY_FORM)

        if (getSessionToken()) {
          setUser(result.user)
          setFeedback('')
        } else {
          setMode('login')
          setFeedbackTone('success')
          setFeedback('Email verified. Sign in to unlock your local core.')
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
        setFeedback('Passphrase updated. You can sign in now.')
      }
    } catch (error) {
      setFeedbackTone('error')
      setFeedback(error?.message || 'The request could not be completed.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResendVerification() {
    const email = visibleEmail.trim()
    if (!email) {
      setFeedbackTone('error')
      setFeedback('Enter the email address that should receive the verification token.')
      return
    }

    setSubmitting(true)
    try {
      const result = await resendVerification(email)
      setFeedbackTone('success')
      setFeedback(result.message || 'If verification is available for this account, a new token has been sent.')
    } catch (error) {
      setFeedbackTone('error')
      setFeedback(error?.message || 'Unable to resend the verification token.')
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
        <strong>CONNECTING TO LOCAL CORE</strong>
        <span>Checking the private access channel…</span>
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
            label="Operator name"
            value={form.displayName}
            onChange={value => updateField('displayName', value)}
            autoComplete="name"
            hint="Shown only inside this local ULTRON installation."
            required={false}
          />
        )}

        {(mode === 'login' || mode === 'register' || mode === 'request-reset') && (
          <AuthField
            id="auth-email"
            label="Email address"
            type="email"
            value={form.email}
            onChange={value => updateField('email', value)}
            autoComplete="email"
          />
        )}

        {(mode === 'login' || mode === 'register' || mode === 'reset') && (
          <AuthField
            id="auth-password"
            label={mode === 'reset' ? 'New passphrase' : 'Passphrase'}
            type="password"
            value={form.password}
            onChange={value => updateField('password', value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            hint={mode === 'register' ? `Use at least ${passwordMinimum} characters.` : undefined}
          />
        )}

        {(mode === 'register' || mode === 'reset') && (
          <AuthField
            id="auth-confirm-password"
            label="Confirm passphrase"
            type="password"
            value={form.confirmPassword}
            onChange={value => updateField('confirmPassword', value)}
            autoComplete="new-password"
          />
        )}

        {(mode === 'verify' || mode === 'reset') && (
          <AuthField
            id="auth-token"
            label={mode === 'verify' ? 'Verification code' : 'Recovery code'}
            value={form.token}
            onChange={value => updateField('token', value)}
            autoComplete="one-time-code"
            hint={mode === 'verify'
              ? `Paste the one-time code sent to ${visibleEmail || 'your email address'}.`
              : `Paste the one-time code sent to ${visibleEmail || 'your email address'}.`}
          />
        )}

        <button className="auth-primary" type="submit" disabled={submitting || (mode === 'register' && registrationEnabled === false)}>
          {submitting
            ? 'PROCESSING…'
            : mode === 'login'
              ? 'UNLOCK ULTRON'
              : mode === 'register'
                ? 'CREATE LOCAL ACCOUNT'
                : mode === 'verify'
                  ? 'VERIFY EMAIL'
                  : mode === 'request-reset'
                    ? 'SEND RECOVERY TOKEN'
                    : 'UPDATE PASSPHRASE'}
        </button>

        {mode === 'verify' && (
          <button className="auth-secondary" type="button" onClick={handleResendVerification} disabled={submitting}>
            RESEND VERIFICATION TOKEN
          </button>
        )}

        {mode === 'register' && registrationEnabled === false && (
          <p className="auth-inline-note">New registrations are disabled in this ULTRON installation.</p>
        )}
      </form>
    </AuthShell>
  )
}
