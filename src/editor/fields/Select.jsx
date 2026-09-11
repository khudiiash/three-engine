import { Children, isValidElement, useRef, useState } from "react";
import { ChevronDown } from "../icons/index.jsx";
import { PopoverMenu } from "./PopoverMenu.jsx";

/**
 * A drop-in replacement for a native `<select>`.
 *
 * WHY IT EXISTS: a native `<select>` can be styled down to its trigger and no
 * further — the open list is drawn by the platform, so in this near-black
 * editor every dropdown came up as a white box with barely-legible text, and
 * `color-scheme: dark` plus CSS on `option` does not fix that in the WebView.
 * `SelectField` already solved this for new code, but ~100 call sites were
 * still native, which is why the complaint was "white dropdowns all over the
 * editor" rather than one panel.
 *
 * Swapping those needed to be a TAG RENAME, not a rewrite of 100 call sites,
 * so this deliberately keeps the DOM's contract rather than a nicer one:
 *
 *   - `<option>` and `<optgroup>` children, read straight off `props.children`
 *     — so `.map()`, `&&` conditionals and literal lists all keep working
 *     exactly as they did;
 *   - `onChange` receives `{ target: { value } }` with a STRING value, which is
 *     what the DOM gives, so every existing `e.target.value` /
 *     `Number(e.target.value)` handler behaves identically;
 *   - values compare stringified, which is how the DOM matches an option to
 *     `select.value`.
 *
 * `className` lands on the trigger BUTTON, not the wrapper, because that is
 * what those classes used to style on the native control.
 *
 * Prefer `SelectField` (an options array) in new code; this is for the sites
 * that were already written against the DOM.
 */

/** The DOM's rule: an option's value is its `value` attribute, or its text. */
function optionValue(el) {
  if (el.props.value !== undefined) return String(el.props.value);
  return String(childText(el.props.children));
}

function childText(children) {
  return Children.toArray(children)
    .map((c) => (isValidElement(c) ? childText(c.props?.children) : c))
    .join("");
}

/** Flatten children into a list of `{value,label,disabled,title}` items and
 *  `{group,label}` markers. `Children.toArray` already drops `false`/`null`
 *  and splices arrays, so a `.map()` and a bare conditional both land here as
 *  plain elements. */
function readItems(children, out = []) {
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    if (child.type === "optgroup") {
      out.push({ group: true, label: child.props.label });
      readItems(child.props.children, out);
      continue;
    }
    if (child.type !== "option") {
      // A fragment or wrapper around options — look inside rather than drop it.
      if (child.props?.children) readItems(child.props.children, out);
      continue;
    }
    out.push({
      value: optionValue(child),
      label: childText(child.props.children),
      disabled: !!child.props.disabled,
      title: child.props.title,
    });
  }
  return out;
}

export function Select({
  value,
  onChange,
  children,
  className = "",
  title,
  disabled = false,
  align = "left",
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  const items = readItems(children);
  const selected = String(value ?? "");
  const current = items.find((item) => !item.group && item.value === selected);

  const pick = (item) => {
    setOpen(false);
    if (item.value === selected) return;
    // The DOM shape, so existing handlers need no edit.
    onChange?.({ target: { value: item.value } });
  };

  // No wrapper element: the button stands exactly where the `<select>` stood,
  // carrying exactly the class the `<select>` carried, so nothing about the
  // surrounding layout changes at ~100 swapped call sites. `PopoverMenu`
  // portals to the body and positions from a rect, so it anchors to the button
  // itself perfectly well.
  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className={`tx-select ${className} ${open ? "open" : ""}`}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        {...rest}
      >
        <span className="tx-select-value">{current?.label ?? ""}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <PopoverMenu anchorRef={anchorRef} className="tx-select-menu" align={align} onClose={() => setOpen(false)}>
          {items.map((item, i) =>
            item.group ? (
              <div className="dropdown-section-label" key={`g${i}`}>
                {item.label}
              </div>
            ) : (
              <button
                key={`${item.value}-${i}`}
                type="button"
                // `checked` is how every other menu in the editor marks the
                // current entry — accent text on an accent-soft row, no glyph.
                // A tick next to a value reads as a checkbox, which is a
                // different control entirely.
                className={`dropdown-item ${item.value === selected ? "checked selected" : ""}`}
                title={item.title}
                disabled={item.disabled}
                onClick={() => pick(item)}
              >
                <span className="menu-item-label">{item.label}</span>
              </button>
            ),
          )}
        </PopoverMenu>
      )}
    </>
  );
}
