// Fill and submit a form with the Playwright bridge — note the click-then-fill
// pattern (Orca ignores programmatic focus, so a bare page.fill() no-ops).
// Run: node examples/login-form.js
const { openOrcaTab } = require('orca-playwright-bridge');

const PAGE = 'data:text/html,' + encodeURIComponent(`<!doctype html><title>Login</title>
<form><input id=email placeholder=email><input id=pw type=password placeholder=password>
<button id=go>Sign in</button><div id=out></div></form>
<script>go.onclick=e=>{e.preventDefault();out.textContent='submitted: '+email.value}</script>`);

(async () => {
  const t = await openOrcaTab(PAGE);
  try {
    await t.page.click('#email'); await t.page.fill('#email', 'sagar@example.com');
    await t.page.click('#pw');    await t.page.fill('#pw', 'hunter2');
    await t.page.click('#go');
    await t.page.waitForFunction("document.getElementById('out').textContent.length > 0");
    console.log(await t.page.locator('#out').innerText());   // -> "submitted: sagar@example.com"
  } finally {
    await t.close();   // closes the bridge AND the Orca tab
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
