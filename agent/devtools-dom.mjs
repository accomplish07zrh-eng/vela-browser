/**
 * Serialized to the browser by Playwright. Stable element identifiers survive sibling movement.
 * Unkeyed siblings fall back to their order among siblings of the same kind.
 */
export function domSnapshot(root) {
  const rows = [];
  const childrenOf = node => {
    const children = Array.from(node.childNodes ?? []);
    if (node.shadowRoot) children.push(node.shadowRoot);
    if (node.localName === "template" && node.content) children.push(node.content);
    return children;
  };
  const pending = [{ node: root, key: "root", parent: null }];
  while (pending.length) {
    const { node, key, parent } = pending.pop();
    const tag = node.localName || node.nodeName;
    const row = { key, parent, tag };
    if (node.nodeValue !== null) row.text = node.nodeValue;
    if (node.nodeType === 1) {
      row.attributes = Object.fromEntries(Array.from(node.attributes, attribute => [attribute.name, attribute.value]).sort(([a], [b]) => a.localeCompare(b)));
      if (["input", "textarea", "select"].includes(tag)) {
        row.value = node.value;
        if (tag === "input" && ["checkbox", "radio"].includes(node.type)) row.checked = node.checked;
        if (tag === "select" && node.multiple) row.selected = Array.from(node.selectedOptions, option => option.value);
      }
      if (tag === "details") row.open = node.open;
    }
    rows.push(row);
    const occurrences = new Map();
    const children = childrenOf(node).map(child => {
      const identity = child.getAttribute?.("id") || child.getAttribute?.("data-testid") || child.getAttribute?.("name");
      const kind = JSON.stringify([child.localName || child.nodeName, identity ?? null]);
      const ordinal = (occurrences.get(kind) ?? 0) + 1;
      occurrences.set(kind, ordinal);
      return { node: child, key: `${key}/${kind}/${ordinal}`, parent: key };
    });
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  return rows;
}

export function compareSnapshots(before, after) {
  const old = new Map(before.map(node => [node.key, node]));
  const current = new Map(after.map(node => [node.key, node]));
  const changes = [];
  for (const node of before) if (!current.has(node.key)) changes.push({ type: "removed", before: node });
  for (const node of after) {
    const previous = old.get(node.key);
    if (!previous) changes.push({ type: "added", after: node });
    else if (JSON.stringify(previous) !== JSON.stringify(node)) changes.push({ type: "changed", before: previous, after: node });
  }
  const siblingOrder = (nodes, other) => {
    const byParent = new Map();
    for (const node of nodes) {
      if (!other.has(node.key)) continue;
      const siblings = byParent.get(node.parent) ?? [];
      siblings.push(node.key);
      byParent.set(node.parent, siblings);
    }
    return byParent;
  };
  const beforeOrder = siblingOrder(before, current), afterOrder = siblingOrder(after, old);
  for (const [parent, keys] of beforeOrder) {
    const order = afterOrder.get(parent);
    if (order && keys.some((key, index) => key !== order[index])) changes.push({ type: "reordered", parent, before: keys, after: order });
  }
  return changes;
}
