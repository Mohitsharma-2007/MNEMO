## v2.0.0 — Native Android app (Kotlin + Jetpack Compose)

The APK is no longer a WebView wrapper around the web app. It's a **real native Android app** built in Kotlin and Jetpack Compose (the same approach native Android apps like WhatsApp use), talking directly to the AttendX backend.

**What's native now**
- **Login** with role picker and OTP forgot-password flow (OTP emailed via Gmail SMTP)
- **Student**: dashboard with live attendance % from the database; **Mark attendance** screen with native camera QR scanning (CameraX + ZXing), GPS lock, and live selfie capture — all submitted as verifiable evidence
- **Faculty**: start a geofenced live session, display a rotating native QR, watch the roster fill in live
- **Admin**: people directory straight from the backend
- **Mail Center**: raise service requests, complaints, enquiries — every request gets a tracking number and confirmation email; track by request number; admins can resolve
- **Profile**: server connection (AttendX cloud or your LAN server) with test button, change password, sign out
- **Integrity gate**: blocks the app while Android Developer Options / USB debugging are on
- Same package (`in.attendx.app`) and signing key as before — **installs upgrade in place, no uninstall needed**

**Also fixed**
- Opening the app now goes **straight to sign-in** — the web landing page no longer shows in the APK
- Layouts use `dvh` so full-screen pages fit the phone's visible area correctly
- Update endpoint derives versionCode consistently (2.0.0 → 20000) so the in-app update banner points everyone here

Install `AttendX-v2.0.0.apk` — it replaces the old WebView app on the same install.