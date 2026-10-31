import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'in.attendx.app',
  appName: 'AttendX',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  plugins: {
    Camera: { presentationStyle: 'fullscreen' },
    Geolocation: { permissions: ['location'] }
  }
}

export default config
