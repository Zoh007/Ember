const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');

function dataPath(...parts) {
  return path.join(process.resourcesPath || path.resolve(__dirname, '..', '..'), ...parts);
}

function tessdataPath() {
  const candidates = [
    dataPath('tessdata'),
    path.resolve(__dirname, '..', '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'),
    path.resolve(__dirname, '..', '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'eng.traineddata.gz'))) || candidates[0];
}

async function extractScreenText(imagePath) {
  const worker = await createWorker('eng', 1, {
    langPath: tessdataPath(),
    cachePath: dataPath('tesseract-cache'),
    gzip: true,
  });
  try {
    const result = await worker.recognize(imagePath);
    return (result.data.text || '').replace(/\s+/g, ' ').trim();
  } finally {
    await worker.terminate();
  }
}

module.exports = {
  extractScreenText,
};
