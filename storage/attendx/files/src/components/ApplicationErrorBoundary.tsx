import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useAppStore } from '../store'
import { Button, Logo } from './ui'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Keeps a client-side render problem from presenting a completely blank app. */
export class ApplicationErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AttendX] Workspace render failed', error, info.componentStack)
  }

  private recover = async () => {
    await useAppStore.getState().signOut()
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <main className="app-failure" role="alert">
        <Logo />
        <span className="app-failure-icon"><AlertTriangle size={28} /></span>
        <h1>We couldn’t open your workspace</h1>
        <p>Your sign-in is safe. Return to the login screen and try again.</p>
        <Button onClick={this.recover}><RefreshCw size={17} />Return to sign in</Button>
      </main>
    )
  }
}
