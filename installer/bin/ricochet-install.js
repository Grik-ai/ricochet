#!/usr/bin/env node

const { runInstaller } = require('../lib/installer');

runInstaller()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`Ricochet install failed: ${error.message || error}`);
    process.exitCode = 1;
  });
