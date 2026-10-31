## v1.0.8 — stability release

**Fixes**
- **Login-page crash fixed** — the console-protection key handler crashed the page on certain keys (`Cannot read properties of undefined (reading 'toUpperCase')`). Guarded.
- **401 storm fixed at the root** — session tokens are now persisted in the database, so they survive server restarts and Vercel cold starts. Previously every restart silently killed all tokens, producing endless 401s on `/api/notices` and `/api/notices/catalog`.
- **Graceful session expiry** — if a token is ever rejected (401) by the bell poll, Mail Center, or data calls, the app now clears it and returns to the login screen instead of retrying forever.
- **Login page layout fixed** — the "Back to home" link was a stray grid cell that pushed the sign-in form below the dark promo panel (broken two-column layout). The form now sits correctly beside the promo panel.
- **Autocomplete attributes** added to all email/password inputs (clears browser console warnings).

**Included from previous releases**
- Mail Center (all 11 mail types + tracking numbers), user directory with class/batch/year filters, attendance queries, MongoDB Atlas backend, cinematic landing page, console protection, developer-mode detection.