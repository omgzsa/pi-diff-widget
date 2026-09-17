import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { renderDiff } from '@earendil-works/pi-coding-agent';
import type { Theme } from '@earendil-works/pi-coding-agent';

export interface DiffSection {
    title: string;
    detail?: string;
    /** Raw display diff in pi's line-numbered format. Rendered with `renderDiff`. */
    diff?: string;
    note?: string;
}

export interface TurnView {
    label: string;
    sections: DiffSection[];
}

export type ViewMode = 'uncommitted' | 'turns';

export interface DiffViewerOptions {
    title: string;
    uncommitted: DiffSection[];
    turns: TurnView[];
    initialMode: ViewMode;
    tui: TUI;
    theme: Theme;
    onClose: () => void;
}

/**
 * Full-screen scrollable diff view. Renders one source at a time: uncommitted
 * changes or the edits of a single turn. `Tab` switches source, `[` and `]`
 * walk turns. Used as an overlay, so it reads its own height from the terminal.
 */
export class DiffViewer implements Component {
    private readonly title: string;
    private readonly uncommitted: DiffSection[];
    private readonly turns: TurnView[];
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly onClose: () => void;

    private mode: ViewMode;
    private turnIndex: number;
    private lines: string[] = [];
    private sectionStarts: number[] = [];
    private offset = 0;
    private viewportHeight = 1;

    constructor(options: DiffViewerOptions) {
        this.title = options.title;
        this.uncommitted = options.uncommitted;
        this.turns = options.turns;
        this.tui = options.tui;
        this.theme = options.theme;
        this.onClose = options.onClose;
        this.mode = options.initialMode;
        this.turnIndex = Math.max(0, options.turns.length - 1);
        this.rebuild();
    }

    private currentSections(): DiffSection[] {
        if (this.mode === 'turns')
            return this.turns[this.turnIndex]?.sections ?? [];
        return this.uncommitted;
    }

    private rebuild(): void {
        const theme = this.theme;
        this.lines = [];
        this.sectionStarts = [];

        const sections = this.currentSections();
        if (sections.length === 0) {
            this.lines.push(theme.fg('dim', 'No changes to show.'));
            return;
        }

        for (const section of sections) {
            this.sectionStarts.push(this.lines.length);
            const detail = section.detail
                ? `  ${theme.fg('dim', section.detail)}`
                : '';
            this.lines.push(
                `${theme.fg('accent', theme.bold(section.title))}${detail}`,
            );
            if (section.diff) {
                // renderDiff uses pi's active theme, matching inline edit diffs.
                for (const line of renderDiff(section.diff).split('\n'))
                    this.lines.push(line);
            } else {
                this.lines.push(
                    theme.fg('dim', section.note ?? '(no textual diff)'),
                );
            }
            this.lines.push('');
        }
    }

    private headerText(): string {
        if (this.mode === 'turns') {
            const counter = `[${this.turnIndex + 1}/${this.turns.length}]`;
            const label = this.turns[this.turnIndex]?.label ?? '';
            return `${this.title} · turns  ${this.theme.fg('dim', `${counter} ${label}`)}`;
        }
        return `${this.title} · uncommitted  ${this.theme.fg('dim', `[${this.uncommitted.length} files]`)}`;
    }

    private footerHint(): string {
        const parts: string[] = [];
        if (this.mode === 'turns') {
            parts.push('[ / ] turn');
            if (this.uncommitted.length > 0) parts.push('Tab uncommitted');
        } else if (this.turns.length > 0) {
            parts.push('Tab turns');
        }
        parts.push('up/down scroll', 'n/p section', 'g/G ends', 'q close');
        return parts.join('   ');
    }

    private clamp(): void {
        const max = Math.max(0, this.lines.length - this.viewportHeight);
        this.offset = Math.max(0, Math.min(this.offset, max));
    }

    private currentSectionIndex(): number {
        let index = 0;
        for (let i = 0; i < this.sectionStarts.length; i++) {
            if ((this.sectionStarts[i] ?? 0) <= this.offset) index = i;
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

    private goToSection(direction: number): void {
        const next = this.currentSectionIndex() + direction;
        if (next < 0 || next >= this.sectionStarts.length) return;
        this.goTo(this.sectionStarts[next] ?? 0);
    }

    private switchMode(): void {
        if (this.mode === 'turns') {
            this.mode = 'uncommitted';
        } else {
            if (this.turns.length === 0) return;
            this.mode = 'turns';
            this.turnIndex = this.turns.length - 1;
        }
        this.offset = 0;
        this.rebuild();
        this.tui.requestRender();
    }

    private stepTurn(direction: number): void {
        const next = this.turnIndex + direction;
        if (next < 0 || next >= this.turns.length) return;
        this.turnIndex = next;
        this.offset = 0;
        this.rebuild();
        this.tui.requestRender();
    }

    render(width: number): string[] {
        const height = Math.max(6, this.tui.terminal.rows - 1);
        this.viewportHeight = Math.max(1, height - 2);
        this.clamp();

        const out: string[] = [truncateToWidth(this.headerText(), width)];

        for (let i = 0; i < this.viewportHeight; i++) {
            const line = this.lines[this.offset + i];
            out.push(line === undefined ? '' : truncateToWidth(line, width));
        }

        const last = Math.min(
            this.offset + this.viewportHeight,
            this.lines.length,
        );
        const range =
            this.lines.length === 0
                ? '0/0'
                : `${this.offset + 1}-${last}/${this.lines.length}`;
        out.push(
            truncateToWidth(
                this.theme.fg('dim', `${this.footerHint()}   ${range}`),
                width,
            ),
        );

        return out;
    }

    handleInput(data: string): void {
        if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.ctrl('c')) ||
            data === 'q'
        ) {
            this.onClose();
            return;
        }
        if (matchesKey(data, Key.tab)) {
            this.switchMode();
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
        if (this.mode === 'turns' && data === '[') {
            this.stepTurn(-1);
            return;
        }
        if (this.mode === 'turns' && data === ']') {
            this.stepTurn(1);
            return;
        }
        if (data === 'n') {
            this.goToSection(1);
            return;
        }
        if (data === 'p') {
            this.goToSection(-1);
            return;
        }
        if (data === 'g') {
            this.goTo(0);
            return;
        }
        if (data === 'G') {
            this.goTo(this.lines.length);
        }
    }

    invalidate(): void {
        this.rebuild();
    }
}
