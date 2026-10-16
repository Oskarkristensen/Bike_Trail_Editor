import { useCallback, useEffect, useState } from 'react'
import Map from './components/Map'
import LoginScreen from './components/LoginScreen'
import { fetchCurrentUser, logout, setUnauthorizedHandler } from './api'
import './App.css'

// undefined = spørger stadig serveren; null = ikke logget ind
type User = string | null | undefined

function App() {
  const [user, setUser] = useState<User>(undefined)
  const [startupError, setStartupError] = useState<string | null>(null)

  const checkSession = useCallback(() => {
    setStartupError(null)
    fetchCurrentUser()
      .then(setUser)
      .catch((err) => setStartupError(err instanceof Error ? err.message : 'Kunne ikke nå serveren'))
  }, [])

  useEffect(() => {
    checkSession()
    // Et 401 fra et hvilket som helst kald betyder at sessionen er væk —
    // tilbage til login-skærmen frem for en vilkårlig fejl i sidepanelet
    setUnauthorizedHandler(() => setUser(null))
    return () => setUnauthorizedHandler(null)
  }, [checkSession])

  const handleLogout = async () => {
    try {
      await logout()
    } finally {
      // Også hvis kaldet fejler: brugeren har bedt om at blive logget ud
      setUser(null)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Bike Trail Editor</h1>
        {user && (
          <div className="app-header-user">
            <span>{user}</span>
            <button className="btn btn-header" onClick={() => void handleLogout()}>
              Log ud
            </button>
          </div>
        )}
      </header>

      {user === undefined ? (
        <div className="login-screen">
          {startupError ? (
            <div className="login-card">
              <p className="sidebar-error">{startupError}</p>
              <button className="btn btn-primary" onClick={checkSession}>Prøv igen</button>
            </div>
          ) : (
            // Render's gratis tier og Neon sover efter en pause; første svar kan tage
            // 20-30 sekunder. Uden denne tekst ligner det at appen er gået i stå.
            <p className="sidebar-hint">Starter serveren… det kan tage lidt tid efter en pause</p>
          )}
        </div>
      ) : user === null ? (
        <LoginScreen onLoggedIn={setUser} />
      ) : (
        <Map />
      )}
    </div>
  )
}

export default App
