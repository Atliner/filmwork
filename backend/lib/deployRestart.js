'use strict';
const path = require('path');
const fs = require('fs/promises');

// Passenger/cPanel observes the file on the next request. A different process
// supervisor, or a second separately launched app, is not controlled by it.
async function requestPassengerRestart(backendDir) {
  const restartDir = path.join(backendDir, 'tmp');
  await fs.mkdir(restartDir, { recursive: true });
  await fs.writeFile(path.join(restartDir, 'restart.txt'), `${Date.now()}\n`);
}
module.exports = { requestPassengerRestart };
