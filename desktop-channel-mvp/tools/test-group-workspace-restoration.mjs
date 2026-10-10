import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithEsbuild } from 'vite';
const sourceUrl = new URL('../src/components/ProjectGroupWorkspace.jsx', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const imports = {};
for (const [, name] of source.matchAll(/from "([^"]+)"/g)) {
  if (name === 'react' || name === '@phosphor-icons/react') continue;
  imports[name] = name.includes('ArtifactDeliveryEntry') ? { ArtifactDeliveryEntry: props => ({ type: 'artifact-delivery', props }) }
    : name.includes('GroupAssignmentCapsule') ? { GroupAssignmentCapsule: props => ({ type: 'assignment-capsule', props }) }
    : name.includes('MaximizeButton') ? { MaximizeButton: () => null }
    : name.includes('GroupReviewerConfigurator') ? { GroupReviewerConfigurator: props => ({ type: 'div', props: {
    reviewerConfiguration: props, ref: props.cardRef, className: `group-reviewer-team-card${props.reviewerIds.length ? ' is-active' : ' group-reviewer-team-card-empty'}`,
    onDrop: event => props.onAdd(event.dataTransfer.getData('application/x-group-employee')),
    children: props.reviewerIds.map(id => ({ type: 'span', props: { title: id } })),
  } }) }
    : name.includes('EmployeeTaskActivity') ? { EmployeeTaskActivity: props => ({ type: 'employee-activity', props }) }
    : name.endsWith('.jsx') ? { [name.includes('History') ? 'GroupRunHistory' : 'GroupReviewOpinions']: name }
      : name.includes('employeeCharacters') ? { employeeCharacterFor: () => null } : await import(new URL(name, sourceUrl));
}
const { code } = await transformWithEsbuild(source, 'ProjectGroupWorkspace.jsx', { loader: 'jsx', format: 'cjs', jsx: 'automatic' });
const slots = []; let index = 0; let effects = [];
const react = {
  useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
  useRef(initial) { const i = index++; return slots[i] ||= { current: initial }; },
  useMemo: fn => fn(), useEffect(fn) { effects.push(fn); },
};
const module = { exports: {} }; const jsx = (type, props) => typeof type === 'function' ? type(props) : ({ type, props });
let requestSequence = 0;
vm.runInNewContext(code, { module, exports: module.exports, AbortController, crypto: { randomUUID: () => `fixture-request-${++requestSequence}` }, window: { innerWidth: 1200, innerHeight: 900, setTimeout() {}, setInterval() { return 1; }, clearInterval() {} }, require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : name === '@phosphor-icons/react' ? new Proxy({}, { get: (_, key) => key }) : imports[name] });
const employees = ['a', 'b'].map(id => ({ id, name: id, version: 'v1', access: { callable: true, selectable: true } }));
function nodes(tree) { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []; }
let desktopApi = null;
let conversationProps = {};
function render() { index = 0; effects = []; return nodes(module.exports.ProjectGroupWorkspace({ employees, bootstrapReady: true, authenticated: true, desktopApi, ...conversationProps })); }
function button(text) {
  const labels = { '生成测试草案': '生成项目组规划草案', '采纳测试草案': '采纳', '取消运行': '停止 Group', '＋ 新建目标': '新建 Group 目标' };
  const value = render().find(n => n.type === 'button' && (n.props.children === (labels[text] || text) || n.props['aria-label'] === (labels[text] || text)));
  assert.ok(value, text); return value;
}
function field(label) { return render().find(n => n.props['aria-label'] === label); }
const composer = () => render().find(n => n.type === 'input' && String(n.props.placeholder || '').includes('目标'));
const canvas = () => render().filter(n => n.props.className?.startsWith('group-node '));
assert.equal(canvas().length, 0, 'initial canvas does not imply employees are executing');
assert.equal(render().some(n => n.props.className === 'group-member-group-title is-direct'), false, 'direct member region does not repeat its access-group heading');
assert.equal(render().some(n => n.props.className === 'group-wait' && n.props.children === '可直接使用'), false, 'direct rows do not repeat the region access label');
assert.equal(composer().props.placeholder, '请先选择目标或点击右上角＋');
assert.equal(composer().props.disabled, true, 'an unselected workspace cannot implicitly create a Goal');
composer().props.onChange({ target: { value: 'Must not create implicitly' } });
await button('生成测试草案').props.onClick();
assert(render().some(n => n.props.className === 'group-prototype-toast' && String(n.props.children?.at?.(-1) || '').includes('右上角＋')));
assert.ok(effects.some(fn => fn.toString().includes('void refreshHistory()')), 'authenticated workspace fetches Center history before enabling the blank workspace');
desktopApi = { groupStudio: {
  history: async () => ({ ok: true, items: [{ goalId: 'historical-goal', title: 'Another Group', status: 'draft' }] }),
  message: async () => ({ groupIpcError: 'model_request_failed' }),
} };
render();
effects.find(fn => fn.toString().includes('void refreshHistory()'))();
await new Promise(resolve => setImmediate(resolve));
assert.equal(composer().props.disabled, false, 'a blank workspace can create a Goal even when other Groups exist in history');
assert.equal(composer().props.placeholder, '输入新的 Group 目标…');
composer().props.onChange({ target: { value: 'First goal from blank chat' } });
let firstGoalBody = null;
desktopApi.groupStudio.message = async ({ body }) => { firstGoalBody = body; return { groupIpcError: 'model_request_failed' }; };
await button('生成测试草案').props.onClick();
assert.equal(firstGoalBody?.objective, 'First goal from blank chat');
assert.equal(Object.hasOwn(firstGoalBody, 'continuation'), false, 'first send creates a Goal, not a continuation');
assert.equal(composer().props.value, 'First goal from blank chat', 'a failed first send keeps the unsent text');
button('＋ 新建目标').props.onClick();
assert.equal(composer().props.placeholder, '输入新的 Group 目标…');
const assignment = () => render().find(n => n.type === 'assignment-capsule');
assert.equal(assignment().props.locked, false);
assignment().props.onChoose('b');
assert.equal(Array.from(assignment().props.memberIds).join(','), 'b');
assert.equal(composer().props.value, 'First goal from blank chat', 'switching assignment retains unsent text');
await button('生成测试草案').props.onClick();
assert.equal(firstGoalBody.members.map(member => member.employeeId).join(','), 'b', 'explicit employee becomes the only canonical member');
assert.equal(assignment().props.locked, true, 'failed frozen request cannot silently change assignment');
assignment().props.onChoose('a');
assert.equal(Array.from(assignment().props.memberIds).join(','), 'b');
button('＋ 新建目标').props.onClick();
assignment().props.onChoose('not-entitled');
assert.equal(assignment().props.memberIds, null, 'unavailable choice does not select a fallback employee');
assignment().props.onChoose('b');
assignment().props.onChoose(null);
await button('生成测试草案').props.onClick();
assert.equal(firstGoalBody.members.map(member => member.employeeId).join(','), 'a,b', 'auto restores the ordinary canonical planning candidate set');
button('＋ 新建目标').props.onClick();
render().find(n => n.props.className?.startsWith('group-member-row')).props.onClick();
assert.equal(canvas().length, 0, 'single click only selects');
button('加入当前团队').props.onClick(); assert.equal(canvas().length, 1);
const reviewerCard = () => render().find(n => n.props.className?.includes('group-reviewer-team-card'));
const dropReviewer = id => nodes(reviewerCard()).find(n => n.props.onDrop).props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => id } });
assert.equal(render().some(n => n.type === 'fieldset' || n.props.className?.includes('group-reviewer-summary')), false, 'rejected right-hand form must stay absent');
button('＋ 新建目标').props.onClick();
dropReviewer('a'); dropReviewer('a');
assert.equal(canvas().length, 1, 'dropping an employee directly onto Reviewer also adds to team exactly once');
dropReviewer('b');
assert.equal(canvas().length, 2, 'review drop must not remove team members');
assert.equal(nodes(reviewerCard()).filter(n => n.type === 'span' && n.props.title).length, 2, 'duplicate drop is idempotent');
let reviewerRequest = null;
desktopApi = { groupStudio: { message: async ({ body }) => { reviewerRequest = body; throw new Error('fixture-stop'); } } };
composer().props.onChange({ target: { value: 'Reviewer configuration from direct drops' } });
await button('生成测试草案').props.onClick();
assert.equal(reviewerRequest?.reviewerGroup?.mode, 'sequential', 'second drop selects a valid multi-reviewer mode');
assert.equal(reviewerRequest?.reviewerGroup?.finalReviewerEmployeeId, 'a', 'first dropped reviewer is the default final reviewer');
assert.equal(Array.from(reviewerRequest?.reviewerGroup?.members || []).map(member => member.employeeId).join(','), 'a,b');
assert.equal(Array.from(reviewerRequest?.members || []).map(member => member.employeeId).join(','), 'a,b', 'Reviewer membership is also Group membership');
button('移出当前团队').props.onClick();
assert.equal(canvas().length, 1);
assert.equal(reviewerCard().props.reviewerConfiguration.reviewerMode, 'single');
assert.equal(reviewerCard().props.reviewerConfiguration.finalReviewerId, 'b');
const orbit = () => render().find(n => n.props['aria-label'] === '独立临时复核小组');
let stopped = false;
orbit().props.onDrop({ preventDefault() {}, stopPropagation() { stopped = true; }, dataTransfer: { getData: () => 'a' } });
assert.equal(stopped, true, 'orbit drop cannot bubble into ordinary team membership');
assert.equal(nodes(reviewerCard()).filter(n => n.type === 'span' && n.props.title).length, 2);
reviewerCard().props.ref.current = { getBoundingClientRect: () => ({ left: 0, right: 210, top: 540, bottom: 700, width: 210 }) };
orbit().props.ref.current = { getBoundingClientRect: () => ({ left: 740, right: 900, top: 590, bottom: 700, width: 160 }) };
const dropReviewerOutside = (id, x, y) => render().find(n => n.props.onDropCapture).props.onDropCapture({
  clientX: x, clientY: y, preventDefault() {}, stopPropagation() {},
  dataTransfer: { getData: type => type === 'application/x-group-reviewer' ? id : '' },
});
dropReviewerOutside('b', 100, 600);
assert.equal(reviewerCard().props.reviewerConfiguration.reviewerIds.length, 2, 'dropping within Reviewer keeps membership');
dropReviewerOutside('b', 800, 600);
assert.equal(reviewerCard().props.reviewerConfiguration.reviewerIds.length, 2, 'dropping within orbit keeps membership');
assert.equal(reviewerCard().props.reviewerConfiguration.onDragOut, undefined, 'dragend is not a removal action');
const beforeDrop = nodes(orbit()).find(n => n.type === 'span' && n.props.draggable === true);
assert.equal(beforeDrop.props.onDragEnd, undefined, 'Esc cancel and outside-window release have no destructive handler');
dropReviewerOutside('not-entitled', 300, 600);
assert.equal(reviewerCard().props.reviewerConfiguration.reviewerIds.length, 2, 'unknown Reviewer drag cannot remove members');
dropReviewerOutside('b', 300, 600);
assert.equal(reviewerCard().props.reviewerConfiguration.reviewerIds.length, 1, 'dragging outside Reviewer removes membership');
assert.equal(canvas().length, 2, 'removing Reviewer keeps the ordinary Group member');
dropReviewerOutside('a', 300, 600);
assert.equal(reviewerCard().props.reviewerConfiguration.reviewerIds.length, 0, 'orbit drag-out removes the final Reviewer');
assert.equal(canvas().length, 2, 'orbit drag-out preserves ordinary Group members');
dropReviewer('not-entitled');
assert.equal(canvas().length, 2, 'unknown employees cannot join');
console.log('Group confirmed interaction: direct reviewer drop, orbit drop, valid defaults, removal and identity checks');

const { mergeGroupHistory } = await import('../src/lib/groupRunHistory.js');
assert.deepEqual(mergeGroupHistory([{ key: 'persisted', goalId: 'persisted', status: 'draft' }], []), [], 'Center removal must win over cached drafts');
const { startGroupRunDemo } = await import('../src/lib/groupRunDemoFlow.js');
let submissions = 0;
await assert.rejects(startGroupRunDemo({ employees, selectedEmployeeIds: [], fetcher: async () => { submissions++; } }), /group_callable_members_unavailable/);
assert.equal(submissions, 0, 'explicit empty group cannot silently send all candidates');
let finishCancel; let deletes = 0;
const projection = { contractVersion: 'group-run-safe-projection.v1', runId: 'old-run', casRevision: 1, activation: 'active', status: 'running', steps: [] };
desktopApi = { groupStudio: {
  cancel: () => new Promise(resolve => { finishCancel = () => resolve({ ok: true, run: { runId: 'old-run' } }); }),
  projection: async () => ({ ok: true, projection: { ...projection, status: 'canceled', cancellationRequested: true } }),
  deleteHistory: async () => { deletes++; return { ok: true }; },
} };
const history = () => render().find(n => typeof n.type === 'string' && n.type.endsWith('GroupRunHistory.jsx'));
history().props.onSelect({ key: 'old-goal', goalId: 'old-goal', runId: 'old-run', projection });
employees[0].status = 'running';
assert.equal(render().some(n => n.props.className === 'group-wait' && n.props.children === 'running'), true, 'a real member runtime status remains visible');
delete employees[0].status;
const cancel = button('取消运行').props.onClick();
assert.equal(button('＋ 新建目标').props.disabled, true);
button('＋ 新建目标').props.onClick();
await history().props.onDelete({ key: 'old-goal', goalId: 'old-goal' });
history().props.onSelect({ key: 'new-goal', goalId: 'new-goal' });
assert.equal(deletes, 0);
assert.equal(history().props.selectedKey, 'old-goal', 'pending control cannot switch, delete or clear the active target');
finishCancel(); await cancel;
button('＋ 新建目标').props.onClick();
assert.equal(history().props.selectedKey, null);
assert.equal(render().some(n => n.type === 'button' && n.props.children === '取消运行'), false);
console.log('Group restoration async: deferred cancel excludes new/select/delete; remote history removal and explicit empty team passed');

// Unsent composer text is user-owned state, not part of the selected Goal.
composer().props.onChange({ target: { value: 'Keep this while switching goals' } });
history().props.onSelect({ key: 'composer-switch-a', goalId: 'composer-switch-a' });
assert.equal(composer().props.value, 'Keep this while switching goals', 'selecting a Goal keeps the already typed draft');
history().props.onSelect({ key: 'composer-switch-b', goalId: 'composer-switch-b' });
assert.equal(composer().props.value, 'Keep this while switching goals', 'selecting another Goal must not discard the unsent composer text');
button('＋ 新建目标').props.onClick();
assert.equal(composer().props.value, 'Keep this while switching goals', 'starting a new Goal must not discard the unsent composer text');
console.log('Group composer draft: unsent text survives history selection and new Goal');

let finishDelete;
desktopApi.groupStudio.deleteHistory = () => new Promise(resolve => { finishDelete = () => resolve({ ok: true }); });
history().props.onSelect({ key: 'delete-goal', goalId: 'delete-goal', runId: 'old-run', projection });
const deleting = history().props.onDelete({ key: 'delete-goal', goalId: 'delete-goal' });
button('＋ 新建目标').props.onClick();
history().props.onSelect({ key: 'other-goal', goalId: 'other-goal' });
assert.equal(history().props.selectedKey, 'delete-goal');
assert.equal(button('取消运行').props.disabled, true);
finishDelete(); await deleting;
assert.equal(history().props.selectedKey, null);
// Execute the actual follower effect with a delayed read. Re-selecting the same
// card must not invalidate its generation without recreating the effect.
let finishProjection;
desktopApi.groupStudio.projection = () => new Promise(resolve => { finishProjection = () => resolve({ ok: true, projection: { ...projection, status: 'canceled', cancellationRequested: true } }); });
history().props.onSelect({ key: 'same-goal', goalId: 'same-goal', runId: 'old-run', projection });
render();
const followEffect = effects.find(fn => fn.toString().includes('createGroupRunFollower'));
assert.ok(followEffect);
const stop = followEffect();
history().props.onSelect({ key: 'same-goal', goalId: 'same-goal', runId: 'old-run', projection });
finishProjection();
await new Promise(resolve => setImmediate(resolve));
assert.equal(render().some(n => n.type === 'button' && n.props.children === '取消运行'), false, 'same-card reselection must still apply the pending follower projection');
stop();
console.log('Group restoration lifecycle: deferred hide excludes switching; actual follower effect survives same-run reselection');

button('＋ 新建目标').props.onClick();
const requests = [];
let finishMaterial;
desktopApi.chooseAttachments = async () => ({ files: [{ id: 'file-a', name: 'fixture.txt', size: 10, type: 'text/plain' }], selectionId: 'selection-a' });
desktopApi.groupStudio.material = () => new Promise(resolve => { finishMaterial = () => resolve({ inputRef: { kind: 'artifact_ref', refId: 'material-A' } }); });
desktopApi.groupStudio.message = async ({ body }) => { requests.push(body); throw new Error('fixture-stop'); };
const choosing = render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick();
await new Promise(resolve => setImmediate(resolve));
button('＋ 新建目标').props.onClick();
finishMaterial(); await choosing;
composer().props.onChange({ target: { value: 'Goal B' } });
await button('生成测试草案').props.onClick();
assert.equal(requests.length, 1);
assert.equal(requests[0].inputRefs.length, 0, 'late material from A cannot enter B');
let selectedRequest;
const thirteen = Array.from({ length: 13 }, (_, i) => ({ id: `employee-${i}`, version: 'v1', access: { callable: true, selectable: true } }));
await assert.rejects(startGroupRunDemo({ employees: thirteen, selectedEmployeeIds: ['employee-12'], fetcher: async (_path, options) => { selectedRequest = JSON.parse(options.body); throw new Error('fixture-stop'); } }), /fixture-stop/);
assert.equal(selectedRequest.members[0].employeeId, 'employee-12');
console.log('Group isolation: late materials cannot cross new goals; selected employee beyond first 12 reaches request');

// Replanning a recovered draft keeps its own authorized objective and references.
button('＋ 新建目标').props.onClick();
const review = { goal: { goalId: 'draft-goal', revision: 1 }, draft: { inputRefs: [{ kind: 'artifact_ref', refId: 'draft-material' }] }, plan: { steps: [{ employeeId: 'a', stepId: 's1', dependsOn: [] }] }, groupVersion: { groupId: 'draft-group', version: 1, members: [{ employeeId: 'a', employeeVersion: 'v1' }] } };
desktopApi.groupStudio.history = async () => ({ ok: true, items: [{ goalId: 'draft-goal', title: 'Original objective', objective: 'Original objective', status: 'draft', planning: { goal: review.goal, groupVersion: review.groupVersion, planDraft: review.draft } }] });
await history().props.onRefresh();
history().props.onSelect(history().props.items.find(item => item.goalId === 'draft-goal'));
render().filter(n => n.props.className?.startsWith('group-member-row'))[1].props.onClick();
button('加入当前团队').props.onClick();
assert.equal(composer().props.value, 'Original objective');
await button('生成测试草案').props.onClick();
assert.equal(requests.at(-1).inputRefs[0].refId, 'draft-material');
for (const action of ['history', 'remove', 'replace']) {
  button('＋ 新建目标').props.onClick();
  const requestsBeforeAction = requests.length;
  let doneA, doneB; let calls = 0;
  desktopApi.groupStudio.material = () => new Promise(resolve => { const done = () => resolve({ inputRef: { kind: 'artifact_ref', refId: ++calls === 1 ? 'stale' : 'latest' } }); if (!doneA) doneA = done; else doneB = done; });
  const a = render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  if (action === 'history') history().props.onSelect({ key: 'fresh-history', goalId: 'fresh-history' });
  if (action === 'remove') render().find(n => n.props['aria-label'] === '移除fixture.txt').props.onClick();
  let b;
  if (action === 'replace') {
    desktopApi.chooseAttachments = async () => ({ files: [{ id: 'file-b', name: 'second.txt', size: 11, type: 'text/plain' }], selectionId: 'selection-b' });
    b = render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
  }
  doneA(); await a;
  if (b) { doneB(); await b; }
  if (action === 'history') button('加入当前团队').props.onClick();
  composer().props.onChange({ target: { value: `Goal ${action}` } });
  await button('生成测试草案').props.onClick();
  if (action === 'history') {
    assert.equal(requests.length, requestsBeforeAction, 'a selected card missing persisted context cannot fall through to a new Goal');
    continue;
  }
  assert.equal(requests.at(-1).inputRefs.length, action === 'replace' ? 1 : 0, action);
  if (action === 'replace') assert.equal(requests.at(-1).inputRefs[0].refId, 'latest');
}
console.log('Draft context and material fences: history switch, remove, successive selection and authorized replanning passed');

button('＋ 新建目标').props.onClick();
history().props.onSelect({ key: 'remote-draft', goalId: 'remote-draft', title: 'Truncated title', review });
render().filter(n => n.props.className?.startsWith('group-member-row'))[1].props.onClick();
button('加入当前团队').props.onClick();
assert.ok(button('采纳测试草案'), 'cannot discard recovered draft when complete objective is unavailable');
assert.equal(canvas().length, 1);
console.log('Remote history title is not reused as full objective; original draft retained');

button('＋ 新建目标').props.onClick();
render().find(n => n.props.className?.startsWith('group-member-row')).props.onClick();
button('加入当前团队').props.onClick();
const network = render().find(n => n.props.className === 'group-canvas');
network.props.ref.current = { getBoundingClientRect: () => ({ left: 100, right: 900, top: 0, bottom: 600, width: 800, height: 600 }) };
render().find(n => n.type === 'aside' && n.props.ref).props.ref.current = { getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 600 }) };
reviewerCard().props.ref.current = { getBoundingClientRect: () => ({ left: 0, right: 100, top: 200, bottom: 300 }) };
const target = { setPointerCapture() {}, hasPointerCapture() { return false; } };
canvas()[0].props.onPointerDown({ button: 0, pointerId: 1, clientX: 250, clientY: 250, currentTarget: target, preventDefault() {}, stopPropagation() {} });
canvas()[0].props.onPointerMove({ pointerId: 1, clientX: 50, clientY: 250 });
canvas()[0].props.onPointerUp({ type: 'pointerup', pointerId: 1, clientX: 50, clientY: 250, currentTarget: target });
assert.equal(canvas().length, 1, 'pointer drag onto reviewer must not hit whole-rail removal');
assert.equal(nodes(reviewerCard()).filter(n => n.type === 'span' && n.props.title).length, 1);
console.log('Actual pointer handlers: reviewer card wins over member-rail removal');

for (const variant of ['cancel', 'duplicate', 'empty-drop']) {
  button('＋ 新建目标').props.onClick();
  let done;
  const file = { id: 'same-file', name: 'same.txt', size: 10, type: 'text/plain' };
  desktopApi.chooseAttachments = async () => ({ files: [file], selectionId: 'same-selection' });
  desktopApi.groupStudio.material = () => new Promise(resolve => { done = () => resolve({ inputRef: { kind: 'artifact_ref', refId: 'still-valid' } }); });
  const selecting = render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  if (variant === 'empty-drop') await render().find(n => n.props.className?.split(' ').includes('group-composer')).props.onDrop({ preventDefault() {}, dataTransfer: { types: ["Files"], files: [] } });
  else {
    if (variant === 'cancel') desktopApi.chooseAttachments = async () => ({ canceled: true });
    await render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick();
  }
  done(); await selecting;
  composer().props.onChange({ target: { value: variant } });
  await button('生成测试草案').props.onClick();
  assert.equal(requests.at(-1).objective, variant);
  assert.equal(requests.at(-1).inputRefs[0].refId, 'still-valid');
}
console.log('Cancelled, duplicate and empty material selection preserve the valid in-flight preparation');

for (const change of ['remove', 'add']) {
  button('＋ 新建目标').props.onClick();
  desktopApi.chooseAttachments = async () => ({ files: [{ id: 'original', name: 'original.txt', size: 10, type: 'text/plain' }], selectionId: 'original-selection' });
  desktopApi.groupStudio.material = async () => ({ inputRef: { kind: 'artifact_ref', refId: 'original-material' } });
  await render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick();
  desktopApi.groupStudio.message = async ({ body }) => ({ ok: true, goal: { goalId: 'material-draft', revision: 1 }, groupVersion: { groupId: 'g', version: 'v1', members: [{ employeeId: 'a', employeeVersion: 'v1' }] }, planDraft: { planId: 'p', inputRefs: body.inputRefs, steps: [{ employeeId: 'a', stepId: 's1', dependsOn: [] }] } });
  composer().props.onChange({ target: { value: 'Plan with original material' } });
  await button('生成测试草案').props.onClick();
  assert.ok(button('采纳测试草案'));
  if (change === 'remove') render().find(n => n.props['aria-label'] === '移除original.txt').props.onClick();
  else {
    desktopApi.chooseAttachments = async () => ({ files: [{ id: 'extra', name: 'extra.txt', size: 12, type: 'text/plain' }], selectionId: 'extra-selection' });
    await render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick();
  }
  assert.equal(render().some(n => n.type === 'button' && n.props.children === '采纳测试草案'), false, `${change} must invalidate the old draft before adoption`);
}
console.log('Material removal/addition invalidate the old adoptable draft');

for (const pendingIntake of ['picker', 'drop']) {
  button('＋ 新建目标').props.onClick();
  let finishRegistration;
  const registration = () => new Promise(resolve => { finishRegistration = () => resolve({ files: [{ id: 'late', name: 'late.txt', size: 9, type: 'text/plain' }], selectionId: 'late-selection' }); });
  desktopApi.chooseAttachments = registration;
  desktopApi.registerDroppedAttachments = registration;
  let materialCalls = 0;
  desktopApi.groupStudio.material = async () => { materialCalls++; return { inputRef: { kind: 'artifact_ref', refId: 'late-material' } }; };
  const late = pendingIntake === 'picker'
    ? render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick()
    : render().find(n => n.props.className?.split(' ').includes('group-composer')).props.onDrop({ preventDefault() {}, dataTransfer: { types: ["Files"], files: [{ name: 'late.txt', size: 9, type: 'text/plain' }] } });
  composer().props.onChange({ target: { value: 'Plan before registration' } });
  await button('生成测试草案').props.onClick();
  assert.ok(button('采纳测试草案'));
  finishRegistration(); await late;
  assert.equal(materialCalls, 0, `${pendingIntake} registration from before planning cannot mutate its completed draft`);
  assert.equal(render().some(n => n.props['aria-label'] === '移除late.txt'), false);
  assert.ok(button('采纳测试草案'));
}
console.log('Deferred picker/drop registration cannot cross the planning boundary');
for (const pendingIntake of ['picker', 'drop']) {
  button('＋ 新建目标').props.onClick();
  let finishOldSelection;
  const registration = () => new Promise(resolve => { finishOldSelection = () => resolve({ files: [{ id: 'old-pick', name: 'old-pick.txt', size: 9, type: 'text/plain' }], selectionId: 'old-selection' }); });
  desktopApi.chooseAttachments = registration;
  desktopApi.registerDroppedAttachments = registration;
  const materialEmployees = [];
  desktopApi.groupStudio.material = async ({ body }) => { materialEmployees.push(body.employeeId); return { inputRef: { kind: 'artifact_ref', refId: 'new-employee-material' } }; };
  const oldSelection = pendingIntake === 'picker'
    ? render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick()
    : render().find(n => n.props.className?.split(' ').includes('group-composer')).props.onDrop({ preventDefault() {}, dataTransfer: { types: ["Files"], files: [{ name: 'old-pick.txt', size: 9, type: 'text/plain' }] } });
  assignment().props.onChoose('b');
  finishOldSelection(); await oldSelection;
  assert.equal(materialEmployees.length, 0, 'previous pending intake cannot prepare after employee selection changes');
  assert.equal(render().some(n => n.props['aria-label'] === '移除old-pick.txt'), false);
  desktopApi.chooseAttachments = async () => ({ files: [{ id: 'new-pick', name: 'new-pick.txt', size: 10, type: 'text/plain' }], selectionId: 'new-selection' });
  await render().find(n => n.props['aria-label'] === '选择 Group 材料').props.onClick();
  assert.deepEqual(materialEmployees, ['b'], 'new material uses the explicitly selected employee rather than catalog-first');
  assert.equal(assignment().props.locked, true, 'prepared attachments keep the assignment stable');
}
console.log('Assignment change fences pending picker/drop and prepares fresh material under selected employee');


// A Center-reserved continuation failure returns only a safe Goal/Group context.
// The local failure card immediately adopts that Goal key, so a history refresh
// and unchanged retry cannot duplicate it.
button('＋ 新建目标').props.onClick();
let continuationAttempt = 0; const continuationBodies = [];
desktopApi.groupStudio.message = async ({ body }) => {
  continuationBodies.push(body); continuationAttempt++;
  if (continuationAttempt === 1) {
    return { groupIpcError: 'model_request_failed', groupIpcContext: {
      goal: { goalId: 'goal-a', revision: 2 }, groupVersion: { groupId: 'group-a', version: 2 },
    } };
  }
  return { ok: true, goal: { goalId: 'goal-a', revision: 2 }, groupVersion: { groupId: 'group-a', version: 2, members: [{ employeeId: 'a', employeeVersion: 'v1' }] }, planDraft: { planId: 'plan-a2', steps: [{ employeeId: 'a', stepId: 's1', dependsOn: [] }] } };
};
composer().props.onChange({ target: { value: 'Follow up B' } });
await button('生成测试草案').props.onClick();
assert.equal(history().props.items.filter(item => item.key === 'goal-a' && item.goalId === 'goal-a').length, 1, 'safe failure context immediately binds the local card to its persisted Goal');
const refreshedFailureHistory = mergeGroupHistory(history().props.items, [{ key: 'goal-a', goalId: 'goal-a', status: 'failed', planning: {
  goal: { goalId: 'goal-a', revision: 2, planningContext: { groupId: 'group-a', groupVersion: 2 } }, groupVersion: { groupId: 'group-a', version: 2 },
} }]);
assert.equal(refreshedFailureHistory.filter(item => item.key === 'goal-a').length, 1, 'history refresh keeps one visible card for the failed persisted Goal');
history().props.onSelect({ key: 'goal-a', goalId: 'goal-a', status: 'planning', planning: { goal: { goalId: 'goal-a', revision: 2, planningContext: { groupId: 'group-a', groupVersion: 2 } }, groupVersion: { groupId: 'group-a', version: 2 } } });
composer().props.onChange({ target: { value: 'Follow up B' } });
await button('生成测试草案').props.onClick();
assert.equal(continuationBodies.length, 2); assert.equal(continuationBodies[0].idempotencyKey, continuationBodies[1].idempotencyKey, 'retry keeps original operation');
assert.equal(continuationBodies[1].continuation.goalId, 'goal-a'); assert.equal(continuationBodies[1].continuation.retry, true, 'retry uses the Center-returned continuation envelope');
assert.equal(history().props.items.filter(item => item.key === 'goal-a').length, 1, 'success replaces the same logical Goal card');
console.log('Group continuation retry: safe failure context freezes one Goal envelope and success keeps one card');

// A retry retains its idempotency key, but it is one local task and must not
// prepend duplicate cards that a single hide action can remove together.
button('＋ 新建目标').props.onClick();
const retryIdempotencyKeys = [];
desktopApi.groupStudio.message = async ({ body }) => { retryIdempotencyKeys.push(body.idempotencyKey); throw new Error('fixture-planner-failure'); };
composer().props.onChange({ target: { value: 'Retry the same goal' } });
for (let retry = 0; retry < 4; retry += 1) {
  await button('生成测试草案').props.onClick();
  assert.equal(composer().props.value, 'Retry the same goal', 'a failed send keeps its original composer text');
  assert.equal(history().props.items.filter(item => item.title === 'Retry the same goal').length, 1, 'a repeated idempotent retry has one local history card');
}
assert.equal(retryIdempotencyKeys.length, 4, 'each transient retry reaches the same frozen planning request');
assert.equal(new Set(retryIdempotencyKeys).size, 1, 'transient retries retain the original idempotency key without guessing another Goal');
composer().props.onChange({ target: { value: 'Changed before Goal binding' } });
await button('生成测试草案').props.onClick();
assert.equal(retryIdempotencyKeys.length, 4, 'an unknown first result cannot be changed into another implicit Goal request');
button('＋ 新建目标').props.onClick();
composer().props.onChange({ target: { value: 'Explicit new goal after frozen retry' } });
await button('生成测试草案').props.onClick();
assert.equal(retryIdempotencyKeys.length, 5, 'the explicit plus remains usable after a rejected changed retry');
assert.notEqual(retryIdempotencyKeys[4], retryIdempotencyKeys[0]);
await history().props.onDelete(history().props.items.find(item => item.title === 'Retry the same goal'));
assert.equal(history().props.items.filter(item => item.title === 'Retry the same goal').length, 0, 'hiding the retry card removes only that local task');
await history().props.onDelete(history().props.items.find(item => item.title === 'Explicit new goal after frozen retry'));
composer().props.onChange({ target: { value: 'Must stay unsubmitted after deleting selection' } });
await button('生成测试草案').props.onClick();
assert.equal(retryIdempotencyKeys.length, 5, 'deleting the current card cannot implicitly create another Goal');

const distinctObjectives = ['History one', 'History two', 'History three', 'History four'];
for (const objective of distinctObjectives) {
  button('＋ 新建目标').props.onClick();
  composer().props.onChange({ target: { value: objective } });
  await button('生成测试草案').props.onClick();
}
const beforeDelete = history().props.items.filter(item => distinctObjectives.includes(item.title)).map(item => item.key);
assert.equal(beforeDelete.length, 4, 'four distinct failed goals retain four independent cards');
await history().props.onDelete(history().props.items.find(item => item.key === beforeDelete[1]));
const afterDelete = history().props.items.filter(item => distinctObjectives.includes(item.title)).map(item => item.key);
assert.equal(afterDelete.length, 3, 'hiding one distinct failed goal preserves the other three cards');
assert.deepEqual([...afterDelete], [beforeDelete[0], beforeDelete[2], beforeDelete[3]]);
console.log('Failed planning history: idempotent retries upsert one card; one hide preserves other goals');

button('＋ 新建目标').props.onClick();
let finishPlanning;
const planningCancellationBodies = [];
desktopApi.groupStudio.message = () => new Promise((_, reject) => { finishPlanning = () => reject(new Error('agent_turn_canceled')); });
desktopApi.groupStudio.cancelPlanning = async ({ body }) => { planningCancellationBodies.push(body); return { ok: true, cancellation: 'canceled', goalId: 'stopped-goal', goalRevision: 1 }; };
desktopApi.groupStudio.history = async () => ({ ok: true, items: [{ goalId: 'stopped-goal', title: 'Stop this planning attempt', status: 'canceled' }] });
composer().props.onChange({ target: { value: 'Stop this planning attempt' } });
const planning = button('生成测试草案').props.onClick();
await new Promise(resolve => setImmediate(resolve));
const stopPlanningButton = field('停止 Group');
assert.ok(stopPlanningButton && !stopPlanningButton.props.disabled, 'busy planning exposes a real enabled stop control');
await stopPlanningButton.props.onClick();
assert.equal(planningCancellationBodies.length, 1);
assert.equal(field('Group 已停止，正在同步').props.disabled, true, 'confirmed stop cannot be clicked again while the original response settles');
finishPlanning(); await planning;
assert.equal(history().props.items.filter(item => item.key === 'stopped-goal' && item.status === 'canceled').length, 1, 'confirmed stop binds the transient card to the Center Goal');
assert.equal(render().some(n => n.type === 'button' && ['＋ 新建目标', '生成测试草案', '采纳测试草案', '取消运行', '重试推进'].includes(n.props.children)), false, 'the top bar no longer carries permanent text workflow actions');

button('＋ 新建目标').props.onClick();
let rejectBeforeCancel, finishCancelResponse;
desktopApi.groupStudio.message = () => new Promise(resolve => { rejectBeforeCancel = () => resolve({ groupIpcError: 'agent_turn_canceled', groupIpcContext: { goal: { goalId: 'race-goal', revision: 1 }, groupVersion: { groupId: 'race-group', version: 1 } } }); });
desktopApi.groupStudio.cancelPlanning = () => new Promise(resolve => { finishCancelResponse = () => resolve({ ok: true, cancellation: 'canceled', goalId: 'race-goal', goalRevision: 1 }); });
desktopApi.groupStudio.history = async () => ({ ok: true, items: [{ goalId: 'race-goal', title: 'Cancel response ordering', status: 'canceled' }] });
composer().props.onChange({ target: { value: 'Cancel response ordering' } });
const racedPlanning = button('生成测试草案').props.onClick();
await new Promise(resolve => setImmediate(resolve));
const racedStop = field('停止 Group').props.onClick();
rejectBeforeCancel(); await racedPlanning;
finishCancelResponse(); await racedStop;
assert.equal(history().props.items.filter(item => item.key === 'race-goal' && item.status === 'canceled').length, 1, 'canonical canceled message wins even when it settles before the stop response');

history().props.onSelect({ key: 'terminal-goal', goalId: 'terminal-goal', runId: 'terminal-run', projection: { ...projection, runId: 'terminal-run', status: 'completed' } });
assert.equal(field('停止 Group'), undefined, 'a terminal Run does not expose a fake stop action');
assert.equal(field('生成项目组规划草案').props.disabled, true, 'a retained terminal Run cannot start another Goal through its composer');
console.log('Group compact controls: planning stop confirms and rekeys; terminal Run returns to a disabled send arrow');

// A Draft may assign only a subset of the current GroupVersion candidates.
// The next message identifies that immutable GroupVersion and lets Center
// resolve its members instead of sending the Draft step subset as membership.
button('＋ 新建目标').props.onClick();
render().filter(n => n.props.className?.startsWith('group-member-row'))[0].props.onClick();
button('加入当前团队').props.onClick();
render().filter(n => n.props.className?.startsWith('group-member-row'))[1].props.onClick();
button('加入当前团队').props.onClick();
const candidateContinuationBodies = [];
desktopApi.groupStudio.message = async ({ body }) => {
  candidateContinuationBodies.push(body);
  const revision = candidateContinuationBodies.length;
  return { ok: true,
    goal: { goalId: 'candidate-goal', revision },
    groupVersion: { groupId: 'candidate-group', version: revision, members: [{ employeeId: 'a', employeeVersion: 'v1' }, { employeeId: 'b', employeeVersion: 'v1' }] },
    planDraft: { planId: `candidate-plan-${revision}`, steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: `candidate-step-${revision}`, dependsOn: [] }] },
  };
};
composer().props.onChange({ target: { value: 'Candidate group with one assigned step' } });
await button('生成测试草案').props.onClick();
composer().props.onChange({ target: { value: 'Revise the same candidate group' } });
await button('生成测试草案').props.onClick();
assert.equal(candidateContinuationBodies[0].members.map(member => member.employeeId).join(','), 'a,b', 'a new Goal sends the selected candidate members');
assert.equal(Object.hasOwn(candidateContinuationBodies[1], 'members'), false, 'a Draft continuation does not replace GroupVersion candidates with its step subset');
assert.equal(candidateContinuationBodies[1].continuation.goalId, 'candidate-goal');
assert.equal(candidateContinuationBodies[1].continuation.expectedGroupVersion, 1);
console.log('Group Draft continuation: Center-owned candidate membership survives a one-member plan subset');

// A retry handle belongs only to the failed Goal that created it. Selecting a
// different persisted Draft with the same text must bind the next message to
// the selected Draft, never to that stale retry handle.
button('＋ 新建目标').props.onClick();
const selectedBindingBodies = [];
desktopApi.groupStudio.message = async ({ body }) => {
  selectedBindingBodies.push(body);
  if (selectedBindingBodies.length === 1) return { groupIpcError: 'model_request_failed', groupIpcContext: {
    goal: { goalId: 'failed-goal-a', revision: 1 }, groupVersion: { groupId: 'failed-group-a', version: 1 },
  } };
  return { ok: true, goal: { goalId: 'draft-goal-b', revision: 2 }, groupVersion: { groupId: 'draft-group-b', version: 2, members: [{ employeeId: 'a', employeeVersion: 'v1' }] }, planDraft: { planId: 'draft-plan-b2', steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'b-step', dependsOn: [] }] } };
};
composer().props.onChange({ target: { value: 'Shared correction text' } });
await button('生成测试草案').props.onClick();
const draftB = { goal: { goalId: 'draft-goal-b', revision: 1 }, groupVersion: { groupId: 'draft-group-b', version: 1, members: [{ employeeId: 'a', employeeVersion: 'v1' }] }, draft: { planId: 'draft-plan-b1', inputRefs: [], steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'b-step', dependsOn: [] }] }, plan: { steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'b-step', dependsOn: [] }] } };
desktopApi.groupStudio.history = async () => ({ ok: true, items: [{ goalId: 'draft-goal-b', title: 'Shared correction text', objective: 'Shared correction text', status: 'draft', planning: { goal: draftB.goal, groupVersion: draftB.groupVersion, planDraft: draftB.draft } }] });
await history().props.onRefresh();
history().props.onSelect(history().props.items.find(item => item.goalId === 'draft-goal-b'));
composer().props.onChange({ target: { value: 'Shared correction text' } });
await button('生成测试草案').props.onClick();
assert.equal(selectedBindingBodies[1].continuation.goalId, 'draft-goal-b', 'selected Draft B is the only continuation authority after failed A');
assert.equal(selectedBindingBodies[1].continuation.expectedGoalRevision, 1);
assert.equal(selectedBindingBodies[1].continuation.retry, undefined, 'a Draft revision is not converted into failed-A retry');

// Refreshing the currently selected Goal must advance the submission anchor to
// the latest persisted revision instead of retaining the selection-time state.
button('＋ 新建目标').props.onClick();
history().props.onSelect(history().props.items.find(item => item.goalId === 'draft-goal-b'));
desktopApi.groupStudio.history = async () => ({ ok: true, items: [{ goalId: 'draft-goal-b', title: 'Draft B', status: 'draft', planning: {
  goal: { goalId: 'draft-goal-b', revision: 2 },
  groupVersion: { groupId: 'draft-group-b', version: 2, members: [{ employeeId: 'a', employeeVersion: 'v1' }] },
  planDraft: { planId: 'draft-plan-b2', inputRefs: [], steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'b-step', dependsOn: [] }] },
} }] });
await history().props.onRefresh();
let refreshedBindingBody;
desktopApi.groupStudio.message = async ({ body }) => { refreshedBindingBody = body; return { ok: true, goal: { goalId: 'draft-goal-b', revision: 3 }, groupVersion: { groupId: 'draft-group-b', version: 3, members: [{ employeeId: 'a', employeeVersion: 'v1' }] }, planDraft: { planId: 'draft-plan-b3', steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'b-step', dependsOn: [] }] } }; };
composer().props.onChange({ target: { value: 'Revision two correction' } });
await button('生成测试草案').props.onClick();
assert.equal(refreshedBindingBody.continuation.goalId, 'draft-goal-b');
assert.equal(refreshedBindingBody.continuation.expectedGoalRevision, 2, 'history refresh updates the selected submission anchor');

button('＋ 新建目标').props.onClick();
history().props.onSelect(history().props.items.find(item => item.goalId === 'draft-goal-b'));
let finishSelectedPlanning, selectedCancelBody, selectedSendBody;
desktopApi.groupStudio.message = ({ body }) => { selectedSendBody = body; return new Promise(resolve => { finishSelectedPlanning = () => resolve({ groupIpcError: 'agent_turn_canceled', groupIpcContext: { goal: { goalId: 'draft-goal-b', revision: body.continuation.expectedGoalRevision + 1 }, groupVersion: { groupId: 'draft-group-b', version: body.continuation.expectedGroupVersion + 1 } } }); }); };
desktopApi.groupStudio.cancelPlanning = async ({ body }) => { selectedCancelBody = body; return { ok: true, cancellation: 'canceled', goalId: 'draft-goal-b', goalRevision: 1 }; };
composer().props.onChange({ target: { value: 'Stop Draft B correction' } });
const selectedPlanning = button('生成测试草案').props.onClick();
await new Promise(resolve => setImmediate(resolve));
await field('停止 Group').props.onClick();
finishSelectedPlanning(); await selectedPlanning;
assert.equal(selectedCancelBody.goalId, 'draft-goal-b');
assert.equal(selectedCancelBody.goalRevision, selectedSendBody.continuation.expectedGoalRevision + 1, 'stop targets the planning revision derived from the same selected Draft as send');

const persistedFailure = { key: 'failed-goal-c', goalId: 'failed-goal-c', status: 'failed', planning: {
  goal: { goalId: 'failed-goal-c', revision: 4, planningContext: { clientRequestId: 'persisted-request-c', groupId: 'failed-group-c', groupVersion: 4 } },
  groupVersion: { groupId: 'failed-group-c', version: 4 }, planDraft: null,
} };
const persistedRetryBodies = [];
desktopApi.groupStudio.message = async ({ body }) => { persistedRetryBodies.push(body); return { groupIpcError: 'model_request_failed', groupIpcContext: { goal: { goalId: 'failed-goal-c', revision: 4 }, groupVersion: { groupId: 'failed-group-c', version: 4 } } }; };
desktopApi.groupStudio.history = async () => ({ ok: true, items: [persistedFailure, { goalId: 'draft-goal-b', title: 'Draft B', status: 'draft', planning: {
  goal: draftB.goal, groupVersion: draftB.groupVersion, planDraft: draftB.draft,
} }] });
await history().props.onRefresh();
for (let attempt = 0; attempt < 2; attempt += 1) {
  history().props.onSelect(history().props.items.find(item => item.goalId === 'failed-goal-c'));
  await button('重试').props.onClick();
  if (attempt === 0) {
    history().props.onSelect(history().props.items.find(item => item.goalId === 'draft-goal-b'));
    await history().props.onRefresh();
  }
}
assert.deepEqual(persistedRetryBodies.map(body => body.idempotencyKey), ['persisted-request-c', 'persisted-request-c'], 'reselecting one failed Goal preserves its server-owned retry idempotency key');
for (const body of persistedRetryBodies) {
  assert.deepEqual(Object.keys(body).sort(), ['continuation', 'idempotencyKey'], 'persisted retry sends only the canonical continuation and original request key');
  assert.equal(body.continuation.goalId, 'failed-goal-c');
  assert.equal(body.continuation.retry, true);
}
composer().props.onChange({ target: { value: 'Correct the invalid recovered plan' } });
await button('生成测试草案').props.onClick();
const correctedHistoryBody = persistedRetryBodies.at(-1);
assert.equal(correctedHistoryBody.objective, 'Correct the invalid recovered plan', 'typed follow-up is not swallowed by a restored retry handle');
assert.equal(correctedHistoryBody.continuation.goalId, 'failed-goal-c');
assert.equal(correctedHistoryBody.continuation.expectedGoalRevision, 4);
assert.equal(correctedHistoryBody.continuation.retry, undefined, 'send requests an explicit new planning revision');
assert.notEqual(correctedHistoryBody.idempotencyKey, 'persisted-request-c');
assert.equal(composer().props.value, 'Correct the invalid recovered plan');
console.log('Restored failed planning: explicit retry restores the old request; typed correction enters the same-Goal revision path');

// A transport failure may not include newer Center context. The failed card
// must keep the selected Draft revision as non-adoptable planning context so
// the original request can be retried against Center's revision check.
button('＋ 新建目标').props.onClick();
const networkDraft = { goal: { goalId: 'network-goal-d', revision: 3 }, groupVersion: { groupId: 'network-group-d', version: 3, members: [{ employeeId: 'a', employeeVersion: 'v1' }] }, draft: { planId: 'network-plan-d3', inputRefs: [], steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'd-step', dependsOn: [] }] }, plan: { steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'd-step', dependsOn: [] }] } };
desktopApi.groupStudio.history = async () => ({ ok: true, items: [{ goalId: 'network-goal-d', title: 'Network retry', objective: 'Network retry', status: 'draft', planning: {
  goal: networkDraft.goal, groupVersion: networkDraft.groupVersion, planDraft: networkDraft.draft,
} }] });
await history().props.onRefresh();
history().props.onSelect(history().props.items.find(item => item.goalId === 'network-goal-d'));
const networkRetryBodies = [];
desktopApi.groupStudio.message = async ({ body }) => {
  networkRetryBodies.push(body);
  if (networkRetryBodies.length === 1) throw new Error('fixture-network-failure');
  return { ok: true, goal: { goalId: 'network-goal-d', revision: 4 }, groupVersion: { groupId: 'network-group-d', version: 4, members: [{ employeeId: 'a', employeeVersion: 'v1' }] }, planDraft: { planId: 'network-plan-d4', steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'd-step', dependsOn: [] }] } };
};
composer().props.onChange({ target: { value: 'Network retry correction' } });
await button('生成测试草案').props.onClick();
const networkFailure = history().props.items.find(item => item.goalId === 'network-goal-d');
assert.equal(networkFailure.review, null, 'a failed continuation cannot leave its old Draft adoptable');
assert.equal(networkFailure.planning.goal.revision, 3, 'a context-free transport error retains the selected persisted revision');
await button('重试').props.onClick();
assert.equal(networkRetryBodies[1].continuation.goalId, 'network-goal-d');
assert.equal(networkRetryBodies[1].continuation.expectedGoalRevision, 3);
assert.equal(networkRetryBodies[1].continuation.retry, true);
assert.equal(networkRetryBodies[1].idempotencyKey, networkRetryBodies[0].idempotencyKey, 'context-free retry retains the original frozen operation');

button('＋ 新建目标').props.onClick();
const newerContextBodies = [];
desktopApi.groupStudio.message = async () => ({ ok: true,
  goal: { goalId: 'newer-context-goal', revision: 5 }, groupVersion: { groupId: 'newer-context-group', version: 5, members: [{ employeeId: 'a', employeeVersion: 'v1' }] },
  planDraft: { planId: 'newer-context-plan', steps: [{ employeeId: 'a', employeeVersion: 'v1', stepId: 'e-step', dependsOn: [] }] },
});
composer().props.onChange({ target: { value: 'Create newer context Draft' } });
await button('生成测试草案').props.onClick();
desktopApi.groupStudio.message = async ({ body }) => {
  newerContextBodies.push(body);
  return { groupIpcError: 'model_request_failed', groupIpcContext: {
    goal: { goalId: 'newer-context-goal', revision: 6 }, groupVersion: { groupId: 'newer-context-group', version: 6 },
  } };
};
composer().props.onChange({ target: { value: 'Use newer safe context' } });
await button('生成测试草案').props.onClick();
let newerContextFailure = history().props.items.find(item => item.goalId === 'newer-context-goal');
assert.equal(newerContextFailure.review, null);
assert.equal(newerContextFailure.planning.goal.revision, 6, 'Center safe error context replaces the old Draft revision');
await button('重试').props.onClick();
assert.equal(newerContextBodies[1].continuation.expectedGoalRevision, 6);
assert.equal(newerContextBodies[1].idempotencyKey, newerContextBodies[0].idempotencyKey, 'newer safe context keeps the original planning operation');

desktopApi.groupStudio.history = async () => ({ ok: true, items: [] });
await history().props.onRefresh();
let disappearedSelectionRequests = 0;
desktopApi.groupStudio.message = async () => { disappearedSelectionRequests++; throw new Error('must-not-send'); };
composer().props.onChange({ target: { value: 'Must not create after selected history disappears' } });
await button('生成测试草案').props.onClick();
assert.equal(disappearedSelectionRequests, 0, 'a refresh that removes the selected card cannot fall back to implicit Goal creation');

console.log('Group selected-history binding: failed-A retry isolation and refreshed Draft-B revision passed');

// Planner-authored review steps do not require an explicitly configured Reviewer
// Group. Rework is a new planning request, never a stop action on the old Run.
const rejectedRun = {
  key: 'rejected-run', runId: 'rejected-run', goalId: 'rejected-goal', title: 'Rejected checklist',
  goalRevision: 1, groupId: 'rejected-group', groupVersion: 1, status: 'blocked',
  projection: { ...projection, runId: 'rejected-run', status: 'blocked', reviewerGroup: null,
    steps: [{ stepId: 'review', errorCode: 'group_review_rejected', status: 'failed' }] },
};
for (const interaction of ['button', 'enter', 'network']) {
  button('＋ 新建目标').props.onClick();
  desktopApi.groupStudio.history = async () => ({ ok: true, items: [rejectedRun] });
  await history().props.onRefresh();
  history().props.onSelect(history().props.items.find(item => item.runId === rejectedRun.runId));
  const reworkBodies = [];
  let runStops = 0;
  desktopApi.groupStudio.cancel = async () => { runStops++; throw new Error('must-not-stop-rejected-run'); };
  desktopApi.groupStudio.message = async ({ body }) => {
    reworkBodies.push(body);
    if (interaction === 'network') throw new Error('fixture-transport-failure');
    return { groupIpcError: 'group_rework_source_invalid' };
  };
  assert.ok(field('停止 Group'), 'the old Run has a separate explicit stop mode');
  button('发起返工').props.onClick();
  assert.equal(field('停止 Group'), undefined, 'explicit rework switches the composer action from stop to send');
  composer().props.onChange({ target: { value: 'Use only the synthetic facts and review again' } });
  if (interaction !== 'enter') await button('生成测试草案').props.onClick();
  else {
    composer().props.onKeyDown({ key: 'Enter', preventDefault() {}, repeat: false });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(runStops, 0, `${interaction} must never cancel the retained rejected Run`);
  assert.equal(reworkBodies.length, 1);
  assert.equal(reworkBodies[0].continuation.reworkRunId, rejectedRun.runId);
  assert.equal(history().props.selectedKey, rejectedRun.runId, 'a context-free rejected rework keeps the original Run selected');
  assert.equal(history().props.items.filter(item => item.goalId === rejectedRun.goalId).length, 1, 'a rejected request cannot manufacture a failed Goal history entry');
  assert.equal(history().props.items.find(item => item.runId === rejectedRun.runId).projection.steps[0].errorCode, 'group_review_rejected');
  assert.equal(composer().props.value, 'Use only the synthetic facts and review again');
  assert.equal(composer().props.disabled, false, 'the correction and original rejected-source context remain available');
  assert.equal(field('停止 Group'), undefined, 'a failed rework retains the explicit send intent');
  await button('生成测试草案').props.onClick();
  assert.equal(reworkBodies[1].idempotencyKey, reworkBodies[0].idempotencyKey, 'explicit retry keeps the original request identity');
  assert.equal(reworkBodies[1].continuation.reworkRunId, rejectedRun.runId);
  assert.equal(reworkBodies[1].continuation.retry, undefined, 'rework retry cannot become an ordinary planner retry');
  button('取消返工').props.onClick();
  assert.ok(field('停止 Group'), 'leaving rework restores the explicit stop control');
  composer().props.onKeyDown({ key: 'Enter', preventDefault() {}, repeat: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reworkBodies.length, 2, 'a disabled Run composer cannot send through Enter');
  assert.equal(runStops, 0, 'Enter never implicitly stops a Run');
}

// A safe newer context proves Center reserved the planning revision; preserve
// that failed revision for ordinary retry and retain the original Run beside it.
button('＋ 新建目标').props.onClick();
await history().props.onRefresh();
history().props.onSelect(history().props.items.find(item => item.runId === rejectedRun.runId));
button('发起返工').props.onClick();
desktopApi.groupStudio.message = async () => ({ groupIpcError: 'model_request_failed', groupIpcContext: {
  goal: { goalId: rejectedRun.goalId, revision: 2 }, groupVersion: { groupId: rejectedRun.groupId, version: 2 },
} });
composer().props.onChange({ target: { value: 'Correction reserved by Center' } });
await button('生成测试草案').props.onClick();
assert.equal(history().props.selectedKey, rejectedRun.goalId);
assert.equal(history().props.items.find(item => item.key === rejectedRun.goalId).planning.goal.revision, 2);
assert.equal(history().props.items.filter(item => item.runId === rejectedRun.runId).length, 1);
assert.equal(history().props.items.find(item => item.runId === rejectedRun.runId).projection.steps[0].errorCode, 'group_review_rejected');
let reservedRetryBody;
desktopApi.groupStudio.message = async ({ body }) => {
  reservedRetryBody = body;
  return { ok: true, goal: { goalId: rejectedRun.goalId, revision: 3 },
    groupVersion: { groupId: rejectedRun.groupId, version: 3, members: [{ employeeId: 'a', employeeVersion: 'v1' }] },
    planDraft: { planId: 'rework-draft-3', steps: [{ stepId: 'rework-step', employeeId: 'a', dependsOn: [] }] } };
};
await button('重试').props.onClick();
assert.equal(reservedRetryBody.continuation.expectedGoalRevision, 2);
assert.equal(reservedRetryBody.continuation.expectedGroupVersion, 2);
assert.equal(reservedRetryBody.continuation.retry, true);
assert.equal(reservedRetryBody.continuation.reworkRunId, undefined, 'reserved revision retry cannot resubmit the old rejected Run');
assert.equal(history().props.items.find(item => item.key === rejectedRun.goalId).review.goal.revision, 3);
assert.equal(history().props.items.filter(item => item.runId === rejectedRun.runId).length, 1);
console.log('Group rework composer: click/Enter send parity, no implicit stop, original Run retention and safe newer failure context passed');

// Workbench selection reuses the employee conversation slot, never Group planning.
slots.length = 0;
let planned = 0, openedSheet = 0;
const selected = [];
conversationProps = {
  employeeConversationState: { employeeId: 'b', draftText: 'unsent direct draft', locked: false },
  onSelectEmployeeConversation: value => { selected.push(value); return true; },
  onOpenEmployeeConversation: () => { openedSheet++; return true; },
  renderEmployeeConversation: ({ employeeId, taskId, assignmentControl, view, onOpenChat }) => ({ type: 'employee-conversation', props: { employeeId, taskId, view, onOpenChat, children: assignmentControl } }),
};
desktopApi = { groupStudio: { history: async () => ({ ok: true, items: [] }), message: async () => { planned++; return {}; } } };
render(); effects.find(fn => fn.toString().includes('void refreshHistory()'))();
await new Promise(resolve => setImmediate(resolve));
for (const objective of ['Read test configuration', 'Please inspect the selected baseline']) {
  composer().props.onChange({ target: { value: objective } });
  assignment().props.onChoose('b');
  assert.equal(selected.at(-1).text, objective);
  assert.equal(render().find(n => n.type === 'employee-conversation').props.employeeId, 'b');
  assert.equal(render().find(n => n.type === 'employee-conversation').props.view, 'feed', 'explicit selection starts on information flow');
  assert(render().some(n => n.props['aria-label'] === '自由协作网络'), 'single employee keeps the shared Group canvas');
  assert.equal(render().filter(n => n.props.className?.split(' ').includes('group-node')).length, 1, 'selected employee is the single Group node');
  assert(render().some(n => n.type === 'employee-conversation' && n.props.view === 'composer'), 'direct route reuses its canonical composer');
  render().find(n => n.type === 'employee-conversation').props.onOpenChat();
  assert.equal(render().find(n => n.type === 'employee-conversation').props.view, 'chat');
  conversationProps.employeeConversationState.pendingCardIds = [`card-${objective}`];
  render(); effects.find(fn => fn.toString().includes('seenParameterCardsRef'))();
  assert.equal(render().find(n => n.type === 'employee-conversation').props.view, 'feed', 'new parameter card surfaces on feed without searching chat');
  assert.equal(openedSheet, 0, 'capsule stays in the main workbench');
  assert.equal(render().some(n => n.props['aria-label'] === '生成项目组规划草案'), false);
  assert.equal(planned, 0);
  conversationProps.employeeConversationState.locked = true;
  assignment().props.onChoose(null);
  assert(render().some(n => n.type === 'employee-conversation'), 'unresolved material selection cannot switch authority');
  conversationProps.employeeConversationState.locked = false;
  conversationProps.employeeConversationState.busy = true;
  assert.equal(assignment().props.locked, false, 'background employee execution does not lock browsing');
  assignment().props.onChoose('a');
  assert.equal(render().find(n => n.type === 'employee-conversation').props.employeeId, 'a', 'another employee can be viewed while the original runs');
  assert.equal(planned, 0, 'browsing another employee does not invoke Planner');
  assignment().props.onChoose('b');
  assignment().props.onChoose(null);
  conversationProps.employeeConversationState.busy = false;
  assert.equal(composer().props.value, 'unsent direct draft', 'returning to auto retains draft');
}
assert.equal(planned,0,'selecting an employee makes no Planner request');
await button('发送聊天消息').props.onClick();
assert.equal(planned,1,'automatic assignment preserves the canonical Group planning path');
console.log('Group inline employee routing tests passed');

// Canonical single-employee history remains inspectable while work continues.
slots.length = 0;
const taskA = { id: 'single-a', employeeId: 'a', employeeName: 'a', taskTitle: 'Inspect A', status: 'completed', sourceSystemId: 'desktop-device-channel', taskType: 'digital_employee_chat', submittedAt: '2026-10-07T12:00:00Z' };
const taskB = { ...taskA, id: 'single-b', employeeId: 'b', taskTitle: 'Inspect B', status: 'running' };
conversationProps.myTasks = { page: { tasks: [taskA, taskB] }, refresh: async () => {} };
desktopApi.groupStudio.history = async () => ({ ok: true, items: [{ goalId: 'auto-a', title: 'Auto A', status: 'draft' }] });
render(); effects.find(fn => fn.toString().includes('void refreshHistory()'))();
await new Promise(resolve => setImmediate(resolve));
assert.equal(history().props.items.filter(item => item.kind === 'employee').length, 2);
const plannerBeforeHistory = planned;
history().props.onSelect(history().props.items.find(item => item.taskId === taskA.id));
assert.equal(history().props.selectedKey, 'employee-task:single-a');
assert.equal(render().some(n => n.type === 'employee-activity'), false, 'history restores feed rather than activity');
assert.equal(render().find(n => n.type === 'employee-conversation' && n.props.view === 'feed').props.employeeId, 'a');
assert.equal(render().find(n => n.type === 'employee-conversation' && n.props.view === 'feed').props.taskId, 'single-a');
render().find(n => n.type === 'button' && n.props.children?.[1] === '活动').props.onClick();
assert.equal(render().find(n => n.type === 'employee-activity').props.taskId, 'single-a', 'activity opens only on explicit navigation');
assert.notEqual(button('活动').props.disabled, true);
render().find(n => n.type === 'employee-activity').props.onOpenChat();
assert.equal(render().find(n => n.type === 'employee-conversation').props.view, 'chat');
history().props.onSelect(history().props.items.find(item => item.taskId === taskB.id));
assert.equal(render().find(n => n.type === 'employee-conversation' && n.props.view === 'feed').props.taskId, 'single-b');
assert.equal(render().some(n => n.type === 'employee-activity'), false);
assert.equal(planned, plannerBeforeHistory, 'history selection cannot dispatch or plan');
render().find(n => n.type === 'button' && n.props.children?.[1] === '信息流').props.onClick();
assert.equal(render().find(n => n.type === 'employee-conversation' && n.props.view === 'progress').props.taskId, 'single-b', 'selected historical task ID reaches progress slot');
assert.equal(render().find(n => n.type === 'employee-conversation' && n.props.view === 'feed').props.taskId, 'single-b', 'selected historical task ID reaches confirmation slot');
conversationProps.employeeConversationState = { ...conversationProps.employeeConversationState, employeeId: 'b', busy: true, taskId: 'new-live-task' };
render(); effects.find(fn => fn.toString().includes('employeeConversationState.busy'))();
assert.equal(render().find(n => n.type === 'employee-conversation' && n.props.view === 'progress').props.taskId, 'new-live-task', 'new busy task uses its exact task ID after old selection clears');
conversationProps.employeeConversationState.busy = false;

history().props.onSelect(history().props.items.find(item => item.goalId === 'auto-a'));
assert.equal(render().some(n => n.type === 'employee-activity'), false, 'automatic Group history uses its existing projection');
history().props.onOpenTaskSet({key:'work-history:single-a',source:history().props.items.find(item => item.taskId === taskA.id)});
assert.equal(render().find(n => n.type === 'employee-conversation' && n.props.view === 'feed').props.taskId, 'single-a', 'aggregate restores its source task feed');
assert.equal(render().some(n => n.type === 'employee-activity'), false, 'aggregate does not force activity');
conversationProps.employeeConversationState = { ...conversationProps.employeeConversationState, employeeId:'a', busy:true, taskId:'new-after-aggregate' };
render(); effects.find(fn => fn.toString().includes('employeeConversationState.busy'))();
render().find(n => n.type === 'button' && n.props.children?.[1] === '活动').props.onClick();
assert.equal(render().find(n => n.type === 'employee-activity').props.taskIds, null, 'new task clears old aggregate view scope');
console.log('Unified history restores exact feed; explicit activity, aggregate entry and new-task scope reset tests passed');
