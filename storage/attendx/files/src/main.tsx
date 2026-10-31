import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './featureStyles.css'
import { App } from './App'
import { ApplicationErrorBoundary } from './components/ApplicationErrorBoundary'
import { installConsoleProtection } from './lib/consoleGuard'

installConsoleProtection()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApplicationErrorBoundary><App /></ApplicationErrorBoundary>
  </StrictMode>,
)
