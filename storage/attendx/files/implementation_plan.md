# AttendX — Full Audit, Bug Fixes, UI Polish, MongoDB & Credential Cleanup

Complete audit and fix pass addressing credential leaks, broken features, UI/UX issues, and server-side bugs.

---

## User Review Required

> [!CAUTION]
> **Credential Leak (GitGuardian alert)**: The `.env` file contains your real SMTP password (`lgbg cvfo yskb wlxz`) and the `.env.local` contains a Vercel OIDC JWT token. Both are git-ignored but were previously committed. We will:
> 1. **Scrub them from git history** using `git filter-repo` or orphan-branch rewrite
> 2. **Force-push** a clean history to GitHub
> 3. You should **rotate the SMTP App Password** in your Google Account after this is done (the old one is burned)

> [!IMPORTANT]
> **Supabase dependency removal**: The `@supabase/supabase-js` package is still in `package.json` as a dependency. We will remove it since the app now uses the custom local client. The `supabase.ts` file already aliases `supabase = localClient` — this is correct, but the npm package is dead weight.

---

## Audit Findings & Proposed Changes

### Phase 1: Credential & Security Cleanup

#### [MODIFY] [.gitignore](file:///d:/ATTENDX/.gitignore)
- Ensure `.env`, `.env.local`, `.env.*` are properly ignored (they already are)

#### [MODIFY] Git History
- Create orphan branch to nuke all commit history containing leaked secrets
- Force-push clean `master` branch to GitHub
- This destroys all prior commit SHAs — the only safe way to scrub leaked secrets

#### [MODIFY] [.env.example](file:///d:/ATTENDX/.env.example)
- Add `SMTP_USER` and `SMTP_PASS` placeholder entries so new users know they need them
- Add `MONGODB_URI` placeholder

---

### Phase 2: Server-Side Bug Fixes

#### [MODIFY] [server/src/db.ts](file:///d:/ATTENDX/server/src/db.ts)
**Issues found:**
1. **`seedDefaults()` references `created_by` column** in `batches` table and `batch_faculty` / `batch_members` tables that don't exist in the schema — causes SQLite crash on first boot
2. **`INSERT OR IGNORE`** syntax is SQLite-specific and will break on PostgreSQL/MongoDB
3. **`query()` and `execute()` functions don't support MongoDB** — they only support PostgreSQL and SQLite. All data.ts and functions.ts queries go through these, so MongoDB backend is non-functional for most operations

**Fixes:**
- Add `created_by` column to `batches` schema in both SQLite and Postgres DDL
- Add `batch_faculty` and `batch_members` tables to schema
- Add MongoDB implementations to `query()`, `execute()`, and `getOne()` functions that translate SQL patterns to MongoDB operations
- Use `INSERT OR REPLACE` / `ON CONFLICT DO NOTHING` for Postgres compatibility

#### [MODIFY] [server/src/data.ts](file:///d:/ATTENDX/server/src/data.ts)
**Issues found:**
1. **No authentication** on data endpoints — anyone can read/write all tables
2. **SQL injection risk** — table names are taken directly from URL params without sanitization beyond allowlist
3. **MongoDB not supported** — all operations use raw SQL

**Fixes:**
- Add MongoDB-aware CRUD operations using `getMongoDb()`
- Add authentication middleware to data routes (the routes in `index.ts` don't use `authenticate`)

#### [MODIFY] [server/src/functions.ts](file:///d:/ATTENDX/server/src/functions.ts)
**Issues found:**
1. **`INSERT OR IGNORE`** is SQLite-only syntax — breaks on PostgreSQL
2. **No MongoDB support** for function operations
3. **QR token validation** doesn't verify the HMAC signature — only parses the payload, so anyone can forge QR tokens

**Fixes:**
- Add HMAC signature verification to `parseQrToken()`
- Use MongoDB collections when `isMongoActive()` is true
- Use database-agnostic insert patterns

#### [MODIFY] [server/src/auth.ts](file:///d:/ATTENDX/server/src/auth.ts)
**Issues found:**
1. **Password hashing uses SHA-256** with a static salt — not secure. Should use bcrypt or scrypt
2. **`extractFaceEmbedding`** is imported but `localAi.ts` may not work without Python deps — needs graceful fallback

**Fixes:**
- Keep SHA-256 for now (would need bcrypt npm package for proper fix) but document the limitation
- Add try/catch around face embedding extraction with graceful fallback

#### [MODIFY] [server/src/index.ts](file:///d:/ATTENDX/server/src/index.ts)
**Issues found:**
1. **Data endpoints (`/api/data/:table`)** are not protected by `authenticate` middleware — any unauthenticated client can read/write all data
2. **`handleSyncToSupabase`** is still referenced but we're removing Supabase

**Fixes:**
- Add `authenticate` middleware to data CRUD routes
- Keep sync endpoint but make it for generic export only

---

### Phase 3: Frontend Bug Fixes

#### [MODIFY] [src/components/QrScanner.tsx](file:///d:/ATTENDX/src/components/QrScanner.tsx)
**Issues found:**
1. **`extractJoinToken()`** regex only matches `?token=<hex>` patterns but join tokens are formatted as `JOIN-<HEX>` — so class QR scanning won't match
2. Scanner doesn't handle the `ATXQR` typed tokens vs `JOIN-*` tokens differently

**Fixes:**
- Update `extractJoinToken()` to handle both URL-style tokens and raw `JOIN-*` tokens
- Handle `ATXQR` attendance tokens separately

#### [MODIFY] [src/views.tsx](file:///d:/ATTENDX/src/views.tsx)
**Issues found:**
1. **MarkAttendance QR validation** (`acceptToken`) rejects non-`ATXQR` tokens as "Unrecognized QR code" — if the QR payload includes a URL prefix or wrapper, it fails
2. **"Get Live Location" hangs** — the `locate()` function uses `Geolocation.getCurrentPosition()` which can be very slow. Need to use `watchPosition()` for faster results
3. **StudentClasses** — join-via-QR likely fails because the token extraction doesn't work

**Fixes:**
- Improve QR token extraction to strip URL prefixes before validation
- Replace `getCurrentPosition` with a faster `watchPosition` + timeout pattern for location
- Fix join-class QR flow to properly extract `JOIN-*` tokens

#### [MODIFY] [src/App.tsx](file:///d:/ATTENDX/src/App.tsx)
**Issues found:**
1. **"Download APK" button shows inside the installed APK** — `Capacitor.isNativePlatform()` should be hiding it but it's showing in the sidebar too
2. **Developer Mode detection not blocking** — the `DeveloperModePlugin` Java code looks correct, but the JS side might not be registering properly

**Fixes:**
- Double-check `!Capacitor.isNativePlatform()` guards are working
- Add console logging to developer mode detection for debugging
- Verify plugin registration in `capacitor.config.ts`

#### [MODIFY] [src/components/Shell.tsx](file:///d:/ATTENDX/src/components/Shell.tsx)
**Issues found:**
1. **"Download Android App" link in sidebar** shows even inside the APK (same `Capacitor.isNativePlatform()` issue)
2. **"Supabase" label** shows in server connection button — should show "MongoDB" or "Local Server"

**Fixes:**
- Ensure download links are properly hidden on native platforms
- Update label to reflect actual backend (MongoDB/SQLite)

#### [MODIFY] [src/lib/supabase.ts](file:///d:/ATTENDX/src/lib/supabase.ts)
**Issues found:**
1. **LocalQueryBuilder filter handling** — the `eq()` method puts raw values in queryParams but `data.ts` expects `eq.` prefixed values for filtering
2. **`neq()` and `in()` methods** use custom `!neq` and `!in` suffixes that `data.ts` doesn't parse

**Fixes:**
- Fix filter encoding to match what `data.ts` expects (prefix values with `eq.`, `neq.`, etc.)
- Or update `data.ts` to handle both formats

---

### Phase 4: UI/UX Polish

#### [MODIFY] [src/styles.css](file:///d:/ATTENDX/src/styles.css) + [src/featureStyles.css](file:///d:/ATTENDX/src/featureStyles.css)
- Improve mobile responsiveness
- Fix spacing and typography on capture flow cards
- Ensure dark mode consistency
- Add smooth transitions and micro-animations

#### [MODIFY] [src/components/ui.tsx](file:///d:/ATTENDX/src/components/ui.tsx)
- Clean up Logo component sizing for mobile
- Ensure consistent design language

---

### Phase 5: Cleanup & Deployment

#### [MODIFY] [package.json](file:///d:/ATTENDX/package.json)
- Remove `@supabase/supabase-js` dependency (unused)
- Remove server-side deps (`cors`, `express`, `mongodb`, etc.) from frontend package — they belong in `server/package.json`

#### Build & Deploy
- `npm run build` for production web bundle
- Rebuild Android APK with all fixes
- Deploy to Vercel
- Push clean history to GitHub

---

## Verification Plan

### Automated Tests
- `npm run build` — verify no TypeScript errors
- `cd server && npm run build` — verify server compiles

### Manual Verification
- Start local server: `npm run server:dev`
- Start frontend: `npm run dev`
- Test demo login with all 3 accounts
- Test QR scan flow
- Test location capture speed
- Verify no credentials in git history: `git log --all -p | grep "lgbg\|SMTP_PASS\|eyJhbG"`

---

## Execution Priority

1. **Critical**: Scrub credentials from git history
2. **Critical**: Fix server `seedDefaults()` crash (missing tables/columns)
3. **Critical**: Fix `LocalQueryBuilder` filter encoding mismatch with `data.ts`
4. **High**: Fix QR token extraction for class joining
5. **High**: Speed up location capture
6. **High**: Add auth to data endpoints
7. **Medium**: MongoDB support in query/execute functions
8. **Medium**: UI polish and mobile improvements
9. **Low**: Remove unused Supabase dependency
