import type { Cell, PlanStep, QueryResult } from './db/protocol.js';

/** Renders a result as a Markdown table, which models read more reliably than nested JSON. */
export function renderResultTable(result: QueryResult): string {
  const lines: string[] = [];
  if (result.columns.length > 0) {
    lines.push(`| ${result.columns.map(escapeCell).join(' | ')} |`);
    lines.push(`|${result.columns.map(() => ' --- ').join('|')}|`);
    for (const row of result.rows) {
      lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
    }
  }
  const footer = [`${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`, `${result.elapsedMs} ms`];
  if (result.truncated) {
    footer.push(
      result.truncatedReason === 'max_output_bytes'
        ? 'truncated: output size limit reached'
        : 'truncated: row limit reached (more rows exist)',
    );
  }
  lines.push('', `(${footer.join(', ')})`);
  return lines.join('\n');
}

function escapeCell(value: Cell): string {
  if (value === null) return 'NULL';
  return String(value).replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}

/** Renders EXPLAIN QUERY PLAN rows as the same tree the sqlite3 shell prints. */
export function renderPlanTree(steps: PlanStep[]): string {
  const children = new Map<number, PlanStep[]>();
  for (const step of steps) {
    const siblings = children.get(step.parent) ?? [];
    siblings.push(step);
    children.set(step.parent, siblings);
  }

  const lines = ['QUERY PLAN'];
  const walk = (parent: number, prefix: string): void => {
    const nodes = children.get(parent) ?? [];
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      lines.push(`${prefix}${last ? '`--' : '|--'}${node.detail}`);
      walk(node.id, `${prefix}${last ? '   ' : '|  '}`);
    });
  };
  walk(0, '');
  return lines.join('\n');
}
