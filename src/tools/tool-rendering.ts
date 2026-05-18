import type {
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

type Tone = "muted" | "accent" | "success" | "warning" | "error" | "dim";

export interface ToolCallHeaderOptionArg {
  label: string;
  value: string;
  tone?: Tone;
}

export interface ToolCallHeaderLongArg {
  label?: string;
  value: string;
}

export interface ToolCallHeaderConfig {
  toolName: string;
  action?: string;
  mainArg?: string;
  optionArgs?: ToolCallHeaderOptionArg[];
  longArgs?: ToolCallHeaderLongArg[];
  showColon?: boolean;
}

export class ToolCallHeader implements Component {
  constructor(
    private config: ToolCallHeaderConfig,
    private theme: Theme,
  ) {}

  handleInput(_data: string): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const title =
      (this.config.showColon ?? Boolean(this.config.action))
        ? `${this.config.toolName}:`
        : this.config.toolName;
    const parts = [this.theme.fg("toolTitle", this.theme.bold(title))];

    if (this.config.action) {
      parts.push(this.theme.fg("accent", this.config.action));
    }
    if (this.config.mainArg) {
      parts.push(this.theme.fg("accent", this.config.mainArg));
    }

    for (const option of this.config.optionArgs ?? []) {
      const label = option.label.trim().toLowerCase();
      const tone = option.tone ?? "dim";
      parts.push(
        `${this.theme.fg("muted", `${label}=`)}${this.theme.fg(tone, option.value)}`,
      );
    }

    const lines = [parts.join(" ")];
    for (const arg of this.config.longArgs ?? []) {
      if (!arg.value) continue;
      const label = arg.label
        ? `${this.theme.fg("muted", `${arg.label.trim().toLowerCase()}:`)} `
        : "";
      lines.push(`${label}${this.theme.fg("dim", arg.value)}`);
    }

    return new Text(lines.join("\n"), 0, 0).render(width);
  }
}

export type ToolBodyField =
  | { label: string; value: string; showCollapsed?: boolean }
  | (Component & { showCollapsed?: boolean });

export interface ToolBodyConfig {
  fields: ToolBodyField[];
  footer?: Component;
  includeSpacerBeforeFooter?: boolean;
}

export class ToolBody implements Component {
  constructor(
    private config: ToolBodyConfig,
    private options: ToolRenderResultOptions,
    private theme: Theme,
  ) {}

  handleInput(_data: string): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const fields = this.options.expanded
      ? this.config.fields
      : this.config.fields.filter((field) => field.showCollapsed === true);
    const lines: string[] = [];

    for (const field of fields) {
      if (isComponent(field)) {
        lines.push(...field.render(width));
      } else {
        lines.push(
          ...new Text(
            `${this.theme.fg("muted", `${field.label}: `)}${field.value}`,
            0,
            0,
          ).render(width),
        );
      }
    }

    if (this.config.footer) {
      if (this.config.includeSpacerBeforeFooter ?? true) lines.push("");
      lines.push(...this.config.footer.render(width));
    }

    return lines;
  }
}

export interface ToolFooterItem {
  label?: string;
  value: string;
  tone?: Exclude<Tone, "dim">;
}

export interface ToolFooterConfig {
  items: ToolFooterItem[];
  separator?: " - " | " | ";
  truncate?: boolean;
}

export class ToolFooter implements Component {
  constructor(
    private theme: Theme,
    private config: ToolFooterConfig,
  ) {}

  handleInput(_data: string): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const line = this.config.items
      .filter((item) => item.value.length > 0)
      .map((item) => {
        const text = item.label ? `${item.label}: ${item.value}` : item.value;
        return this.theme.fg(item.tone ?? "muted", text);
      })
      .join(this.config.separator ?? " - ");

    return [
      (this.config.truncate ?? true) ? truncateToWidth(line, width) : line,
    ];
  }
}

function isComponent(field: ToolBodyField): field is Component {
  return "render" in field && typeof field.render === "function";
}
