import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('vendored terminal bundles match the lockfile-installed upstream packages',async()=>{
 for(const [name,source] of [['xterm.js','@xterm/xterm/lib/xterm.js'],['xterm.css','@xterm/xterm/css/xterm.css'],['addon-fit.js','@xterm/addon-fit/lib/addon-fit.js']])assert.deepEqual(await readFile(new URL('../dist/vendor/'+name,import.meta.url)),await readFile(new URL('../node_modules/'+source,import.meta.url)));
});
