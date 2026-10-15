// Every interpolation in an html`` template is escaped unless it is already Html,
// so a page can only contain markup that was written in a template literal here.

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export type Interpolation = Html | string | number | boolean | null | undefined | Interpolation[];

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (value instanceof Html) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(render).join("");
  }
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1];
  }
  return new Html(out);
}

// For markup that is static and trusted, such as the style sheet.
export function raw(text: string): Html {
  return new Html(text);
}

export function join(parts: Interpolation[], separator: Interpolation): Html {
  const kept = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  const out: Interpolation[] = [];
  kept.forEach((p, i) => {
    if (i > 0) {
      out.push(separator);
    }
    out.push(p);
  });
  return new Html(render(out));
}
