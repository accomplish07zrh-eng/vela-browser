import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dialogParts } from "./dialog.tsx";
import { adoptTitle, placeTip } from "./tooltip.tsx";
import { NumberInput } from "./controls.tsx";

test("a dialog leads with the question wherever the text puts it", () => {
  expect(dialogParts("Delete group “A”?")).toEqual({ heading: "Delete group “A”?", body: [] });
  expect(dialogParts("Remove it?\n\nIt will be unassigned.")).toEqual({ heading: "Remove it?", body: ["It will be unassigned."] });
  // The fingerprint warning explains first and asks last.
  expect(dialogParts("These settings work together.\n\nSave fingerprint changes?")).toEqual({
    heading: "Save fingerprint changes?", body: ["These settings work together."],
  });
  expect(dialogParts("保存指纹修改？")).toEqual({ heading: "保存指纹修改？", body: [] });
  // A notice with its own title keeps every paragraph underneath.
  expect(dialogParts("Imported 3.\n\n1 invalid.", "Import finished")).toEqual({ heading: "Import finished", body: ["Imported 3.", "1 invalid."] });
});

function element(attributes: Record<string, string>, text = "") {
  const map = new Map(Object.entries(attributes));
  return {
    textContent: text,
    getAttribute: (name: string) => map.get(name) ?? null,
    setAttribute: (name: string, value: string) => { map.set(name, value); },
    removeAttribute: (name: string) => { map.delete(name); },
    hasAttribute: (name: string) => map.has(name),
    attributes: map,
  };
}

test("a title becomes the app's tooltip and the system one never opens", () => {
  const icon = element({ title: "Close" });
  expect(adoptTitle(icon as unknown as Element)).toBe("Close");
  expect(icon.attributes.has("title")).toBe(false);
  // An icon-only control keeps its name for screen readers.
  expect(icon.getAttribute("aria-label")).toBe("Close");

  const labelled = element({ title: "Open the profile", "aria-label": "Open" }, "Open");
  expect(adoptTitle(labelled as unknown as Element)).toBe("Open the profile");
  expect(labelled.getAttribute("aria-label")).toBe("Open");

  const texted = element({ title: "Export → edit → re-upload" }, "Update from file");
  adoptTitle(texted as unknown as Element);
  expect(texted.attributes.has("aria-label")).toBe(false);

  // React may set the title again with a new value; the next hover takes that one.
  icon.setAttribute("title", "Close window");
  expect(adoptTitle(icon as unknown as Element)).toBe("Close window");
  // The app's own data-tip wins, and an empty title shows nothing.
  expect(adoptTitle(element({ "data-tip": "Settings", title: "Settings" }) as unknown as Element)).toBe("Settings");
  expect(adoptTitle(element({ title: " " }) as unknown as Element)).toBeNull();
});

test("a tooltip sits above its anchor, flips below at the top edge and stays inside the window", () => {
  const view = { width: 1000, height: 700 };
  const bubble = { width: 120, height: 28 };
  expect(placeTip({ left: 440, top: 300, width: 120, height: 32 }, bubble, view)).toEqual({ x: 440, y: 264, side: "top" });
  expect(placeTip({ left: 440, top: 10, width: 120, height: 32 }, bubble, view)).toEqual({ x: 440, y: 50, side: "bottom" });
  expect(placeTip({ left: 0, top: 300, width: 20, height: 20 }, bubble, view).x).toBe(8);
  expect(placeTip({ left: 990, top: 300, width: 10, height: 20 }, bubble, view).x).toBe(1000 - 8 - 120);
});

test("a number field is still a number input, with the app's stepper beside it", () => {
  const html = renderToStaticMarkup(createElement(NumberInput, { min: 1, max: 9, value: 3, onChange: () => {}, "aria-label": "Quantity" }));
  expect(html).toContain('type="number"');
  expect(html).toContain('min="1"');
  expect(html).toContain('aria-label="Quantity"');
  expect(html.match(/<button/g)?.length).toBe(2);
  expect(html).toContain('class="vnumber-steps" aria-hidden="true"');
});
