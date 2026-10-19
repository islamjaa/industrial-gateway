const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const excluded = new Set(['node_modules', '.git']);
const files = [];
const requiredPaths = [
  'scripts/doctor.js',
  'src/index.js',
  'src/database.js',
  'src/drivers/omron-fins.js',
  'src/drivers/siemens-s7.js',
  'src/drivers/modbus.js',
  'src/drivers/allen-bradley.js',
  'src/drivers/opcua-client.js',
  'src/services/catalog-store.js',
  'src/services/expression-engine.js',
  'src/services/write-value.js',
  'src/services/driver-manager.js',
  'src/services/poller.js',
  'src/web/server.js',
  'public/index.html',
  'test/catalog-store.test.js',
  'test/driver-factory.test.js',
  'test/driver-write.test.js',
  'test/expression-engine.test.js',
  'test/write-value.test.js',
  'test/omron-driver.test.js',
  'test/siemens-driver.test.js',
  'test/modbus-driver.test.js',
  'test/allen-bradley-driver.test.js',
  'test/opcua-driver.test.js',
  'test/value-decode.test.js'
];
const missing = requiredPaths.filter(relative => !fs.existsSync(path.join(root, relative)));
if (missing.length) {
  console.error('[ERROR] The package is incomplete. Missing files:');
  for (const item of missing) console.error(`  - ${item}`);
  process.exit(1);
}
const testFiles = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js'));
if (testFiles.length < 11) {
  console.error(`[ERROR] Expected at least 11 test files; found ${testFiles.length}.`);
  process.exit(1);
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) walk(path.join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }
}
walk(root);
let failed = false;
for (const file of files) {
  try {


    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  } catch (error) {
    failed = true;
    process.stderr.write(`\n[ERROR] ${path.relative(root, file)}\n${error.stack || error.message}\n`);
  }
}
const htmlPath = path.join(root, 'public', 'index.html');
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  for (let index = 0; index < scripts.length; index += 1) {
    try {
      new vm.Script(scripts[index][1], { filename: `${htmlPath}#inline-script-${index + 1}` });
    } catch (error) {
      failed = true;
      process.stderr.write(`\n[ERROR] Inline JavaScript in public/index.html (block ${index + 1})\n${error.stack || error.message}\n`);
    }
  }
}
if (failed) process.exit(1);
console.log(`Syntax valid: ${files.length} JavaScript files and inline UI scripts. Complete package: ${testFiles.length} test files found.`);
