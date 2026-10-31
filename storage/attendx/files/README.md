<div align="center">

# AttendX
### Institutional Attendance Infrastructure · Verified Presence with Physical Evidence

[![Vercel Deployment](https://img.shields.io/badge/Vercel-Live%20Demo-10b981?style=for-the-badge&logo=vercel&logoColor=white)](https://attendx-lilac-zeta.vercel.app)
[![Android Release](https://img.shields.io/badge/Android%20APK-v1.0.0%20Download-059669?style=for-the-badge&logo=android&logoColor=white)](https://github.com/Mohitsharma-2007/AttendX/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Capacitor](https://img.shields.io/badge/Capacitor-7.4-119EFF?style=for-the-badge&logo=capacitor&logoColor=white)](https://capacitorjs.com/)
[![React](https://img.shields.io/badge/React-19.1-61dafb?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)

<br/>

<img src="./logo.png" alt="AttendX Logo" width="480" style="max-width: 100%; border-radius: 12px;"/>

<br/>

**Attendance with evidence, not assumptions.**  
Short-lived cryptographically signed QR codes, precise GPS geofencing, and live camera presence verification in one unified classroom workflow.

[🌐 Live Web Application](https://attendx-lilac-zeta.vercel.app) · [📱 Download Android APK](https://github.com/Mohitsharma-2007/AttendX/releases) · [📖 Release Notes](./releases/RELEASE_NOTES.md)

</div>

---

## ⚡ Key Capabilities

- **🔄 Rotating Cryptographic QR Codes**:
  - Live session tokens signed with HMAC-SHA256.
  - Automatically rotates every 15–600 seconds as configured by faculty.
  - Strict batch validation prevents scanning arbitrary external codes.

- **📍 High-Precision Geofencing**:
  - Server-side Haversine distance verification against classroom coordinates.
  - Instant location acquisition with smooth fallback and accuracy filtering.

- **📸 Native Camera & Facial Verification**:
  - Hardware camera evidence capture with EXIF verification.
  - Local zero-API-key AI facial heuristic verification and ambient classroom analysis.

- **📱 Native Android Mobile Application**:
  - Built with Capacitor 7 and Google MLKit for instant barcode scanning.
  - Hardware device integrity checks and full offline resilience.
  - Custom dark branding with adaptive launcher icons for all screen densities.

- **🌐 Dual-Mode Backend & Cloud Sync**:
  - **Offline-First Zero Setup**: Built-in embedded SQLite database works immediately out-of-the-box on your laptop without configuring external databases.
  - **MongoDB Atlas Integration**: Native schema synchronization and direct connectivity to MongoDB Atlas.
  - **SMTP OTP Verification Engine**: Automated institutional email OTP delivery via Gmail SMTP.

---

## 📱 Android App Installation

You can download and install the latest compiled Android APK directly:

1. Head to [**GitHub Releases**](https://github.com/Mohitsharma-2007/AttendX/releases/tag/v1.0.0).
2. Download **`AttendX.apk`**.
3. Install on any device running Android 7.0+ (API 24 to 34+).

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js 20+** (tested on Node 24)
- **Java 21** & **Android Studio** (for Android APK builds)

### 2. Clone & Install
```bash
git clone https://github.com/Mohitsharma-2007/AttendX.git
cd AttendX
npm install
```

### 3. Run the Web Application
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 4. Run the Local Backend Server
```bash
# In a separate terminal
npm run server
```
The server will start on [http://localhost:3001](http://localhost:3001) with automatic database and seed initialization.

### 5. Build & Sync Android App
```bash
# Build the web bundle and sync native Android project
npm run cap:sync

# Assemble Android debug APK
cd android
./gradlew assembleDebug
```
The compiled APK will be in `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## 🏗️ Project Architecture

```
ATTENDX/
├── android/               # Native Android Capacitor Project (Java/Gradle)
│   ├── app/src/main/res/  # High-density launcher icons (logom.png) & NoActionBar theme
│   └── app/build/outputs/ # Compiled APK output
├── api/                   # Vercel Serverless Function entrypoints
├── public/                # Static assets and brand logo
│   ├── logo.png           # Full AttendX brand banner logo
│   └── logom.png          # High-resolution square app mark
├── releases/              # Official repository release artifacts & notes
│   ├── AttendX.apk        # Compiled Android APK (v1.0.0)
│   └── RELEASE_NOTES.md   # Release notes and changelog
├── server/                # Standalone Node.js / Express Backend
│   ├── src/auth.ts        # Session & account management
│   ├── src/db.ts          # Dual-engine SQLite / MongoDB Atlas database
│   ├── src/functions.ts   # Core business logic (QR, Attendance, Sessions)
│   ├── src/localAi.ts     # Local zero-API-key facial & classroom vision engine
│   └── src/otp.ts         # Gmail SMTP OTP engine
├── src/                   # React 19 Frontend Application
│   ├── components/        # UI components, camera modal, QR scanner, Shell
│   ├── lib/apiClient.ts   # Native offline-first data & auth client
│   └── views.tsx          # Student, Faculty, Admin views
├── capacitor.config.ts    # Capacitor native mobile configuration
├── vercel.json            # Vercel SPA routing and deployment configuration
└── vite.config.ts         # Vite build configuration
```

---

## 👥 Default Demo Credentials

When running with the local server, the following institutional accounts are pre-seeded:

| Role | Email | Password |
| :--- | :--- | :--- |
| **Admin** | `admin@attendx.edu` | `Admin@123456` |
| **Faculty** | `faculty@attendx.edu` | `Faculty@123456` |
| **Student** | `student@attendx.edu` | `Student@123456` |

---

## 📄 License

AttendX is distributed under the MIT License.
