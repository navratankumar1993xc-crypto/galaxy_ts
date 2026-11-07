'use strict';
// Wipes data/ and rebuilds it from schema + seed, with the demo reseller chain.
// Stop the server first: SQLite keeps the file open, so deleting it underneath a
// running process would leave that process writing to an orphaned inode.
const fs = require('fs');
const path = require('path');
const { DB_FILE } = require('../src/config');

for (const suffix of ['', '-wal', '-shm']) {
  const f = DB_FILE + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
  console.log('removed ' + path.basename(f));
}

// Required only after the old file is gone, so db/index.js creates a clean one.
const seed = require('./seed');
seed.bootstrap();
seed.demo();
