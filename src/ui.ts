import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DiffFile } from "./git.ts";

export interface DiffViewerOptions {
  title: string;
  files: DiffFile[];
  tui: TUI;
  theme: Theme;
  onClose: () => void;
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  binary: "binary",
  "too-large": "too large",
};

/**
 * Full-screen scrollable diff view. Renders the whole change set as one flat
 * document with a file header per section, clipped to a viewport. Used as an
 * overlay, so it reads its own height from the terminal.
 */
export class DiffViewer implements Component {
  private readonly title: string;
  private readonly files: DiffFile[];
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly onClose: () => void;

  private lines: string[] = [];
  private fileStarts: number[] = [];
  private offset = 0;
  private viewportHeight = 1;

  constructor(options: DiffViewerOptions) {
    this.title = options.title;
    this.files = options.files;
    this.tui = options.tui;
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.build();
  }

  private build(): void {
    const theme = this.theme;
    this.lines = [];
    this.fileStarts = [];

    for (const file of this.files) {
      this.fileStarts.push(this.lines.length);
      const status = theme.fg("dim", STATUS_LABEL[file.status]);
      this.lines.push(`${theme.fg("accent", theme.bold(file.path))}  ${status}`);
      if (file.diff) {
        // renderDiff uses pi's active theme, matching inline edit diffs.
        for (const line of renderDiff(file.diff).split("\n")) this.lines.push(line);
      } else {
        this.lines.push(theme.fg("dim", "(no textual diff)"));
      }
      this.lines.push("");
    }
  }

  private clamp(): void {
    const max = Math.max(0, this.lines.length - this.viewportHeight);
    this.offset = Math.max(0, Math.min(this.offset, max));
  }

  private currentFileIndex(): number {
    let index = 0;
    for (let i = 0; i < this.fileStarts.length; i++) {
      if ((this.fileStarts[i] ?? 0) <= this.offset) index = i;
    }
    return index;
  }

  private scroll(delta: number): void {
    this.offset += delta;
    this.clamp();
    this.tui.requestRender();
  }

  private goTo(line: number): void {
    this.offset = line;
    this.clamp();
    this.tui.requestRender();
  }

  private goToFile(direction: number): void {
    const next = this.currentFileIndex() + direction;
    if (next < 0 || next >= this.fileStarts.length) return;
    this.goTo(this.fileStarts[next] ?? 0);
  }

  render(width: number): string[] {
    const height = Math.max(6, this.tui.terminal.rows - 1);
    this.viewportHeight = Math.max(1, height - 2);
    this.clamp();

    const out: string[] = [];

    const fileIndex = this.currentFileIndex();
    const active = this.files[fileIndex];
    const counter = `[${fileIndex + 1}/${this.files.length}]`;
    out.push(truncateToWidth(`${this.title}  ${this.theme.fg("dim", `${counter} ${active?.path ?? ""}`)}`, width));

    for (let i = 0; i < this.viewportHeight; i++) {
      const line = this.lines[this.offset + i];
      out.push(line === undefined ? "" : truncateToWidth(line, width));
    }

    const last = Math.min(this.offset + this.viewportHeight, this.lines.length);
    const range = this.lines.length === 0 ? "0/0" : `${this.offset + 1}-${last}/${this.lines.length}`;
    const hint = "up/down scroll   n/p file   g/G ends   q close";
    out.push(truncateToWidth(this.theme.fg("dim", `${hint}   ${range}`), width));

    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scroll(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scroll(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scroll(-this.viewportHeight);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scroll(this.viewportHeight);
      return;
    }
    if (data === "n") {
      this.goToFile(1);
      return;
    }
    if (data === "p") {
      this.goToFile(-1);
      return;
    }
    if (data === "g") {
      this.goTo(0);
      return;
    }
    if (data === "G") {
      this.goTo(this.lines.length);
    }
  }

  invalidate(): void {
    this.build();
  }
}
