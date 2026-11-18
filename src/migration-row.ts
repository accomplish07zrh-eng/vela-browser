import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { SecretBox } from "./secret-box.ts";

type SqlScalar = string | number | null;
type ProfileRow = Record<string, SqlScalar>;

function readRow(db: Database, id: string): ProfileRow | null {
  return db.query<ProfileRow, [string]>("SELECT rowid AS migration_rowid, * FROM profiles WHERE id = ?").get(id);
}

function profileSchema(db: Database) {
  const info = db.query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
    "PRAGMA table_info(profiles)",
  ).all();
  return {
    columns: info.map(column => column.name),
    signature: createHash("sha256").update(JSON.stringify(info)).digest("hex"),
  };
}

function isSqlScalar(value: unknown): value is SqlScalar {
  return value === null || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
}

function isProfileRow(value: unknown, columns: string[], id: string): value is ProfileRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.id === id && typeof row.group === "string" && Number.isSafeInteger(row.migration_rowid)
    && Object.keys(row).length === columns.length + 1
    && columns.every(column => Object.hasOwn(row, column) && isSqlScalar(row[column]));
}

/** Read raw columns so old ciphertext and pending session state survive an exact restore. */
export function captureMigrationRow(db: Database, box: SecretBox, id: string): string {
  const { columns, signature } = profileSchema(db);
  const row = readRow(db, id);
  if (!db.inTransaction || !isProfileRow(row, columns, id)) throw new Error("Cannot capture profile for migration undo");
  return box.seal(JSON.stringify({ format: 1, schema: signature, row }));
}

/** The caller owns the transaction and must roll back when a snapshot cannot be restored. */
export function restoreMigrationRow(db: Database, box: SecretBox, id: string, encrypted: string): boolean {
  if (!db.inTransaction || typeof encrypted !== "string" || !SecretBox.isSealed(encrypted)) return false;

  let snapshot: { format?: unknown; schema?: unknown; row?: unknown };
  try { snapshot = JSON.parse(box.open(encrypted)); }
  catch { return false; }

  const { columns, signature } = profileSchema(db);
  if (snapshot?.format !== 1 || snapshot.schema !== signature || !isProfileRow(snapshot.row, columns, id)) return false;
  const before = snapshot.row;
  const current = readRow(db, id);
  if (!current || current.migration_rowid !== before.migration_rowid) return false;
  if (before.group && !db.query("SELECT 1 FROM groups WHERE name = ?").get(before.group)) return false;

  const writable = columns.filter(column => column !== "id");
  const fields = writable.map(column => `"${column.replaceAll('"', '""')}" = ?`);
  const values = writable.map(column => before[column]!);
  const { changes } = db.query<unknown, SqlScalar[]>(`UPDATE profiles SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  if (changes !== 1) return false;

  const restored = readRow(db, id);
  return !!restored && Object.entries(before).every(([column, value]) => Object.is(value, restored[column]));
}
