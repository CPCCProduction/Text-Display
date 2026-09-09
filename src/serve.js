'use strict';
// Headless entry point: runs the server without Electron, for a machine that
// only needs to host the display page and admin panel in a browser.
const { listen } = require('./server');
const config = require('./config');
const pkg = require('../package.json');

async function main() {
  const cfg = config.get();
  const server = await listen(Number(process.env.PORT) || cfg.port);
  const urls = server.urls();

  console.log(`${pkg.productName} v${pkg.version}`);
  console.log('');
  for (const url of urls) {
    console.log(`  submit   ${url}/submit`);
    console.log(`  admin    ${url}/admin`);
    console.log(`  parked   ${url}/parked`);
    console.log(`  display  ${url}/display`);
    console.log('');
  }
  console.log('Ctrl+C to stop.');

  // Close the listener before exiting so the port is free for an immediate
  // restart rather than sitting in TIME_WAIT behind a killed process.
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
