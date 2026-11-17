/** Read only the control metadata needed to author a workflow. Playwright serializes this function. */
export function readFormControls(scope) {
  const fields = 'input:not([type="hidden"]), textarea, select, [contenteditable]:not([contenteditable="false"])';
  const buttons = 'button, input[type="submit"], [role="button"]';
  const doc = scope.ownerDocument;
  const tree = scope.getRootNode();
  const clean = value => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const attr = (node, name) => node.getAttribute(name) ?? "";
  const label = node => {
    const labels = attr(node, "aria-labelledby").trim().split(/\s+/).filter(Boolean);
    return clean(labels.map(id => tree.getElementById(id)?.textContent).filter(Boolean).join(" ")
      || attr(node, "aria-label") || Array.from(node.labels ?? [], item => item.textContent).join(" "));
  };
  const visible = node => node.getClientRects().length > 0 && !node.closest('[aria-hidden="true"], [inert]')
    && doc.defaultView.getComputedStyle(node).visibility === "visible";
  const selectorFor = (node, prefix = "") => {
    const tag = CSS.escape(node.localName);
    const selectors = ["id", "data-testid", "name", "autocomplete", "aria-label", "type"]
      .flatMap(name => {
        const value = attr(node, name);
        return value && value.length <= 160 ? [tag + "[" + name + '="' + CSS.escape(value) + '"]'] : [];
      });
    selectors.push(tag);
    for (const selector of selectors) {
      const candidate = prefix + selector;
      const matches = tree.querySelectorAll(candidate);
      if (matches.length === 1 && matches[0] === node) return candidate;
    }
    return null;
  };
  const groups = new Map();
  const nodes = scope.querySelectorAll(fields + ", " + buttons);
  let truncated = nodes.length > 400;
  for (let index = 0; index < Math.min(nodes.length, 400); index++) {
    const node = nodes[index];
    if (!visible(node)) continue;
    const form = node.form ?? node.closest("form, [role=form], [role=dialog]");
    const owner = form && (scope === form || scope.contains(form)) ? form : scope;
    let group = groups.get(owner);
    if (!group) {
      if (groups.size >= 12) { truncated = true; break; }
      group = { label: label(owner) || clean(attr(owner, "name")), selector: selectorFor(owner), controls: [] };
      groups.set(owner, group);
    }
    if (group.controls.length >= 48) { truncated = true; continue; }
    const tag = node.localName;
    const type = tag === "input" || tag === "button" ? node.type : tag === "select" && node.multiple ? "select-multiple" : tag;
    const button = node.matches(buttons) || type === "button" || type === "reset" || type === "image";
    const selector = selectorFor(node) ?? (group.selector && owner.contains(node) ? selectorFor(node, group.selector + " ") : null);
    group.controls.push({
      tag, type, selector, button, label: label(node) || (button ? clean(tag === "input" ? attr(node, "value") : node.textContent) : ""),
      name: clean(attr(node, "name")), id: clean(attr(node, "id")), placeholder: button ? "" : clean(attr(node, "placeholder")),
      autocomplete: clean(attr(node, "autocomplete")), required: !!node.required || attr(node, "aria-required") === "true",
      disabled: node.matches(":disabled") || attr(node, "aria-disabled") === "true",
      readOnly: !!node.readOnly || attr(node, "aria-readonly") === "true",
    });
  }
  return { groups: [...groups.values()], truncated };
}

const roles = [
  ["confirmPassword", /(?:confirm|repeat|retype|verify).{0,15}(?:pass(?:word)?|pwd)|(?:pass(?:word)?|pwd).{0,15}(?:confirm|repeat|again|2\b)|确认密码|再次输入密码|確認密碼/iu],
  ["oneTimeCode", /\botp\b|one[ -]?time|verification.?code|security.?code|auth.?code|验证码|驗證碼/iu],
  ["email", /\be[ -]?mail|邮箱|郵箱|电子邮件/iu],
  ["password", /password|\bpwd\b|密码|密碼/iu],
  ["username", /user.?name|login.?name|用户名|帳號|账号/iu],
  ["givenName", /first.?name|given.?name|名字/iu],
  ["familyName", /last.?name|family.?name|surname|姓氏/iu],
  ["fullName", /full.?name|your name|姓名/iu],
  ["phone", /\bphone|mobile|手机号|手机号码|電話/iu],
  ["terms", /terms|polic(?:y|ies)|agree|consent|协议|條款|条款|同意/iu],
];
const autocompleteNames = new Map([
  ["one-time-code", "oneTimeCode"], ["email", "email"], ["new-password", "password"], ["current-password", "password"],
  ["username", "username"], ["given-name", "givenName"], ["family-name", "familyName"], ["name", "fullName"], ["tel", "phone"],
]);

function classify(control) {
  const { type, tag, button, label, placeholder, id, name, autocomplete, readOnly } = control;
  const text = [label, placeholder, name, id].join(" ").replace(/[_-]/g, " ");
  if (button) {
    const kind = /\b(?:next|continue|proceed)\b|下一步|继续|繼續/iu.test(text) ? "next"
      : type === "submit" ? "submit" : "button";
    return { kind };
  }
  const inferred = roles.find(([, pattern]) => pattern.test(text))?.[0];
  const auto = autocomplete.split(/\s+/).map(token => autocompleteNames.get(token)).find(Boolean);
  const action = readOnly ? undefined : type === "checkbox" || type === "radio" ? "check"
    : tag === "select" ? "select" : ["file", "color", "range"].includes(type) ? undefined : "fill";
  const fieldName = (name || id).replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, value => "_" + value).slice(0, 64);
  const kind = inferred === "confirmPassword" ? inferred
    : auto || (type === "email" ? "email" : type === "tel" ? "phone" : inferred || (type === "password" ? "password" : undefined))
      || fieldName || "field";
  return { kind, ...(action ? { action } : {}) };
}

export function describeForms({ groups, truncated }, location) {
  return {
    ...location, truncated,
    forms: groups.map((group, index) => {
      const controls = group.controls.map(control => ({ ...control, ...classify(control) }));
      const fields = controls.filter(control => control.action && !control.disabled);
      const complete = fields.filter(field => field.selector && field.kind !== "field"
        && fields.filter(other => other.kind === field.kind).length === 1);
      const buttons = controls.filter(control => control.button);
      const leading = buttons.filter(button => button.selector && ["submit", "next"].includes(button.kind));
      return {
        label: group.label, selector: group.selector,
        fields: controls.filter(control => !control.button), buttons,
        ...(location.pageUrl ? { suggestedStage: {
          id: "form-" + (index + 1), pageUrl: location.pageUrl,
          ...(location.frameUrl ? { frameUrl: location.frameUrl, ...(location.frameName ? { frameName: location.frameName } : {}) } : {}),
          fields: complete.map(({ selector, action, kind, required }) => ({
            selector, action, input: kind === "confirmPassword" && complete.some(field => field.kind === "password") ? "password" : kind, required,
          })),
          ...(leading.length === 1 ? { submit: leading[0].selector } : {}),
        } } : {}),
        needsSelection: truncated || complete.length !== fields.length || leading.length > 1,
      };
    }),
  };
}
