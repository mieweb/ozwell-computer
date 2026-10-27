// EHR workload: an MCP agent working in WebChart (Enterprise Health) through Firefox,
// the way a model-driven agent would: a screenshot before each step, accessibility
// lookups to find controls, clicks at their on-screen positions, and typed input.
//
// Environment: OZ_WEBCHART_URL (default: the nightly), OZ_WEBCHART_USER, OZ_WEBCHART_PASS.

const DEFAULT_URL = 'https://masterdaily.dev.webchart.app/webchart.cgi';

export function ehrConfig() {
  const user = process.env.OZ_WEBCHART_USER;
  const pass = process.env.OZ_WEBCHART_PASS;
  if (!user || !pass) throw new Error('the ehr workload needs OZ_WEBCHART_USER and OZ_WEBCHART_PASS');
  return { base: process.env.OZ_WEBCHART_URL || DEFAULT_URL, user, pass };
}

/** Patients in the demo data, searched as "Last, First"; the first matching row is opened. */
const SEARCHES = ['Hart, William', 'Smith, Joe', 'Johnson, Esther'];
/** Sections of the chart's Medical Record menu to visit in turn. */
const SECTIONS = ['Encounters', 'Allergies/Medications', 'Vital Signs', 'Labs', 'Office Visits/Notes', 'Conditions'];
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {object} ctx
 * @param {(name: string, args?: object) => Promise<any>} ctx.call  MCP tool call (timed by the harness)
 * @param {{flag: boolean}} ctx.stop
 * @param {(where: string, e: unknown) => void} ctx.countError
 * @param {(ms: number) => Promise<void>} ctx.think  pause standing in for model latency
 * @param {(m: string) => void} ctx.log
 * @param {(name: string) => void} ctx.mark  count a completed step
 */
export async function ehrAgent(ctx, i) {
  const { call, stop, countError, think, log, mark } = ctx;
  const cfg = ehrConfig();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const json = (r) => { const t = r.content.find((c) => c.type === 'text')?.text; try { return JSON.parse(t); } catch { return t; } };

  const firefox = async () => json(await call('list_windows')).windows.filter((w) => /Mozilla Firefox/.test(w.title)).at(-1);
  const shot = () => call('screenshot', { max_dimension: 1280 });

  async function waitTitle(re, ms = 30000) {
    const end = Date.now() + ms;
    for (;;) {
      const w = await firefox();
      if (w && re.test(w.title)) return w;
      if (Date.now() > end) throw new Error(`timed out waiting for a page matching ${re} (at "${w?.title}")`);
      await sleep(500);
    }
  }

  /**
   * find_element, retried while Firefox catches up with the page; only on-screen matches.
   * `roles` (array) accepts any of several roles: sites expose the same control as a link,
   * menu item, page tab or button depending on markup.
   */
  async function find(q, { ms = 20000, min = 1 } = {}) {
    const { roles, prefix, below, ...query } = q;
    if (prefix && !query.name && !query.name_contains) query.name_contains = prefix;
    const w = await firefox();
    const end = Date.now() + ms;
    for (;;) {
      const r = json(await call('find_element', { window: w.id, max_results: 200, ...query }));
      const visible = (r.matches ?? []).filter((n) =>
        (!roles || roles.includes(n.role)) &&
        (!prefix || n.name.startsWith(prefix)) &&
        (!below || (n.bounds.y > below.bounds.y && Math.abs(n.bounds.x - below.bounds.x) < 250)) &&
        n.bounds && n.bounds.width > 0 && n.bounds.y > 0 && n.states.includes('showing'));
      if (visible.length >= min) return visible;
      if (Date.now() > end) throw new Error(`no on-screen element for ${JSON.stringify(q)}`);
      await sleep(1000);
    }
  }
  const LINKISH = ['link', 'menuitem', 'tab', 'button', 'listitem'];
  const clickEl = (n) => call('click', { x: Math.round(n.bounds.x + Math.min(n.bounds.width / 2, 40)), y: Math.round(n.bounds.y + n.bounds.height / 2) });
  const clickNamed = async (q) => clickEl((await find(q))[0]);
  /** Main navigation (E-Chart, Scheduler, Task List, ...) lives in the hamburger menu. */
  async function menu(item) {
    await clickNamed({ role: 'button', name: 'Toggle navigation menu' });
    await sleep(600);
    await clickNamed({ name: item, roles: LINKISH });
  }

  async function go(url, re) {
    await call('hotkey', { keys: ['ctrl', 'l'] });
    await call('type_text', { text: url });
    await call('press_key', { key: 'Enter' });
    return waitTitle(re);
  }

  async function scroll(w, dy) {
    await call('scroll', { x: w.bounds.x + Math.round(w.bounds.width / 2), y: w.bounds.y + Math.round(w.bounds.height / 2), dy });
  }

  async function step(name, fn) {
    if (stop.flag) return;
    await shot();
    await fn();
    mark(`ehr.${name}`);
    await think();
  }

  // ---- start Firefox with a fresh profile (logged out, empty cache) and log in
  const profile = `/tmp/oz-ehr-profile-${i}-${Date.now()}`;
  // '[f]irefox-esr' so pkill doesn't match (and kill) this shell's own command line
  await call('run_command', { command: "pkill -f '[f]irefox-esr' ; sleep 1; true" });
  await call('run_command', { command: `rm -rf /tmp/oz-ehr-profile-${i}-* && mkdir -p ${profile} && test -d ${profile}` });
  await sleep(1000);
  await call('launch_app', { command: 'firefox-esr', args: ['--no-remote', '--profile', profile, '--new-window', `${cfg.base}?func=omniscope`] });
  let w = await waitTitle(/Log In|OmniScope/, 60000);
  await call('double_click', { x: w.bounds.x + Math.round(w.bounds.width / 2), y: w.bounds.y - 12 }); // maximize via title bar
  await sleep(1500);
  if (!/OmniScope/.test((await firefox()).title)) {
    await step('login', async () => {
      await clickNamed({ role: 'button', name: 'Standard Login' });
      await clickNamed({ role: 'text_field', name: 'Username/Email' });
      await call('type_text', { text: cfg.user });
      await call('press_key', { key: 'Enter' });
      // The password step animates in; a click during the transition can miss focus. Retry.
      for (let attempt = 1; ; attempt++) {
        await sleep(800);
        await clickNamed({ role: 'text_field', name: 'Password' });
        await call('type_text', { text: cfg.pass });
        await call('press_key', { key: 'Enter' });
        try { await waitTitle(/OmniScope/, 10000); break; } catch (e) { if (attempt >= 3) throw e; }
      }
    });
  }
  log(`ehr agent ${i}: logged in`);

  let n = 0;
  while (!stop.flag) {
    n++;
    try {
      const who = SEARCHES[(n + i) % SEARCHES.length];

      await step('patient_search', async () => {
        await menu('E-Chart');
        await waitTitle(/Search/);
        // The page's own chart search: type a name, press its Search button, open a result row.
        const box = (await find({ role: 'text_field', name: 'Chart search' }))[0];
        await clickEl(box);
        await call('type_text', { text: who });
        const btn = (await find({ role: 'button', name: 'Search' }))
          .sort((a, b) => Math.hypot(a.bounds.x - box.bounds.x, a.bounds.y - box.bounds.y) - Math.hypot(b.bounds.x - box.bounds.x, b.bounds.y - box.bounds.y))[0];
        await clickEl(btn);
        await sleep(2500);
        const last = who.split(',')[0];
        const rows = await find({ name_contains: last, roles: ['link', 'cell'] }, { ms: 15000 })
          .then((ns) => ns.filter((n) => n.bounds.y > box.bounds.y + 20).sort((a, b) => a.bounds.y - b.bounds.y))
          .catch(() => []);
        if (rows.length) await clickEl(rows[0]);
        else await go(`${cfg.base}?f=chart&s=pat&pat_id=18`, /Summary/); // nobody by that name: known demo patient
        w = await waitTitle(/^Summary:/);
        // A non-patient record (e.g. a provider organization) has no Medical Record tab.
        if (!(await find({ prefix: 'Medical Record', roles: LINKISH }, { ms: 8000 }).catch(() => null))) {
          await go(`${cfg.base}?f=chart&s=pat&pat_id=18`, /Summary/);
          w = await waitTitle(/^Summary:/);
        }
      });

      await step('review_summary', async () => {
        await scroll(w, 5);
        await sleep(800);
        await scroll(w, -5);
      });

      // Medical Record is a dropdown of chart sections; rotate through common ones.
      const section = SECTIONS[n % SECTIONS.length];
      await step('medical_record', async () => {
        // The tab's accessible name includes its whole dropdown, so match on how names start,
        // and take the section link under the tab (not its "Open in a new window" twin).
        const tabEl = (await find({ prefix: 'Medical Record', roles: LINKISH }))[0];
        await clickEl(tabEl);
        await sleep(800);
        await clickNamed({ prefix: section, roles: ['link'], below: tabEl });
        await waitTitle(new RegExp(`^${escapeRe(section.split('/')[0])}`));
        await sleep(1500);
        await scroll(w, 4);
      });

      await step('documents', async () => {
        const before = (await firefox()).title;
        const tabEl = (await find({ prefix: 'Documents', roles: LINKISH }))[0];
        await clickEl(tabEl);
        await waitTitle(new RegExp(`^(?!${escapeRe(before)}$)`), 8000).catch(async () => {
          // a dropdown on some layouts: take its first section
          await clickNamed({ prefix: 'Documents', roles: ['link'], below: tabEl });
          await waitTitle(new RegExp(`^(?!${escapeRe(before)}$)`));
        });
        await sleep(1500);
        await scroll(w, 4);
      });

      await step('phone_note', async () => {
        await clickNamed({ prefix: 'Summary', roles: LINKISH }).catch(() => go(`${cfg.base}?f=chart&s=pat&pat_id=18`, /Summary/));
        await sleep(2000);
        await clickNamed({ name: 'Add Task', roles: LINKISH });
        await clickNamed({ name: 'Phone Note', roles: LINKISH });
        // Description, Subject and Notes are unnamed fields; take them top to bottom.
        const fields = (await find({ role: 'text_field', name: '' }, { min: 3 })).sort((a, b) => a.bounds.y - b.bounds.y);
        const notes = fields.find((f) => f.states.includes('multi_line')) ?? fields[2];
        await clickEl(fields[1]);
        await call('type_text', { text: `ozwell-desktop load test: callback request ${n}` });
        await clickEl(notes);
        await call('hotkey', { keys: ['ctrl', 'End'] });
        await call('type_text', { text: `\nAgent ${i} cycle ${n}: patient asked about lab results; advised follow-up. (automated load test)` });
        await clickNamed({ role: 'button', name: 'Add Task' });
        // Saved when the form is gone and the summary is back (a rejected form stays on screen).
        // The "Task added successfully" banner is page text, not a named control, so it isn't searchable.
        await waitTitle(/^Summary:/);
        const end = Date.now() + 20000;
        while ((await find({ role: 'text_field', name: '' }, { ms: 1 }).catch(() => [])).some((f) => f.states.includes('multi_line'))) {
          if (Date.now() > end) throw new Error('the Add Task form is still open after submitting');
          await sleep(1000);
        }
      });

      await step('scheduler', async () => {
        await menu('Scheduler');
        await waitTitle(/Scheduler/);
        await clickNamed({ prefix: 'Week View', roles: LINKISH }).catch(() => undefined);
        await sleep(2000);
        // Show a provider's week: pick the first entry in "Select a resource to add".
        // It's an unlabelled <select> (empty accessible name): the top-left one in the page toolbar.
        const res = await find({ role: 'combobox', name: '' }, { ms: 8000 })
          .then((ns) => ns.filter((n) => n.bounds.y > 150).sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x))
          .catch(() => []);
        if (res.length) {
          await clickEl(res[0]);
          await sleep(500);
          await call('press_key', { key: 'ArrowDown' });
          await call('press_key', { key: 'Enter' });
          await sleep(3000);
        }
      });

      await step('task_list', async () => {
        await menu('Task List');
        await waitTitle(/tasklist/i);
        await sleep(1500);
        await scroll(w, 5);
      });
    } catch (e) {
      countError(`ehr${i}`, e);
      // Recover to a known page so one failure doesn't derail the rest of the run.
      await go(`${cfg.base}?func=omniscope`, /OmniScope|Log In/).catch(() => undefined);
      await sleep(2000);
    }
  }
}

/**
 * The person watching. They share the X pointer with the agent, so they stay mostly still:
 * now and then a small move (as if reading), never scrolling or clicking.
 */
export async function ehrHuman(page, toPage, stop, countError, i) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (!stop.flag) {
    await sleep(20000 + Math.random() * 20000);
    if (stop.flag) break;
    try { await page.mouse.move(...toPage(0.85 + Math.random() * 0.1, 0.1 + Math.random() * 0.1), { steps: 5 }); } catch (e) { countError(`ehrHuman${i}`, e); }
  }
}
