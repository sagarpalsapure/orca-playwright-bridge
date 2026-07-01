// Emulate a phone and capture a full-page screenshot via the raw-CDP driver.
// Device metrics apply instantly (no reload), and the shot spans beyond the
// viewport. Run: node examples/device-screenshot.js <url> [out.png]
const { connectOrca } = require('orca-playwright-bridge/connect');

(async () => {
  const url = process.argv[2] || 'https://example.com';
  const out = process.argv[3] || 'device-shot.png';

  const orca = await connectOrca();
  try {
    await orca.emulate({ device: 'iPhone 12', timezone: 'Asia/Tokyo' });
    await orca.goto(url);
    const buf = await orca.fullPageScreenshot(out);
    console.log(`captured ${buf.length} bytes -> ${out}`);
    console.log('viewport:', await orca.evaluate('innerWidth + "x" + innerHeight'));
  } finally {
    await orca.close();   // detaches; does NOT quit Orca
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
