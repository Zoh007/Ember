const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pythonDistDir = path.join(root, 'dist-python');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

fs.rmSync(pythonDistDir, { recursive: true, force: true });
fs.mkdirSync(pythonDistDir, { recursive: true });

run(python, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
run(python, ['-m', 'pip', 'install', 'pyinstaller']);
run(python, [
  '-m',
  'PyInstaller',
  '--clean',
  '--onefile',
  '--name',
  'recall-ai',
  '--distpath',
  pythonDistDir,
  '--workpath',
  path.join(root, 'build', 'pyinstaller'),
  '--specpath',
  path.join(root, 'build', 'pyinstaller'),
  path.join(root, 'scripts', 'recall_ai_entry.py'),
]);
