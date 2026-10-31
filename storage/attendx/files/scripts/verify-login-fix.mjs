import puppeteer from 'puppeteer-core'

const BASE = 'http://localhost:4173'
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--window-size=1400,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 900 })

const errors = []
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()) })

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 })
await sleep(1500)

// Landing page → click Sign in (the Landing has a launch/sign-in CTA)
const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button, a')].filter((b) => /sign in|get started|launch/i.test(b.textContent || ''))
  if (btns[0]) { btns[0].click(); return true }
  return false
})
console.log('sign-in click:', clicked)
await sleep(1500)

// Simulate the crash scenario: keydown with undefined key
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }))
})
await sleep(500)

const state = await page.evaluate(() => {
  const brand = document.querySelector('.login-brand')
  const formSide = document.querySelector('.login-form-side')
  const form = document.querySelector('.login-form')
  const backLink = document.querySelector('.login-page > .back-link') // should be null now
  const backInForm = document.querySelector('.login-form-side > .back-link')
  const brandRect = brand?.getBoundingClientRect()
  const formRect = formSide?.getBoundingClientRect()
  return {
    hasBrand: Boolean(brand),
    hasForm: Boolean(form),
    brandHeight: brandRect ? Math.round(brandRect.height) : null,
    formTop: formRect ? Math.round(formRect.top) : null,
    formLeft: formRect ? Math.round(formRect.left) : null,
    formWidth: formRect ? Math.round(formRect.width) : null,
    strayBackLink: Boolean(backLink), // grid-stealing bug if true
    backInForm: Boolean(backInForm),
  }
})
console.log('layout state:', JSON.stringify(state))

await page.screenshot({ path: 'public/screenshots/_verify-login-fix.png' })
console.log('errors:', errors.length ? errors.slice(0, 5) : 'NONE')
await browser.close()