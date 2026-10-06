import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSelectHTML} from '../dist/project-management-ui.js';
test('logical project options preserve immutable values, archived recovery and escaped presentation',()=>{
 const rows=[{project:'alpha',displayName:'<Chinese>',logicalProjectId:'group',logicalProjectName:'<research>'},{project:'old',lifecycle:{state:'ARCHIVED'}},{project:'plain'}];
 const normal=projectSelectHTML(rows);assert.match(normal,/value="alpha"/);assert.match(normal,/optgroup label="&lt;research&gt;"/);assert.doesNotMatch(normal,/<Chinese>|<research>|value="old"/);
 assert.match(projectSelectHTML(rows,'old'),/value="old".*已归档/);
 assert.match(projectSelectHTML(rows,'',true),/value="old"/);
});
test('cross-server project values, labels and archive filtering stay distinct',()=>{
 const rows=[
  {project:'alpha',machine:'node-a',selectionValue:'alpha',displayName:'实验 A',logicalProjectId:'group',logicalProjectName:'研究'},
  {project:'alpha',machine:'node-b',selectionValue:'["node-b","alpha"]',displayName:'实验 B',logicalProjectId:'group',logicalProjectName:'研究',pending:true,lifecycle:{state:'ARCHIVED'}},
 ];
 const normal=projectSelectHTML(rows,'alpha',false,()=> '个人容器');
 assert.match(normal,/data-project="alpha" data-machine="node-a"/);
 assert.match(normal,/实验 A · 个人容器 · node-a/);
 assert.doesNotMatch(normal,/data-machine="node-b"/);
 const recovered=projectSelectHTML(rows,'["node-b","alpha"]',false);
 assert.match(recovered,/value="\[&quot;node-b&quot;,&quot;alpha&quot;\]"/);
 assert.match(recovered,/实验 B · node-b · 待确认 · 已归档/);
 assert.match(projectSelectHTML(rows,'',true),/data-machine="node-b"/);
});
