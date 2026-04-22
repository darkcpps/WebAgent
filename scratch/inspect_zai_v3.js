const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(10000);
    const data = await page.evaluate(() => {
      const res = [];
      document.querySelectorAll('*').forEach(el => {
        const str = (el.className || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-role') || '') + ' ' + (el.getAttribute('data-testid') || '');
        const match = /assistant|message|chat|send|submit|prompt/i.test(str);
        if (match && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') {
          res.push({
            tag: el.tagName,
            classes: el.className,
            id: el.id,
            label: el.getAttribute('aria-label'),
            dataRole: el.getAttribute('data-role'),
            dataTestId: el.getAttribute('data-testid'),
            text: el.innerText.trim().slice(0, 80)
          });
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
