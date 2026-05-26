const fs = require('fs');
const path = require('path');

function findDistPython(root) {
  const d = path.join(root, 'dist-python');
  if (fs.existsSync(d)) return d;
  const resources = path.join(root, 'release');
  if (fs.existsSync(resources)) return resources; // best-effort
  return null;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const dist = findDistPython(root);
  if (!dist) {
    console.error('No dist-python or release directory found. Build first.');
    process.exit(2);
  }

  // Look for known sqlcipher wheel or binary names in dist
  const names = fs.readdirSync(dist);
  const found = names.some((n) => /sqlcipher/i.test(n) || /libsqlcipher|sqlcipher3/.test(n));
  if (!found) {
    console.error('SQLCipher artifacts not found in', dist);
    process.exit(1);
  }

  console.log('Found SQLCipher artifacts in', dist);
  process.exit(0);
}

main();
