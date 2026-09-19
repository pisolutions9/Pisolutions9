// A bounded tool: only explicit item,quantity,unit_price rows are accepted.
export function planInventory(message) {
  if (!/\bcsv\b/i.test(message)) return null;
  const rows = [];
  const pattern = /(?:^|[\n;:]|\band\b)\s*([\p{L}][\p{L}\p{N} _-]{0,79})\s*,\s*(\d+)\s*,\s*(\d+(?:\.\d{1,2})?)(?=\s*(?:$|[\n;]|\.(?!\d)|\band\b))/gu;
  for (const match of message.matchAll(pattern)) {
    const quantity = Number(match[2]);
    const unitCents = Math.round(Number(match[3]) * 100);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000 || !Number.isSafeInteger(unitCents) || unitCents > 100000000) throw new Error('Inventory values exceed supported limits.');
    rows.push({ item: match[1].trim(), quantity, unitCents });
  }
  if (!rows.length || rows.length > 100) return { clarification: 'For an inventory CSV, provide one row per line as item,quantity,unit_price (up to 100 rows; whole quantities and prices with at most two decimal places). Example: pens,12,15.00' };
  // Reject unparsed comma-bearing data instead of silently dropping a bad row.
  const remainder = message.replace(pattern, '').replace(/item\s*,\s*quantity\s*,\s*unit_price(?:\s*,\s*total)?/gi, '');
  if (/,\s*[-\d]/.test(remainder)) return { clarification: 'Some inventory rows could not be read. Please resend every row on its own line as item,quantity,unit_price. Use positive whole quantities and nonnegative prices with at most two decimal places.' };
  return { rows };
}
const money = cents => (cents / 100).toFixed(2);
export function executeInventory(rows) {
  const lines = ['item,quantity,unit_price,total'];
  let total = 0;
  for (const row of rows) {
    const value = row.quantity * row.unitCents;
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) throw new Error('Inventory total exceeds supported limits.');
    total += value;
    lines.push(`${row.item},${row.quantity},${money(row.unitCents)},${money(value)}`);
  }
  lines.push(`Grand total,,,${money(total)}`);
  return { filename: 'inventory.csv', mimeType: 'text/csv;charset=utf-8', content: lines.join('\r\n') + '\r\n' };
}
// Separate verifier reparses the finished artifact and recomputes using BigInt cents.
export function verifyInventory(artifact, sourceRows) {
  const lines = artifact.content.trim().split(/\r?\n/);
  if (lines[0] !== 'item,quantity,unit_price,total' || lines.length !== sourceRows.length + 2) return false;
  const cents = text => { if (!/^\d+\.\d{2}$/.test(text)) throw new Error('Invalid amount'); return BigInt(text.replace('.', '')); };
  try {
    let sum = 0n;
    for (let i = 0; i < sourceRows.length; i++) {
      const [item, quantity, price, total, extra] = lines[i + 1].split(',');
      const row = sourceRows[i];
      if (extra !== undefined || item !== row.item || !/^\d+$/.test(quantity) || BigInt(quantity) !== BigInt(row.quantity) || cents(price) !== BigInt(row.unitCents)) return false;
      const expected = BigInt(quantity) * cents(price);
      if (cents(total) !== expected) return false;
      sum += expected;
    }
    return lines.at(-1).startsWith('Grand total,,,') && cents(lines.at(-1).split(',')[3]) === sum;
  } catch { return false; }
}
export function inventoryMission(message) {
  const plan = planInventory(message);
  if (!plan) return null;
  if (plan.clarification) return { ok: true, answer: plan.clarification, source: 'pi-inventory', truth: 'needs-input', status: 'needs-input' };
  const artifact = executeInventory(plan.rows);
  if (!verifyInventory(artifact, plan.rows)) throw new Error('Inventory verification failed. No file released.');
  const total = artifact.content.trim().split(/\r?\n/).at(-1).split(',')[3];
  return { ok: true, status: 'completed', answer: `Created inventory.csv with ${plan.rows.length} items. Grand total: ${total} in the price units supplied. A separate verifier checked every exported row and recomputed the totals. Use Download inventory.csv below.`, source: 'pi-inventory', truth: 'verified-calculation', artifacts: [artifact], evidence: { plannedRows: plan.rows.length, exportedRows: plan.rows.length, verifier: 'reparsed CSV with independent BigInt arithmetic', total } };
}
