// docs/alerts.md describes every alert rule (deploy/grafana/provisioning/alerting/rules.yml).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rules = readFileSync(new URL('../deploy/grafana/provisioning/alerting/rules.yml', import.meta.url), 'utf8');
const doc = readFileSync(new URL('../../docs/alerts.md', import.meta.url), 'utf8');

const pairs = [...rules.matchAll(/^\s+- uid: (\S+)\n\s+title: (.+)$/gm)].map((m) => ({ uid: m[1], title: m[2].trim() }));

describe('docs/alerts.md', () => {
  it('has a section for every rule, with its uid', () => {
    expect(pairs.length).toBeGreaterThan(10);
    for (const { uid, title } of pairs) {
      expect(doc, title).toContain(`### ${title}\n\n\`${uid}\``);
      expect(doc, title).toContain(`| [${title}](`);
    }
  });

  it('describes no rule that no longer exists', () => {
    const sections = [...doc.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(sections.sort()).toEqual(pairs.map((p) => p.title).sort());
  });
});
