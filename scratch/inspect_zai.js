const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    console.log('Navigating to Z.AI...');
    await page.goto('https://chat.z.ai/', { waitUntil: 'networkidle' });
    
    const data = await page.evaluate(() => {
      const getInfo = (el) => ({
        tag: el.tagName,
        id: el.id,
        classes: el.className,
        ariaLabel: el.getAttribute('aria-label'),
        type: el.getAttribute('type'),
        text: el.innerText.trim().slice(0, 30)
      });

      return {
        textareas: Array.from(document.querySelectorAll('textarea')).map(getInfo),
        buttons: Array.from(document.querySelectorAll('button')).map(getInfo),
        assistants: Array.from(document.querySelectorAll('[class*="assistant"], [data-role*="assistant"]')).map(getInfo),
        placeholders: Array.from(document.querySelectorAll('[placeholder]')).map(el => el.getAttribute('placeholder'))
      };
    });

    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
})();
