import { expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { choices, Select } from "./select.tsx";

test("options are read however they were written: plain, mapped, in fragments and groups", () => {
  const list = choices([
    createElement("option", { key: "a", value: "a" }, "Alpha"),
    createElement(Fragment, { key: "f" }, ["b", "c"].map((value) => createElement("option", { key: value, value }, `Option ${value}`))),
    false,
    createElement("optgroup", { key: "g", label: "More" }, createElement("option", { value: 7, disabled: true }, "Seven"), createElement("option", null, "No value")),
  ]);
  expect(list.map(({ value, text, disabled, group }) => ({ value, text, disabled, group }))).toEqual([
    { value: "a", text: "Alpha", disabled: false, group: undefined },
    { value: "b", text: "Option b", disabled: false, group: undefined },
    { value: "c", text: "Option c", disabled: false, group: undefined },
    { value: "7", text: "Seven", disabled: true, group: "More" },
    // An option without a value takes its text, as in HTML.
    { value: "No value", text: "No value", disabled: false, group: "More" },
  ]);
});

test("closed, it shows the chosen option as a combobox and keeps the field's classes", () => {
  const html = renderToStaticMarkup(createElement(Select, { value: "85", className: "select wide", "aria-label": "Threshold", onChange: () => {} },
    createElement("option", { value: "70" }, "70%"), createElement("option", { value: "85" }, "85%")));
  expect(html).toContain('class="select wide vselect"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-label="Threshold"');
  expect(html).toContain(">85%<");
  // Without a value it shows the first option, as a native select does.
  expect(renderToStaticMarkup(createElement(Select, {}, createElement("option", { value: "x" }, "First")))).toContain(">First<");
});
