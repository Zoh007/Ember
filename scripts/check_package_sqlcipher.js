const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

  const executableName = process.platform === 'win32' ? 'recall-ai.exe' : 'recall-ai';
  const executablePath = path.join(dist, executableName);

  if (!fs.existsSync(executablePath)) {
    console.error('Packaged executable not found at', executablePath);
    process.exit(1);
  }

  const result = spawnSync(executablePath, ['check-sqlcipher'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) {
    console.error('Failed to run packaged SQLCipher check:', result.error.message);
    process.exit(1);
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  let payload;
  try {
    payload = JSON.parse((result.stdout || '').trim() || '{}');
  } catch (error) {
    console.error('Packaged SQLCipher check did not return valid JSON.');
    process.exit(1);
  }

  if (!payload.sqlcipher_imported || !payload.memory_database_created) {
    console.error('Packaged SQLCipher check failed:', JSON.stringify(payload));
    process.exit(1);
  }

  console.log('Packaged SQLCipher check passed:', JSON.stringify(payload));
  process.exit(0);
}

main();
