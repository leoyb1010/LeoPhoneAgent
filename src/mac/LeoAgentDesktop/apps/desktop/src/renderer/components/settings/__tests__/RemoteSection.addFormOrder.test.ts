import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'RemoteSection.tsx'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('RemoteSection add form order', () => {
  it('keeps the add form before every existing host', () => {
    const cardStart = source.indexOf("className={cn('flex flex-col rounded-xl'");
    const addForm = source.indexOf('{adding && (', cardStart);
    const hostList = source.indexOf('{hosts.map(', cardStart);

    expect(cardStart).toBeGreaterThanOrEqual(0);
    expect(addForm).toBeGreaterThan(cardStart);
    expect(hostList).toBeGreaterThan(addForm);
    expect(source).toContain('idx > 0 || adding');
  });
});
