const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
  await page.goto('http://localhost:3000', {waitUntil: 'networkidle0'});
  
  await page.type('input[type="text"]', 'testuser');
  await page.type('input[type="password"]', 'testpass');
  await page.click('button.btn-primary');
  
  await page.waitForNavigation({waitUntil: 'networkidle0'});
  console.log('Logged in. Clicking chat item...');
  
  const chats = await page.$$('.chat-item');
  if(chats.length > 0) {
      await chats[0].click();
      await page.evaluate(() => new Promise(r => setTimeout(r, 1000)));
      console.log('Clicked first chat item.');
  } else {
      console.log('No chat items found.');
  }
  
  await browser.close();
})();
