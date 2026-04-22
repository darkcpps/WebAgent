const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    console.log('Navigating and waiting for app initialization...');
    await page.goto('https://chat.z.ai/', { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(15000); 
    
    const data = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, textarea, [role="button"], [aria-label], [contenteditable]'));
        return els.map(el => ({
            tag: el.tagName,
            type: el.getAttribute('type'),
            label: el.getAttribute('aria-label'),
            text: el.innerText.trim().slice(0, 50),
            classes: el.className,
            placeholder: el.getAttribute('placeholder'),
            dataRole: el.getAttribute('data-role'),
            dataTestId: el.getAttribute('data-testid')
        }));
    });
    console.log('ELEMENTS_DATA_START');
    console.log(JSON.stringify(data, null, 2));
    console.log('ELEMENTS_DATA_END');

    const input = await page.$('textarea, [placeholder*="message" i], [placeholder*="chat" i]');
    console.log(input ? 'CHAT_INPUT_PROBABLY_SELECTED' : 'CHAT_INPUT_NOT_FOUND');

  } catch (e) {
    console.error('CRITICAL_ERROR: ' + e.message);
  } finally {
    await browser.close();
  }
})();
