import { useEffect, useId, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { AlertTriangle, X } from 'lucide-react'
import { Camera } from '@capacitor/camera'
import { Capacitor } from '@capacitor/core'

export function QrScannerModal({ title, onResult, onClose }: { title: string; onResult: (value: string) => void; onClose: () => void }) {
  const reactId = useId().replaceAll(':', '')
  const elementId = `attendx-qr-${reactId}`
  const [error, setError] = useState('')
  
  useEffect(() => {
    const scanner = new Html5Qrcode(elementId)
    let isUnmounted = false
    let startPromise: Promise<any> | null = null

    const init = async () => {
      if (Capacitor.isNativePlatform()) {
        let perm = await Camera.checkPermissions()
        if (perm.camera !== 'granted') {
          perm = await Camera.requestPermissions()
        }
        if (perm.camera !== 'granted') throw new Error('Camera permission denied')
      }
      
      const cameras = await Html5Qrcode.getCameras()
      if (isUnmounted) return
      if (!cameras.length) throw new Error('No camera was found')
      
      startPromise = scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (value) => {
          void scanner.stop().catch(() => undefined).finally(() => scanner.clear())
          onResult(value)
        },
        () => undefined
      )
      
      await startPromise
      if (isUnmounted) {
        void scanner.stop().catch(() => undefined).finally(() => scanner.clear())
      }
    }

    init().catch((reason) => {
      if (!isUnmounted) setError(reason instanceof Error ? reason.message : 'Could not start QR scanner')
    })

    return () => {
      isUnmounted = true
      if (startPromise) {
        startPromise.then(() => {
          void scanner.stop().catch(() => undefined).finally(() => scanner.clear())
        }).catch(() => undefined)
      }
    }
  }, [elementId, onResult])
  return <div className="camera-modal"><div className="qr-scanner-modal"><button className="icon-button camera-close" onClick={onClose} aria-label="Close scanner"><X/></button><h2>{title}</h2>{error && <div className="inline-error"><AlertTriangle size={16}/>{error}</div>}<div id={elementId} className="qr-reader"/></div></div>
}

/**
 * Extract join token from various formats:
 * - Raw token string like "JOIN-A1B2C3D4"
 * - URL with ?token=... parameter
 * - Full URL with token embedded in path
 */
export function extractJoinToken(value: string): string {
  const trimmed = value.trim()
  
  // Check for URL-style token parameter
  const urlMatch = trimmed.match(/[?&]token=([a-zA-Z0-9_-]+)/i)
  if (urlMatch) return urlMatch[1]
  
  // Check for JOIN-<hex> format (case insensitive, 8 chars)
  const joinMatch = trimmed.match(/\b(JOIN-[A-F0-9]{8})\b/i)
  if (joinMatch) return joinMatch[1]
  
  // If it looks like a URL, try to extract the last path segment
  if (trimmed.startsWith('http')) {
    try {
      const url = new URL(trimmed)
      const pathParts = url.pathname.split('/').filter(Boolean)
      const last = pathParts[pathParts.length - 1]
      if (last) return last
    } catch {}
  }
  
  // Return as-is (it might be a raw token)
  return trimmed
}

/**
 * Detect QR code type from scanned value:
 * - 'attendance' for ATXQR tokens (3-part base64url JWT-like format)
 * - 'join' for JOIN-<hex> class invitation tokens
 * - 'unknown' for anything else
 */
export function detectQrType(value: string): 'attendance' | 'join' | 'unknown' {
  const trimmed = value.trim()
  
  // Check for ATXQR attendance token (3-part dot-separated)
  const parts = trimmed.split('.')
  if (parts.length === 3) {
    try {
      const headerRaw = parts[0].replace(/-/g, '+').replace(/_/g, '/')
      const header = JSON.parse(atob(headerRaw))
      if (header.typ === 'ATXQR') return 'attendance'
    } catch {}
  }
  
  // Check for JOIN token pattern
  if (/JOIN-[A-F0-9]+/i.test(trimmed)) return 'join'
  if (/[?&]token=/i.test(trimmed)) return 'join'
  
  return 'unknown'
}
