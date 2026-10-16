import { useState } from 'react'
import { login, register } from '../api'

interface LoginScreenProps {
  onLoggedIn: (username: string) => void
}

// Samme minimum som backenden (auth.js) — her kun for at fange det før kaldet
const MIN_PASSWORD_LENGTH = 8

// Login og oprettelse i én formular: skifter man tilstand, bevares det man har skrevet
export default function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isRegister = mode === 'register'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const name = isRegister
        ? await register(username, password, invite.trim())
        : await login(username, password)
      onLoggedIn(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt')
      setBusy(false)
    }
  }

  const switchMode = () => {
    setMode(isRegister ? 'login' : 'register')
    setError(null)
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h2>{isRegister ? 'Opret bruger' : 'Log ind'}</h2>
        {error && <p className="sidebar-error">{error}</p>}

        <label className="login-field">
          <span>Brugernavn</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
          />
        </label>

        <label className="login-field">
          <span>Adgangskode</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            // Fortæller password-managere om de skal udfylde eller foreslå en ny
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            minLength={isRegister ? MIN_PASSWORD_LENGTH : undefined}
            required
          />
        </label>

        {isRegister && (
          <label className="login-field">
            <span>Invitationskode</span>
            <input
              type="text"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <small>Fås af den der har inviteret dig</small>
          </label>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Vent...' : isRegister ? 'Opret bruger' : 'Log ind'}
        </button>

        <button className="login-switch" type="button" onClick={switchMode} disabled={busy}>
          {isRegister ? 'Har du allerede en bruger? Log ind' : 'Ny bruger? Opret dig med en invitationskode'}
        </button>
      </form>
    </div>
  )
}
