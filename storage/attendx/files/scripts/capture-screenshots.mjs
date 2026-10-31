import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4173';
const API = 'http://localhost:3001';
const OUT = 'public/screenshots';
mkdirSync(OUT, { recursive: true });

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@attendx.edu', password: 'Admin@123456' }),
}).then((r) => r.json());

if (!login.access_token) {
  console.error('Login failed:', login);
  process.exit(1);
}
const token = login.access_token;
const user = login.user;
console.log('token ok, user id:', user?.id);

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});

async function newPage(width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument((tok, usr) => {
    localStorage.setItem('attendx_auth_token', tok);
    localStorage.setItem('attendx_user', JSON.stringify(usr));
    localStorage.setItem('attendx_server_url', 'http://localhost:3001');
  }, token, user);
  return page;
}

async function clickNav(page, label) {
  const clicked = await page.evaluate((text) => {
    const btns = [...document.querySelectorAll('.main-nav button, .mobile-nav button')];
    const btn = btns.find((b) => b.textContent.trim().toLowerCase() === text.toLowerCase());
    if (btn) { btn.click(); return true; }
    return false;
  }, label);
  return clicked;
}

async function capture({ name, label, width, height }) {
  const page = await newPage(width, height);
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  // Wait for the authenticated shell
  try {
    await page.waitForSelector('.app-shell', { timeout: 20000 });
  } catch {
    console.error('app-shell not found for', name, '— falling back to UI login');
    await page.waitForSelector('.text-input', { timeout: 10000 });
    await page.type('input[type="email"]', 'admin@attendx.edu');
    await page.type('input[type="password"]', 'Admin@123456');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.app-shell', { timeout: 20000 });
  }
  await new Promise((r) => setTimeout(r, 2000));
  if (label) {
    const ok = await clickNav(page, label);
    if (!ok) console.error('nav not found:', label);
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Scroll through the page so lazy content loads, then back to top
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('captured', name);
  await page.close();
}

// Login page (fresh profile, no token)
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${OUT}/login.png` });
  console.log('captured login');
  await page.close();
}

await capture({ name: 'admin-dashboard', label: null, width: 1440, height: 900 }); // Overview
await capture({ name: 'mail-center', label: 'Mail Center', width: 1440, height: 900 });
await capture({ name: 'classes', label: 'Classes', width: 1440, height: 900 });
await capture({ name: 'people', label: 'People', width: 1440, height: 900 });
await capture({ name: 'queries', label: 'Attendance queries', width: 1440, height: 900 });
await capture({ name: 'mobile-dashboard', label: null, width: 390, height: 844 });
await capture({ name: 'mobile-mail', label: 'Mail Center', width: 390, height: 844 });

await browser.close();
console.log('done');
