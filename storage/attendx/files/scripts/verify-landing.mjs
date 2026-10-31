import puppeteer from 'puppeteer-core';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
await page.goto('http://localhost:4173', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 4500));
await page.screenshot({ path: 'public/screenshots/_verify-landing-hero.png' });
// scroll to showcase
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.42));
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'public/screenshots/_verify-landing-mid.png' });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'public/screenshots/_verify-landing-end.png' });
// mobile
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.goto('http://localhost:4173', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: 'public/screenshots/_verify-landing-mobile.png' });
await browser.close();
console.log('landing verification shots saved');
