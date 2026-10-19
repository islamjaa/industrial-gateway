const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('the administration UI uses forms rather than a JSON editor', () => {
  assert.match(html, /id="formFields"/);
  assert.match(html, /function renderSourceForm\(/);
  assert.match(html, /function renderTagForm\(/);
  assert.doesNotMatch(html, /id="editor"|Edit JSON configuration/i);
});

test('the tag form allows selecting a source device', () => {
  assert.match(html, /field\('sourceId','Source device'/);
  assert.match(html, /catalog\.sources\.map\(item => \(\{value:item\.id/);
  assert.match(html, /sourceId,\s*address:/);
});

test('the device form includes all supported drivers', () => {
  for (const driver of ['omron-fins','siemens-s7','modbus-tcp','modbus-rtu','allen-bradley','opcua-client']) {
    assert.ok(html.includes(`'${driver}'`), `missing driver ${driver} in the interface`);
  }
});

test('the form adapts addresses to the driver and displays Modbus fields', () => {
  for (const protocolHint of ['D00108','DB1,REAL4','Modbus offset (zero-based)','Logix tag name','OPC UA NodeId']) {
    assert.ok(html.includes(protocolHint), `Missing protocol hint ${protocolHint}`);
  }
  assert.match(html, /Modbus area \/ function/);
  assert.match(html, /Unit ID for this tag/);
});


test('test connection and verify tag use toast notifications', () => {
  assert.match(html, /id="toastRegion"/);
  assert.match(html, /function showToast\(/);
  assert.doesNotMatch(html, /id="writeNotice"/);
  assert.doesNotMatch(html, /<div id="success" class="success"/);
  assert.match(html, /action === 'test-source'[\s\S]*?showToast/);
  assert.match(html, /action === 'verify-tag'[\s\S]*?showToast/);
});

test('the UI configures automatic expression synchronization and does not show a manual send', () => {
  assert.match(html, /action === 'write-tag'/);
  assert.match(html, /autoWriteEnabled/);
  assert.match(html, /writeBackTargetTagId/);
  assert.match(html, /Automatic PLC synchronization/);
  assert.doesNotMatch(html, /action === 'write-expression-result'/);
  assert.doesNotMatch(html, /<div class=\"sidebar-footer\">/);
});

test('the expression editor supports inserting existing tags and opening a guide', () => {
  assert.match(html, /id="expressionTagSelector"/);
  assert.match(html, /id="insertExpressionTag"/);
  assert.match(html, /id="openExpressionGuide"/);
  assert.match(html, /id="expressionGuideOverlay"/);
  assert.match(html, /scale\(x,inMin,inMax,outMin,outMax\)/);
});
