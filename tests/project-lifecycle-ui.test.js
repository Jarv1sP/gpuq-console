import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSelectHTML} from '../dist/project-management-ui.js';
test('logical project options preserve immutable values, archived recovery and escaped presentation',()=>{
 const rows=[{project:'alpha',displayName:'<Chinese>',logicalProjectId:'group',logicalProjectName:'<research>'},{project:'old',lifecycle:{state:'ARCHIVED'}},{project:'plain'}];
 const normal=projectSelectHTML(rows);assert.match(normal,/value="alpha"/);assert.match(normal,/optgroup label="&lt;research&gt;"/);assert.doesNotMatch(normal,/<Chinese>|<research>|value="old"/);
 assert.match(projectSelectHTML(rows,'old'),/value="old".*已归档/);
 assert.match(projectSelectHTML(rows,'',true),/value="old"/);
});
