import { randomUUID } from "node:crypto";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const TRACE_PREFIX = "__vela_trace__:";

function fields(segment) {
  const result = [];
  let value = 0, shift = 0;
  for (const digit of segment) {
    const group = BASE64.indexOf(digit);
    if (group < 0 || shift > 45) throw new Error("Invalid source-map VLQ");
    value += (group & 31) * 2 ** shift;
    if (group & 32) { shift += 5; continue; }
    result.push((value % 2 ? -1 : 1) * Math.floor(value / 2));
    value = 0; shift = 0;
  }
  if (shift) throw new Error("Incomplete source-map VLQ");
  return result;
}

function* points(map, lineOffset = 0, columnOffset = 0) {
  if (Array.isArray(map.sections)) {
    for (const section of map.sections) {
      if (!section.map) continue;
      yield* points(section.map, lineOffset + section.offset.line, section.offset.column + (section.offset.line ? 0 : columnOffset));
    }
    return;
  }
  let source = 0, line = 0, column = 0, name = 0;
  for (const [generatedLine, segments] of String(map.mappings ?? "").split(";").entries()) {
    let generatedColumn = 0;
    for (const segment of segments.split(",")) {
      if (!segment) continue;
      const [generated, sourceDelta, lineDelta, columnDelta, nameDelta] = fields(segment);
      generatedColumn += generated;
      const position = { generatedLine: generatedLine + lineOffset + 1, generatedColumn: generatedColumn + (generatedLine ? 0 : columnOffset) + 1 };
      if (sourceDelta === undefined) { yield position; continue; }
      source += sourceDelta; line += lineDelta; column += columnDelta;
      if (nameDelta !== undefined) name += nameDelta;
      yield { ...position, source: map.sources?.[source], sourceRoot: map.sourceRoot, line: line + 1, column: column + 1,
        ...(nameDelta === undefined ? {} : { name: map.names?.[name] }) };
    }
  }
}

export function originalPosition(map, line, column) {
  let best;
  for (const point of points(map)) {
    if (point.generatedLine > line || point.generatedLine === line && point.generatedColumn > column) break;
    if (point.generatedLine === line) best = point;
  }
  return best?.source === undefined ? null : best;
}

export function generatedPosition(map, source, line, column) {
  let best;
  for (const point of points(map)) {
    if (point.source !== source || point.line !== line) continue;
    if (point.column >= column && (!best || point.column < best.column)) best = point;
  }
  return best ?? null;
}

export function sourceMapData(url) {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) throw new Error("Invalid inline source map");
  const value = url.slice(comma + 1);
  return /;base64(?:;|$)/i.test(url.slice(5, comma)) ? Buffer.from(decodeURIComponent(value), "base64").toString("utf8") : decodeURIComponent(value);
}

export function sourceMapReference(source) {
  const references = [...source.matchAll(/(?:\/\/[#@] ?sourceMappingURL=([^\s]+)|\/\*[#@] ?sourceMappingURL=(\S+?)\s*\*\/)/g)];
  const last = references.at(-1);
  return last?.[1] ?? last?.[2];
}

export async function observeRuntimeSources(context, target, scope, records, tracepoints) {
  const session = await context.newCDPSession(target);
  const ids = new Map();
  const holder = { session, target, scope, ids };
  const forget = () => {
    for (const id of ids.values()) records.delete(id);
    ids.clear();
  };
  const parsed = script => {
    const sourceId = ids.get(script.scriptId) ?? randomUUID();
    ids.set(script.scriptId, sourceId);
    records.set(sourceId, { ...scope, sourceId, transport: "cdp", holder, script });
  };
  session.on("Debugger.scriptParsed", parsed);
  session.on("Debugger.scriptFailedToParse", parsed);
  session.on("Runtime.executionContextsCleared", forget);
  session.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    for (const [scriptId, id] of ids) {
      if (records.get(id)?.script.executionContextId !== executionContextId) continue;
      records.delete(id); ids.delete(scriptId);
    }
  });
  try {
    await session.send("Runtime.enable");
    await session.send("Debugger.enable");
  } catch (error) { forget(); await session.detach().catch(() => {}); throw error; }
  holder.close = async () => {
    forget();
    for (const [id, point] of tracepoints) if (point.holder === holder) tracepoints.delete(id);
    await session.detach().catch(() => {});
  };
  return holder;
}

export async function addTracepoint(record, line, column, expression) {
  const id = randomUUID();
  const prefix = JSON.stringify(TRACE_PREFIX + id);
  // A false conditional breakpoint records runtime values in their original scope without pausing.
  const condition = `(() => {
    try { console.debug(${prefix}, JSON.stringify((${expression}\n), (_, value) => typeof value === "bigint" ? value.toString() : value)); }
    catch (error) { console.debug(${prefix}, JSON.stringify({error: String(error)})); }
    return false;
  })()`;
  const location = { scriptId: record.script.scriptId, lineNumber: line - 1, columnNumber: column - 1 };
  const { breakpointId, actualLocation } = await record.holder.session.send("Debugger.setBreakpoint", { location, condition });
  return { id, breakpointId, actualLocation, holder: record.holder };
}
