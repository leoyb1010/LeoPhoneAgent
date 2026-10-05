import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { extract, transform } from '../scripts/localization-engine.mjs';
import { applyStructuralPatches, orderedStructuralCatalogs } from '../scripts/structural-patches.mjs';

// Run with PAPERCLIP_SOURCE=/path/to/pinned/paperclip npm test. The checkout
// may already contain the overlay: only committed HEAD blobs are used below.
// Everything is rebuilt in memory; this test never changes the upstream tree.
const home = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = process.env.PAPERCLIP_SOURCE;
const scheduleFile = 'ui/src/components/ScheduleEditor.tsx';
const wizardFile = 'ui/src/components/routine-triggers/TriggerWizard.tsx';
const readJson = file => JSON.parse(fs.readFileSync(path.join(home, file), 'utf8'));

function parse(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(ast.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], `Invalid AST: ${file}`);
  return ast;
}

function findNodes(ast, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

function only(nodes, description) {
  assert.equal(nodes.length, 1, `Expected exactly one ${description}`);
  return nodes[0];
}

function compile(source, names, bindings = {}) {
  const result = ts.transpileModule(source, {
    fileName: 'schedule-test.tsx',
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      jsxFactory: 'h',
    },
  });
  assert.deepEqual((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
  return new Function(...Object.keys(bindings), `"use strict";\n${result.outputText}\nreturn { ${names.join(', ')} };`)(...Object.values(bindings));
}

function loadDeclarations(source, file, names) {
  const ast = parse(source, file);
  const declarations = names.map(name => only(ast.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && node.name?.text === name)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name)),
  ), `${name} declaration in ${file}`));
  const selected = [...new Set(declarations)].sort((a, b) => a.pos - b.pos);
  return compile(selected.map(node => node.getText(ast).replace(/^export\s+/, '')).join('\n'), names);
}

function rebuildOverlay(root) {
  const catalogFiles = fs.readdirSync(path.join(home, 'catalogs'));
  const catalog = {};
  for (const file of catalogFiles.filter(f => f.endsWith('.zh-CN.json')).sort()) {
    for (const [en, zh] of Object.entries(readJson(`catalogs/${file}`))) {
      assert.ok(en.trim() && typeof zh === 'string' && zh.trim(), `Invalid catalog entry: ${file}: ${en}`);
      if (Object.hasOwn(catalog, en)) assert.equal(zh, catalog[en], `Catalog conflict: ${en}`);
      catalog[en] = zh;
    }
  }
  // Match localize.mjs ordering and context/preserve handling, including every
  // structural catalog rather than a copied subset of scheduling replacements.
  // 1.1.6：与 localize.mjs 相同，按 catalogs/order.json 的显式顺序加载。
  const patches = orderedStructuralCatalogs(path.join(home, 'catalogs'))
    .flatMap(file => readJson(`catalogs/${file}`).map(patch => ({ ...patch, catalogFile: file })));
  assert.ok(patches.some(p => p.catalogFile === 'workflows-skills.structural.json'));
  const contexts = readJson('catalogs/contexts.json');
  const preserveFile = path.join(home, 'catalogs/preserve.json');
  const preserve = fs.existsSync(preserveFile) ? readJson('catalogs/preserve.json') : {};
  const originals = new Map();
  const changed = new Map();
  const report = { files: {}, structuralFiles: [] };
  let checkedPatchSites = 0;
  for (const file of new Set([scheduleFile, wizardFile, ...patches.map(p => p.file)])) {
    const source = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000 });
    originals.set(file, source);
    let input = source;
    for (const patch of patches.filter(p => p.file === file)) {
      assert.equal(typeof patch.from, 'string', `${patch.catalogFile}: missing from`);
      assert.ok(patch.from.length, `${patch.catalogFile}: empty from`);
      assert.equal(typeof patch.to, 'string', `${patch.catalogFile}: missing to`);
      const expected = patch.expected ?? 1;
      assert.ok(Number.isInteger(expected) && expected > 0, `${patch.catalogFile}: invalid expected`);
      assert.equal(input.split(patch.from).length - 1, expected,
        `${patch.catalogFile}: ${file}: exact structural context changed: ${patch.from}`);
      input = input.split(patch.from).join(patch.to);
      checkedPatchSites += expected;
    }
    const context = {
      ...Object.fromEntries(Object.entries(preserve).filter(([, entry]) => entry.files.includes(file)).map(([text]) => [text, text])),
      ...(contexts[file] ?? {}),
    };
    const result = transform(input, file, catalog, context);
    report.files[file] = {};
    changed.set(file, result.output);
  }
  applyStructuralPatches({ root, changed, report });
  for (const [file, output] of changed) if (/\.(?:ts|tsx)$/.test(file)) extract(output, file);
  return { originals, changed, checkedPatchSites, patchCount: patches.length };
}

const printer = ts.createPrinter({ removeComments: true });
const printed = (node, ast) => printer.printNode(ts.EmitHint.Unspecified, node, ast);
const declaration = (ast, name) => only(findNodes(ast, n =>
  (ts.isFunctionDeclaration(n) && n.name?.text === name)
  || (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name)), name);

function selectRenderer(source, file, id, displayRoutineWeekday) {
  const ast = parse(source, file);
  const select = only(findNodes(ast, n => ts.isJsxElement(n)
    && n.openingElement.tagName.getText(ast) === 'select'
    && n.openingElement.attributes.properties.some(a => ts.isJsxAttribute(a)
      && a.name.getText(ast) === 'id' && a.initializer?.text === id)), `select#${id}`);
  // Execute the real native-select JSX with a tiny element factory. No React,
  // browser, locale, server, or upstream node_modules are needed for this test.
  const h = (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat(Infinity) });
  return compile(`const render = (draft, patch) => (${select.getText(ast)});`, ['render'], {
    h, selectClass: '', displayRoutineWeekday,
  }).render;
}

function nativeOptions(select) {
  return select.children.map(option => {
    assert.equal(option.tag, 'option');
    const label = option.children.join('');
    // Native options without a value submit their text. The weekday translation
    // must introduce an explicit original value before changing that text.
    return { value: Object.hasOwn(option.props, 'value') ? option.props.value : label, label };
  });
}

test('workflow schedules remain equivalent on the pinned upstream source', {
  skip: sourcePath ? false : 'Set PAPERCLIP_SOURCE to a checkout at upstream.lock.json to run the upstream regression',
}, async t => {
  const root = fs.realpathSync(path.resolve(sourcePath));
  const lock = readJson('upstream.lock.json');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(head, lock.commit, 'PAPERCLIP_SOURCE must match upstream.lock.json; refusing a different upstream revision');
  const { originals, changed, checkedPatchSites, patchCount } = rebuildOverlay(root);
  t.diagnostic(`Verified ${patchCount} structural rules (${checkedPatchSites} exact sites) and generated TypeScript ASTs from ${head}`);
  const scheduleNames = ['PRESETS', 'HOURS', 'MINUTES', 'DAYS_OF_WEEK', 'DAYS_OF_MONTH', 'hasOption', 'parseCronToPreset', 'buildCron', 'describeSchedule', 'ordinalSuffix'];
  const en = loadDeclarations(originals.get(scheduleFile), scheduleFile, scheduleNames);
  const zh = loadDeclarations(changed.get(scheduleFile), scheduleFile, [...scheduleNames, 'displayScheduleTime']);
  const wizardEn = loadDeclarations(originals.get(wizardFile), wizardFile, ['defaultTriggerDraft', 'describeSchedule']);
  const wizardZh = loadDeclarations(changed.get(wizardFile), wizardFile, ['defaultTriggerDraft', 'displayRoutineWeekday', 'describeSchedule']);
  const astEn = parse(originals.get(scheduleFile), scheduleFile);
  const astZh = parse(changed.get(scheduleFile), scheduleFile);

  await t.test('cron algorithms and selectable protocol values are unchanged', () => {
    for (const name of ['hasOption', 'parseCronToPreset', 'buildCron']) {
      assert.equal(printed(declaration(astZh, name), astZh), printed(declaration(astEn, name), astEn), name);
    }
    assert.deepEqual(zh.PRESETS.map(p => p.value), en.PRESETS.map(p => p.value));
    assert.deepEqual(zh.HOURS.map(h => [h.value, h.rawLabel]), en.HOURS.map(h => [h.value, h.label]));
    assert.deepEqual(zh.MINUTES, en.MINUTES);
    assert.deepEqual(zh.DAYS_OF_MONTH, en.DAYS_OF_MONTH);
    assert.deepEqual(zh.DAYS_OF_WEEK.map(d => d.value), ['1', '2', '3', '4', '5', '6', '0']);
    assert.deepEqual(zh.DAYS_OF_WEEK.map(d => d.value), en.DAYS_OF_WEEK.map(d => d.value));
  });

  await t.test('374,976 preset combinations preserve build, parse, and repeated edit round trips', st => {
    const presets = ['every_minute', 'every_hour', 'every_day', 'weekdays', 'weekly', 'monthly'];
    const build = (api, state) => api.buildCron(state.preset, state.hour, state.minute, state.dayOfWeek, state.dayOfMonth);
    let cases = 0;
    for (const preset of presets) for (let hour = 0; hour < 24; hour++) for (let minute = 0; minute < 60; minute += 5) {
      for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth++) {
        const input = { preset, hour: String(hour), minute: String(minute), dayOfWeek: String(dayOfWeek), dayOfMonth: String(dayOfMonth) };
        let expected = build(en, input);
        let actual = build(zh, input);
        assert.equal(actual, expected);
        for (let edit = 0; edit < 2; edit++) {
          const before = en.parseCronToPreset(expected);
          const after = zh.parseCronToPreset(actual);
          assert.deepEqual(after, before);
          assert.equal(build(en, before), expected);
          assert.equal(build(zh, after), actual);
          // Reopen and edit every form field, crossing hour/day/month boundaries.
          const values = {
            hour: String((Number(before.hour) + 13) % 24),
            minute: String((Number(before.minute) + 5) % 60),
            dayOfWeek: String((Number(before.dayOfWeek) + 1) % 7),
            dayOfMonth: String(Number(before.dayOfMonth) % 31 + 1),
          };
          expected = build(en, { ...before, ...values });
          actual = build(zh, { ...after, ...values });
          assert.equal(actual, expected);
        }
        assert.deepEqual(zh.parseCronToPreset(actual), en.parseCronToPreset(expected));
        assert.equal(build(zh, zh.parseCronToPreset(actual)), actual);
        cases++;
      }
    }
    assert.equal(cases, 374_976);
    st.diagnostic(`${cases.toLocaleString('en-US')} input combinations, each with two edit/reopen cycles`);
  });

  await t.test('midnight, noon, and all AM/PM raw labels produce Chinese display-only text', () => {
    for (let hour = 0; hour < 24; hour++) {
      const period = hour === 0 ? '凌晨' : hour < 12 ? '上午' : hour === 12 ? '中午' : '下午';
      const clockHour = hour % 12 || 12;
      assert.equal(zh.displayScheduleTime(zh.HOURS[hour].rawLabel), `${period} ${clockHour}`);
      assert.match(zh.HOURS[hour].rawLabel, / (AM|PM)$/);
      for (let minute = 0; minute < 60; minute++) {
        const mm = String(minute).padStart(2, '0');
        const raw = `${clockHour}:${mm} ${hour < 12 ? 'AM' : 'PM'}`;
        assert.equal(zh.displayScheduleTime(raw), `${period} ${clockHour}:${mm}`);
        if (minute % 5 === 0) assert.equal(zh.describeSchedule(`${minute} ${hour} * * *`), `每天 ${period} ${clockHour}:${mm}`);
      }
    }
    assert.equal(zh.describeSchedule('0 0 * * *'), '每天 凌晨 12:00');
    assert.equal(zh.describeSchedule('0 12 * * *'), '每天 中午 12:00');
    assert.equal(zh.describeSchedule('5 13 * * *'), '每天 下午 1:05');
    assert.equal(zh.describeSchedule('0 10 * * 1'), '每周一 上午 10:00');
    assert.equal(zh.describeSchedule('0 10 21 * *'), '每月 21日 上午 10:00');
    assert.equal(zh.describeSchedule('* * * * *'), '每分钟');
    assert.equal(zh.describeSchedule('5 * * * *'), '每小时第 05 分钟');
    assert.equal(zh.describeSchedule('0 10 * * 1-5'), '工作日 上午 10:00');
  });

  await t.test('wizard weekday labels do not alter the saved draft or timezone', () => {
    assert.deepEqual(wizardZh.defaultTriggerDraft, wizardEn.defaultTriggerDraft);
    assert.equal(wizardZh.defaultTriggerDraft.timezone, 'America/Chicago');
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    for (const [index, weekday] of days.entries()) for (const time of ['00:00', '09:00', '12:00', '23:55']) {
      const draft = Object.freeze({ ...wizardZh.defaultTriggerDraft, frequency: 'weekly', weekday, time, timezone: 'Asia/Shanghai' });
      assert.equal(wizardZh.describeSchedule(draft), `每${labels[index]} ${time}`);
      assert.equal(wizardEn.describeSchedule(draft), `Every ${weekday} at ${time}`);
      assert.equal(draft.weekday, weekday);
      assert.equal(draft.timezone, 'Asia/Shanghai');
    }
    assert.equal(wizardZh.describeSchedule({ ...wizardZh.defaultTriggerDraft, frequency: 'daily' }), '每天 09:00');
    assert.equal(wizardZh.describeSchedule(wizardZh.defaultTriggerDraft), '每个工作日 09:00');
    assert.equal(wizardZh.displayRoutineWeekday('custom-weekday'), 'custom-weekday');
  });

  await t.test('native select values and change payloads retain English weekdays and IANA timezones', () => {
    for (const id of ['repeat', 'run-day', 'timezone']) {
      const renderEn = selectRenderer(originals.get(wizardFile), wizardFile, id);
      const renderZh = selectRenderer(changed.get(wizardFile), wizardFile, id, wizardZh.displayRoutineWeekday);
      for (const timezone of ['America/Chicago', 'Asia/Shanghai', 'Pacific/Chatham', 'UTC']) {
        const draft = Object.freeze({ ...wizardZh.defaultTriggerDraft, frequency: 'weekly', timezone });
        const changesEn = [];
        const changesZh = [];
        const before = renderEn(draft, change => changesEn.push(change));
        const after = renderZh(draft, change => changesZh.push(change));
        const optionsEn = nativeOptions(before);
        const optionsZh = nativeOptions(after);
        assert.deepEqual(optionsZh.map(o => o.value), optionsEn.map(o => o.value), `${id} values`);
        assert.equal(after.props.value, before.props.value, `${id} selected value`);
        for (const { value } of optionsZh) {
          before.props.onChange({ target: { value } });
          after.props.onChange({ target: { value } });
        }
        assert.deepEqual(changesZh, changesEn, `${id} change payloads`);
        if (id === 'timezone') assert.deepEqual(optionsZh, optionsEn);
        if (id === 'run-day') {
          assert.deepEqual(optionsZh.map(o => o.value), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
          assert.deepEqual(optionsZh.map(o => o.label), ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
          assert.ok(after.children.every(option => Object.hasOwn(option.props, 'value')), 'Localized native options require explicit original values');
        }
      }
    }
    const firesCall = ast => only(findNodes(ast, n => ts.isCallExpression(n) && n.expression.getText(ast) === 'nextCronFires'), 'nextCronFires call');
    assert.equal(printed(firesCall(astZh), astZh), printed(firesCall(astEn), astEn));
    assert.match(firesCall(astZh).getText(astZh), /timeZone: "UTC"/);
  });

  await t.test('custom cron input, parsing, and emitted values are never translated or normalized', () => {
    const custom = ['17 7 * * 2-4', '*/7 * * * *', '0 0 1,15 * *', '0 9 * JAN MON', '  17 7 * * 2-4  ', '0 0 * * * *', 'invalid cron'];
    const emitters = [astEn, astZh].map((ast, index) => {
      const emit = declaration(ast, 'emitChange').initializer;
      assert.ok(ts.isCallExpression(emit) && emit.expression.getText(ast) === 'useCallback');
      const values = [];
      const { emitChange } = compile(`const emitChange = ${emit.arguments[0].getText(ast)};`, ['emitChange'], {
        onChange: value => values.push(value), buildCron: index === 0 ? en.buildCron : zh.buildCron,
      });
      return { emitChange, values };
    });
    assert.equal(printed(declaration(astZh, 'emitChange'), astZh), printed(declaration(astEn, 'emitChange'), astEn));
    for (const cron of custom) {
      assert.equal(en.parseCronToPreset(cron).preset, 'custom');
      assert.deepEqual(zh.parseCronToPreset(cron), en.parseCronToPreset(cron));
      assert.equal(zh.describeSchedule(cron), cron);
      for (const { emitChange } of emitters) emitChange('custom', '0', '0', '0', '1', cron);
    }
    assert.deepEqual(emitters[0].values, custom);
    assert.deepEqual(emitters[1].values, custom);
    for (const cron of ['', ' ', '\n\t']) assert.deepEqual(zh.parseCronToPreset(cron), en.parseCronToPreset(cron));
    assert.equal(zh.buildCron('custom', '0', '0', '0', '1'), en.buildCron('custom', '0', '0', '0', '1'));
    const customChange = ast => {
      const input = only(findNodes(ast, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(ast) === 'Input'
        && n.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'value' && a.initializer?.getText(ast) === '{customCron}')), 'custom cron Input');
      return only(input.attributes.properties.filter(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'onChange'), 'custom cron onChange');
    };
    assert.equal(printed(customChange(astZh), astZh), printed(customChange(astEn), astEn));
  });
});
