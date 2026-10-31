import puppeteer from 'puppeteer-core'

const BASE = 'https://attendx-lilac-zeta.vercel.app'
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. Login via the live API (retry — cold starts can drop the first request)
let loginJson = null
for (let attempt = 1; attempt <= 3 && !loginJson?.access_token; attempt++) {
  try {
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@attendx.edu', password: 'Admin@123456' }),
    })
    loginJson = await loginRes.json()
  } catch (err) {
    console.log(`login attempt ${attempt} failed:`, err.cause?.code || err.message)
    await sleep(3000)
  }
}
if (!loginJson?.access_token) {
  console.log('LOGIN FAILED:', JSON.stringify(loginJson).slice(0, 200))
  process.exit(1)
}
console.log('login ok, token len', loginJson.access_token.length)

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--window-size=1500,950'] })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 950 })

const issues = []
page.on('pageerror', (err) => issues.push(`[pageerror] ${err.message}`))
page.on('console', (msg) => {
  if (msg.type() === 'error' && !/Failed to load resource/i.test(msg.text())) issues.push(`[console] ${msg.text()}`)
})

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.evaluate((token, user, profile) => {
  localStorage.setItem('attendx_auth_token', token)
  localStorage.setItem('attendx_user', JSON.stringify(user))
  localStorage.setItem('attendx_profile', JSON.stringify(profile))
}, loginJson.access_token, loginJson.user, loginJson.profile)

await page.reload({ waitUntil: 'networkidle2', timeout: 45000 })
await sleep(2500)

const targets = ['Overview', 'People', 'Password requests', 'Classes', 'Review queue', 'Attendance queries', 'Mail Center', 'Records', 'Settings']
for (const label of targets) {
  issues.length = 0
  const clicked = await page.evaluate((lbl) => {
    const btn = [...document.querySelectorAll('.main-nav button')].find((b) => (b.textContent || '').includes(lbl))
    if (btn) { btn.click(); return true }
    return false
  }, label)
  if (!clicked) { console.log(`[${label}] nav button NOT FOUND`); continue }
  await sleep(2200)
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\n+/g, ' | '))
  console.log(`[${label}] errors: ${issues.length ? JSON.stringify(issues.slice(0, 3)) : 'none'} | content: ${bodyText.slice(0, 120)}`)
}

issues.length = 0
await page.evaluate(() => { const b = [...document.querySelectorAll('.account-button')][0]; if (b) b.click() })
await sleep(2000)
console.log(`[Profile] errors: ${issues.length ? JSON.stringify(issues.slice(0, 3)) : 'none'}`)

await page.screenshot({ path: 'public/screenshots/_audit-final.png' })
await browser.close()
console.log('AUDIT DONE')