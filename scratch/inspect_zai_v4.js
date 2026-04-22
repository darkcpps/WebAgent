const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#chat-input', { timeout: 30000 });
    await page.fill('#chat-input', 'Hi');
    await page.click('#send-message-button');
    console.log('MESSAGE_SENT');
    await page.waitForTimeout(15000); 
    const data = await page.evaluate(() => {
      const res = [];
      const seen = new Set();
      document.querySelectorAll('*').forEach(el => {
        const str = (el.className || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-role') || '');
        if (/assistant|message|prose|markdown|think|thought/i.test(str) && el.innerText.trim() && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') {
             const key = el.tagName + el.className + el.innerText.trim().slice(0, 20);
             if (!seen.has(key)) {
                res.push({
                    tag: el.tagName,
                    classes: el.className,
                    id: el.id,
                    text: el.innerText.trim().slice(0, 200),
                    role: el.getAttribute('data-role') || el.getAttribute('role') || el.getAttribute('aria-role')
                });
                seen.add(key);
             }
        }
      });
      return res;
    });
    console.log(JSON.stringify(data, null, 2));
  } catch(e) {
    console.error(e.message);
  } finally {
    await browser.close();
  }
})();
