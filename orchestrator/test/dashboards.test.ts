// The provisioned Grafana dashboards reference data sources and variables that exist.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../deploy/grafana/', import.meta.url);
const datasources = readFileSync(new URL('provisioning/datasources/datasources.yml', dir), 'utf8');
const uids = new Set([...datasources.matchAll(/^\s+uid: (\S+)$/gm)].map((m) => m[1]));
const dashboards = readdirSync(new URL('dashboards/', dir)).map((f) => ({ f, d: JSON.parse(readFileSync(new URL(`dashboards/${f}`, dir), 'utf8')) }));

describe('Grafana provisioning', () => {
  it('panels and targets use provisioned data sources; panel ids are unique', () => {
    for (const { f, d } of dashboards) {
      const ids = d.panels.map((p: any) => p.id);
      expect(new Set(ids).size, f).toBe(ids.length);
      for (const p of d.panels) {
        for (const ds of [p.datasource, ...(p.targets ?? []).map((t: any) => t.datasource)].filter(Boolean)) expect(uids, `${f}: ${p.title}`).toContain(ds.uid);
      }
    }
  });

  it('the instance drill-down filters its trace tables by computer, and errors through $calls', () => {
    const d = dashboards.find((x) => x.f === 'instance.json')!.d;
    expect(d.templating.list.find((v: any) => v.name === 'calls').options.map((o: any) => o.value)).toEqual(['*', '=2']);
    const expr = (title: string) => d.panels.find((p: any) => p.title.startsWith(title)).targets[0].expr as string;
    expect(expr('Tool calls on this computer')).toContain('"span_attr:ozwell.instance_id":="$instance_id" status_code:$calls');
    expect(expr('Commands run on this computer')).toContain('"resource_attr:ozwell.instance_id":="$instance_id" name:="exec"');
    for (const p of d.panels.filter((p: any) => p.datasource?.uid === 'victoriatraces-spans')) {
      const link = p.fieldConfig.overrides.find((o: any) => o.matcher.options === 'trace_id').properties.find((x: any) => x.id === 'links').value[0];
      expect(link.internal.datasourceUid).toBe('victoriatraces');
    }
  });
});
