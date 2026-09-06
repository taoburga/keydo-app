// Pure state transformations shared with regression tests.
export function reorderTreeTies(tasks, saved, keyFor) {
  if (!saved) return tasks;
  const output = [];
  let roots = [], stack = [];
  function flush() {
    const order = siblings => {
      const buckets = new Map();
      for (const node of siblings) {
        const key = keyFor(node.task);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(node);
      }
      for (const [key, nodes] of buckets) {
        const rank = new Map((saved[key] || []).map((id, i) => [id, i]));
        nodes.sort((a, b) => (rank.get(a.task.id) ?? Infinity) - (rank.get(b.task.id) ?? Infinity));
      }
      const positions = new Map();
      for (const node of siblings) {
        const key = keyFor(node.task), index = positions.get(key) || 0;
        const next = buckets.get(key)[index];
        positions.set(key, index + 1);
        output.push(next.task);
        order(next.children);
      }
    };
    order(roots); roots = []; stack = [];
  }
  for (const task of tasks) {
    if (!task.id) { flush(); output.push(task); continue; }
    const depth = task._depth || 0;
    while (stack.length && (stack.at(-1).task._depth || 0) >= depth) stack.pop();
    const node = { task, children: [] };
    (stack.length ? stack.at(-1).children : roots).push(node);
    stack.push(node);
  }
  flush();
  return output;
}

// Only identifiers in known reference fields are rewritten. User text that
// happens to contain an old ID is not touched.
export function remapAction(action, oldId, newId) {
  const fields = new Set(['taskId', 'parent', 'parentId', 'grandparent', 'childId', 'id', 'originalId', 'orderGroupKey', 'groupKey']);
  const arrays = new Set(['orderSiblingIds', 'siblingIds', 'children', 'childIds', 'orderedChildIds', 'childOrderInParent']);
  function walk(value, key = '') {
    if (typeof value === 'string') return (fields.has(key) || arrays.has(key)) && value === oldId ? newId : value;
    if (Array.isArray(value)) return value.map(v => walk(v, key));
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) value[k] = walk(value[k], k);
    }
    return value;
  }
  return walk(action);
}

export async function mapLimited(items, concurrency, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; await fn(items[index], index); }
  }));
}
