import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AuthGate from './components/AuthGate.jsx'

class UltronErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="ultron-recovery-screen" role="alert">
          <img src="./ultron-mark.png" alt="ULTRON" />
          <span>LOCAL CORE INTERFACE</span>
          <h1>ULTRON NEEDS TO RELOAD</h1>
          <p>
            The local interface encountered an unexpected display error. Your
            local account data and vaults were not changed.
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            RELOAD ULTRON
          </button>
        </main>
      )
    }

    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <UltronErrorBoundary>
      <AuthGate>
        {({ user, onLogout }) => (
          <App user={user} onLogout={onLogout} />
        )}
      </AuthGate>
    </UltronErrorBoundary>
  </StrictMode>,
)
