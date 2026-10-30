// Launches the compiled server (dist/) over stdio, like an MCP host would, and checks one
// round trip. The vitest suite runs against the TypeScript sources; this covers the build.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const database = process.argv[2] ?? 'data/music-store.db';
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js', '--db', database] });
const client = new Client({ name: 'smoke-test', version: '1.0.0' });

await client.connect(transport);
try {
  const result = await client.callTool({
    name: 'run_query',
    arguments: { sql: 'SELECT genre, revenue FROM sales_by_genre ORDER BY revenue DESC LIMIT 3' },
  });
  if (result.isError || result.structuredContent?.rowCount !== 3) {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
  console.log(result.content[0].text);
  console.log('smoke test passed');
} finally {
  await client.close();
}
