// Mounts `fields/Select.jsx` on its own for run-select-dropdown-test.mjs.
// Lives in the project so Vite resolves React the same way the editor does.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Select } from "../../src/editor/fields/Select.jsx";

export function mountSelectProbe(el) {
  const seen = [];

  function Demo() {
    const [value, setValue] = useState("b");
    return (
      <Select
        className="select-field"
        value={value}
        onChange={(e) => {
          // `asNumber` is stringified because NaN does not survive JSON.
          seen.push({ raw: e.target.value, asNumber: String(Number(e.target.value)) });
          setValue(e.target.value);
        }}
      >
        <option value="a">Alpha</option>
        <option value="b">Bravo</option>
        {/* The two child shapes the sweep had to preserve: a `&&` that is
            false, and a `.map()` inside an <optgroup>. */}
        {false && <option value="hidden">Hidden</option>}
        <optgroup label="Group">
          {["c", "d"].map((k) => (
            <option key={k} value={k}>
              {k.toUpperCase()}
            </option>
          ))}
        </optgroup>
        {/* A NUMERIC option value — the DOM hands `e.target.value` back as a
            string, and call sites like ModelPreview's clip index rely on that
            by wrapping it in `Number(...)`. */}
        <option value={3}>Three</option>
      </Select>
    );
  }

  createRoot(el).render(<Demo />);
  return seen;
}
