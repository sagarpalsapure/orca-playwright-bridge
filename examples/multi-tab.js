// Read a value from every open Orca tab, concurrently.
// Run: node examples/multi-tab.js   (with a few tabs open in Orca)
const { orcaTabs } = require('orca-playwright-bridge');

(async () => {
  const tabs = orcaTabs();
  console.log(`${tabs.list.length} open tab(s):`);
  for (const t of tabs.list) console.log(`  ${t.active ? '*' : ' '} ${t.pageId.slice(0, 8)}  ${t.url}`);

  // evalAll runs across every tab in parallel (async), unlike the per-verb methods.
  const titles = await tabs.evalAll('document.title');
  console.log('\nTitles:');
  for (const r of titles) console.log(`  ${r.value || '(none)'}  —  ${r.url}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
