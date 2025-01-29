const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const LOGS_DIR = process.env.LOGS_DIR || path.join(DATA_DIR, 'logs');

async function initDirs() {
  const dirs = [
    path.join(UPLOAD_DIR, 'avatars'),
    path.join(UPLOAD_DIR, 'documents'),
    path.join(LOGS_DIR, 'access'),
    path.join(LOGS_DIR, 'error'),
    path.join(LOGS_DIR, 'audit')
  ];

  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        console.error(`Error creating directory ${dir}:`, error);
      }
    }
  }
}

initDirs().catch(console.error);