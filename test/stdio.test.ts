import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, describe, expect, it } from 'vitest';
import { demoDatabase, tempDir } from './helpers.js';

const dir = tempDir();
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

afterAll(() => dir.remove());

describe('stdio entry point', () => {
  it('serves the database to a client that launches it as a subprocess', async () => {
    const databasePath = demoDatabase(dir);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', entry, '--db', databasePath, '--default-rows', '3'],
      env: getDefaultEnvironment(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('mcp-sql-explorer');
      expect(client.getInstructions()).toContain('list_tables -> describe_table');

      const result = await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT name FROM genres' } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ rowCount: 3, truncated: true });
    } finally {
      await client.close();
    }
  });
});
