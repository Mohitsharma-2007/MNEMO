import { useEffect, useRef, useState } from 'react'
import { Camera as CameraIcon, X } from 'lucide-react'
import { Camera, CameraDirection, CameraResultType, CameraSource } from '@capacitor/camera'
import { Capacitor } from '@capacitor/core'
import { Button } from './ui'

export type LivePhoto = { dataUrl: string; capturedAt: string }

export async function captureNativePhoto(facing: 'user' | 'environment'): Promise<LivePhoto | null> {
  if (!Capacitor.isNativePlatform()) return null
  const photo = await Camera.getPhoto({
    source: CameraSource.Camera,
    resultType: CameraResultType.DataUrl,
    direction: facing === 'user' ? CameraDirection.Front : CameraDirection.Rear,
    quality: 86,
    allowEditing: false,
    saveToGallery: false,
  })
  if (!photo.dataUrl) throw new Error('No camera image was captured')
  return { dataUrl: photo.dataUrl, capturedAt: new Date().toISOString() }
}

export function CameraCaptureModal({ facing, title, onCapture, onClose }: { facing: 'user'|'environment'; title: string; onCapture: (photo: LivePhoto) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing } }, audio: false })
      .catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }))
      .then((value) => { 
        stream.current = value
        if (mounted && video.current) { 
          video.current.srcObject = value
          video.current.play().catch(() => undefined)
        } 
      })
      .catch(() => { if (mounted) setError('Camera permission is required. Gallery uploads are not accepted.') })
    return () => {
      mounted = false
      stream.current?.getTracks().forEach((track) => track.stop())
    }
  }, [facing])
  
  const stopStream = () => stream.current?.getTracks().forEach((track) => track.stop())
  
  const shoot = () => {
    if (!video.current?.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.current.videoWidth; canvas.height = video.current.videoHeight
    canvas.getContext('2d')!.drawImage(video.current, 0, 0)
    stopStream()
    onCapture({ dataUrl: canvas.toDataURL('image/jpeg', .86), capturedAt: new Date().toISOString() })
  }
  
  const handleClose = () => {
    stopStream()
    onClose()
  }
  
  return <div className="camera-modal"><div className="camera-surface"><button type="button" className="icon-button camera-close" onClick={handleClose} aria-label="Close camera"><X/></button><strong className="camera-title">{title}</strong>{error ? <div className="inline-error">{error}</div> : <video ref={video} playsInline muted/>}<Button type="button" onClick={shoot} disabled={Boolean(error)}><CameraIcon size={18}/>Capture now</Button></div></div>
}

