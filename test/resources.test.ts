import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, demoDatabase, type Harness, tempDir } from './helpers.js';

const dir = tempDir();
let harness: Harness;

beforeAll(async () => {
  harness = await connect(demoDatabase(dir));
});

afterAll(async () => {
  await harness?.close();
  dir.remove();
});

const textOf = (contents: ReadonlyArray<object>) => {
  const first = contents[0];
  return first && 'text' in first ? String(first.text) : '';
};

describe('resources', () => {
  it('lists the schema resource and one resource per table', async () => {
    const { resources } = await harness.client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris).toContain('sqlite://schema');
    expect(uris).toContain('sqlite://table/tracks');
    expect(uris).toContain('sqlite://table/sales_by_genre');
    expect(resources.find((resource) => resource.uri === 'sqlite://table/tracks')?.mimeType).toBe('application/json');
  });

  it('advertises the per-table resource template', async () => {
    const { resourceTemplates } = await harness.client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual(['sqlite://table/{name}']);
  });

  it('serves the full schema as SQL', async () => {
    const { contents } = await harness.client.readResource({ uri: 'sqlite://schema' });
    const ddl = textOf(contents);
    expect(contents[0]?.mimeType).toBe('application/sql');
    expect(ddl).toMatch(/-- table: tracks\nCREATE TABLE tracks/);
    expect(ddl).toContain('-- view: sales_by_genre');
    expect(ddl).toContain('-- index: idx_tracks_album');
    // Tables come before views, views before indexes.
    expect(ddl.indexOf('-- table:')).toBeLessThan(ddl.indexOf('-- view:'));
    expect(ddl.indexOf('-- view:')).toBeLessThan(ddl.indexOf('-- index:'));
  });

  it('serves one table as JSON in the describe_table shape', async () => {
    const { contents } = await harness.client.readResource({ uri: 'sqlite://table/albums' });
    const table = JSON.parse(textOf(contents));
    expect(table.name).toBe('albums');
    expect(table.primaryKey).toEqual(['album_id']);
    expect(table.foreignKeys.map((fk: { referencesTable: string }) => fk.referencesTable).sort()).toEqual([
      'artists',
      'genres',
    ]);
  });

  it('answers unknown tables with an invalid-params protocol error', async () => {
    await expect(harness.client.readResource({ uri: 'sqlite://table/missing' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('completes table names in the resource template', async () => {
    const result = await harness.client.complete({
      ref: { type: 'ref/resource', uri: 'sqlite://table/{name}' },
      argument: { name: 'name', value: 'inv' },
    });
    expect(result.completion.values).toEqual(['invoice_lines', 'invoices']);
  });
});

describe('analyse-table prompt', () => {
  it('is listed with its arguments', async () => {
    const { prompts } = await harness.client.listPrompts();
    const prompt = prompts.find((candidate) => candidate.name === 'analyse-table');
    expect(prompt).toBeDefined();
    expect(prompt?.arguments?.map((argument) => [argument.name, argument.required])).toEqual([
      ['table', true],
      ['focus', false],
    ]);
  });

  it('embeds the table schema and an analysis plan', async () => {
    const result = await harness.client.getPrompt({
      name: 'analyse-table',
      arguments: { table: 'invoices', focus: 'seasonality of revenue' },
    });
    expect(result.messages).toHaveLength(2);
    const [schema, instructions] = result.messages;
    expect(schema?.content).toMatchObject({
      type: 'resource',
      resource: { uri: 'sqlite://table/invoices', mimeType: 'application/json' },
    });
    const text = (instructions?.content as { text: string }).text;
    expect(text).toContain('Analyse the table "invoices"');
    expect(text).toContain('Concentrate on: seasonality of revenue');
    expect(text).toContain('referential integrity against customers');
  });

  it('rejects an unknown table', async () => {
    await expect(
      harness.client.getPrompt({ name: 'analyse-table', arguments: { table: 'missing' } }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('completes the table argument', async () => {
    const result = await harness.client.complete({
      ref: { type: 'ref/prompt', name: 'analyse-table' },
      argument: { name: 'table', value: 'a' },
    });
    expect(result.completion.values).toEqual(['albums', 'artists']);
  });
});
