import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectUncommitted, type DiffFile } from "./git.ts";
import { DiffViewer } from "./ui.ts";
// Per-turn support lands next. Wire these once the UI can render turn groups:
// import { collectTurns, registerWriteSnapshots } from "./turns.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Show uncommitted changes in a scrollable diff viewer",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/diff needs the interactive TUI", "warning");
        return;
      }

      await ctx.waitForIdle();

      let files: DiffFile[];
      try {
        files = await collectUncommitted(pi, ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/diff: ${message}`, "error");
        return;
      }

      if (files.length === 0) {
        ctx.ui.notify("No uncommitted changes", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new DiffViewer({
            title: "pi diff · uncommitted",
            files,
            tui,
            theme,
            onClose: () => done(undefined),
          }),
        {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" },
        },
      );
    },
  });
}
