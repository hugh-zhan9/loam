<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Loam app icon" width="128" height="128">
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

# Loam

**A local-first Markdown workspace for macOS, where raw notes settle into knowledge.**

Loam is soil that grew from something — leaf litter and mineral, layered, the upper
layer feeding what comes out of it. That is the shape of this app: notes are kept as
plain Markdown files you own, and two layers sit on top of them. An LLM wiki turns
raw material into linked articles; a memory library turns it into conclusions that
agents can read. Nothing is stored in a format you cannot open in another editor.

Markdown files are the only thing on disk that matters. Everything else — layout,
tabs, drafts, memory — is derived, and lives beside the app rather than inside your
notes.

## Two windows

- **Workspace** — opened by launching Loam, restoring the last folder, or opening a
  folder. One root, a list of notes, tabs, outline, search, and the knowledge
  features.
- **Document** — opened when Finder or “Open With” hands over a single `.md` /
  `.markdown` file. Just the editor and that document's outline: no file tree, no
  tabs. It is not driven by `loam-cli` and does not restore the last workspace.

Only `.md` and `.markdown` are opened and listed.

## The workspace

Three columns, left to right:

1. **Rail** — note groups with counts, and the file tree. The tree can be pointed at
   one folder (`raw/`, say) and the note list and counts follow it.
2. **Note list** — every note as a card: title, two-line excerpt, relative time,
   newest first. Paged as you scroll, so a folder with tens of thousands of notes
   opens as fast as one with ten. Right-click for Finder, path, or trash.
3. **Editor** — with an outline panel that can be collapsed.

Rail and list widths are independent and persist per workspace, as does which
folder the tree is pointed at.

## Editing

One document, two faces, switched with **⌘⇧M**:

- **Visual** — the rendered document, edited in place (Milkdown/ProseMirror).
- **Source** — the Markdown itself (CodeMirror), same file, same selection.

What the editor speaks: headings, lists, tables, footnotes, callouts, frontmatter,
task lists, inline and block math (KaTeX), Mermaid diagrams, wikilinks
(`[[target|alias]]`), and images pasted or dropped in.

Details that took some deciding:

- **Links** open with **⌘ + click**, and the pointer only becomes a hand while ⌘ is
  held. A plain click puts the caret in the label, because a link's text is text
  someone will want to fix. With the caret inside a link, a field appears holding
  its address — the half of `[label](address)` a rendered document hides.
- **A drawn Mermaid diagram puts its own fence away.** The source comes back when the
  caret is inside the block, and clicking the diagram is what puts it there. A
  diagram that failed to draw always keeps its source on screen.
- **⌘A inside a code block takes the code**; press it again for the whole note.
- **PDF is the system print dialog** acting on the rendered document. There is no
  second renderer, so an exported page cannot disagree with what you were editing.

## Knowledge

### LLM wiki

For workspaces that keep raw material under `raw/`: ingest a file, digest a topic,
lint the result, query it. Runs against an OpenAI-compatible endpoint you configure
in Settings → LLM. Available in the Workspace window and over the CLI socket.

### Memory

Two layers, and the distinction is the whole feature:

- **Material** is what happened — a decision, a finding, a piece of a conversation —
  kept as written, with its source, asserting nothing.
- **Conclusions** are what you read out of the material. They cite it, start as
  candidates, and only reach an agent's context once adopted through a gate that
  wants supporting evidence and no standing counterexample.

Turning it on takes one online step: the panel downloads an embedding model
(`minishlab/potion-multilingual-128M`) into `~/.loam/models/`. Writing and semantic
search both use it, and there is no degraded mode — without the model a write is
refused rather than quietly turned into keyword matching. After the download it runs
offline.

Using memory yourself needs nothing else. Letting Claude Code, Codex or Cursor read
it is a separate, opt-in step (Memory → Agent integration) that installs a skill,
hooks, and an MCP server pointing at the bundled `loam-mcp`.

Full guide: [docs/memory-usage.md](docs/memory-usage.md).

**Status, honestly:** storing material and semantic search are proven against the
real model on a real library — 1020 pieces of material, written and retrieved by
rank, with the new entry coming back first. The conclusion half —
`distill` → `gate` → `adopt` — is implemented and unit-tested but has not been run
against the model end to end, so nothing has reached an agent's context that way
yet.

`delete` hides an entry; `purge` removes it and gives the file's pages back, which
is the one irreversible operation here.

## Appearance

Ten built-in themes — three light (system, paper, graphite), two more light
(daylight for maximum contrast, celadon for a cool light that is not grey), three
dark (system, midnight, ink) and two more (cocoa, a dark with no blue in it, and
obsidian, near-black at maximum contrast) — plus **follow the system**.

The shirt icon on the title bar opens appearance, where you can also **make a theme**:
ten colours, each starting from the theme already on screen, saved as a plain `.css`
file in `~/.loam/themes/`. That file is written against the same public contract a
hand-written theme uses (`--mdx-theme-*`, documented in
[docs/loopx/specs/theme.md](docs/loopx/specs/theme.md)) and read back by the same
parser — so a theme made in the app can be edited by hand, and one written by hand
opens in the app. A theme is data: selectors, `@import` and `url()` are never
extracted from it.

Below the themes you can put a **background image** behind the document. It sits on
the document's pane only — the sidebar and the title bar keep their solid colour,
because small dense text is the first thing to stop being readable over a picture —
and a slider decides how much of it shows. Fading it lays the theme's own background
colour back over the image rather than fading the text, so body text keeps the
contrast the theme gave it and the same picture darkens on its own under a dark
theme. The file is copied into `~/.loam/background/`, so moving or deleting the
original changes nothing, and it is left off the page when you print. It is
deliberately **not** a theme property: a theme cannot load anything, which is what
makes an unfamiliar one safe to try.

## Where things are kept

| Path | What |
| --- | --- |
| `~/.loam/state.json` | window size, tabs, panel widths, which folder the tree shows |
| `~/.loam/drafts/` | unsaved bodies as plaintext, deleted on save, expired after 30 days |
| `~/.loam/themes/` | your own themes |
| `~/.loam/background/` | the background image, one at a time |
| `~/.loam/models/` | the embedding model |
| `~/.loam/memory/palace.db` | one memory library for every workspace, separated by project |
| `~/.loam/assets/` | fallback for images with nowhere better to go |
| `~/.loam/cli.sock` | the socket `loam-cli` talks to |
| `<workspace>/.assets/` | images pasted into a note |
| `<workspace>/.loam/` | this workspace's memory configuration |

Memory follows the machine, not the repository: cloning your notes elsewhere does not
bring it. Export a bundle to move it.

## CLI and MCP

`loam-cli` drives the running Workspace window over `~/.loam/cli.sock`:

```bash
loam-cli new | list | open <path> | focus | save | close
loam-cli content | selection | insert <text>
loam-cli create-file <dir> [name] | create-folder <dir> <name> | rename <path> <name>
loam-cli llm-wiki status | ingest <raw-path> | digest --title "..." <prompt...>
loam-cli llm-wiki lint | query <question...> | search <query...>
loam-cli serve --workspace <workspace> --port 14243
```

Memory also runs headlessly, against a workspace rather than a window:

```bash
loam-cli memory --root <workspace> init | status | doctor | model | reindex
loam-cli memory --root <workspace> add --body "..." | --file <path> | --stdin
loam-cli memory --root <workspace> show | list | delete | purge [--before <iso>]
loam-cli memory --root <workspace> search | context | brief | recall <query...>
loam-cli memory --root <workspace> distill | gate | adopt | demote | promote
loam-cli memory --root <workspace> capture | legacy-import | export | import
loam-cli memory --root <workspace> agent setup [--all|--claude|--codex|--cursor] [--dry-run]
```

Every command's own `--help` is the authority; this list is a map, not a contract.
MCP for agents:

```bash
loam-mcp --workspace <workspace>
```

Packaged builds carry `loam-cli` and `loam-mcp` as sidecars, at
`/Applications/Loam.app/Contents/MacOS/`.

## Build

```bash
npm install
npx tauri dev        # desktop, with the renderer's dev server
npm run dev          # renderer only, for UI debugging — not a web product
npx tauri build      # a signed-to-nothing .app and .dmg
./scripts/build-install.sh  # build the .app and replace /Applications/Loam.app
npm run build:install  # invoke the same shell script
npm run build:app      # build the .app only
npm run install:local  # install an already-built .app
```

`scripts/install-local-app.mjs` stages, signs, and verifies the new bundle before replacing the installed app. Save your edits and close Loam before installation; a running app or signing failure stops installation and leaves the old app in place. Successful installation prints the previous bundle’s backup path; documents and application data are outside the replacement. `LOAM_BUILT_APP` and `LOAM_INSTALL_APP` override the source and destination. Run `open /Applications/Loam.app` after installation.

Adding a theme to `app/globals.css` needs the renderer's cache cleared —
`rm -rf .next` — because Turbopack re-emits edited rules on a hot reload but does not
re-resolve the `@plugin` invocations a palette is declared with.

## Verification

```bash
npm run lint
npm run test
npm run audit:editor:boundaries
cd src-tauri && cargo test
```

The boundary audit is the one worth knowing about: it fails if product code imports
Milkdown, ProseMirror or CodeMirror directly, queries editor-private DOM, or deep
imports the editor package. The editor is reachable through one entry point and one
pinned command vocabulary, which is what let the editor underneath it be replaced
without the product noticing.

## Architecture

- **Frontend** — Next.js 16, React 19, TypeScript, Tailwind CSS 4 with daisyUI
- **Desktop shell** — Tauri 2, Rust
- **Editor** — Milkdown/ProseMirror for the visual surface and CodeMirror for source,
  behind one adapter in `packages/mdx-editor/`; Markdown is the only persisted form
- **Highlighting** — Prism
- **Memory** — mempal, an embedded library with its own SQLite schema
- **Tests** — Vitest for the frontend, `cargo test` for everything Rust owns

The frontend owns workspace state, tabs, outline parsing, panel sizing and the editor
integration. Rust owns file-system access, app state, image assets, trash, the CLI
socket, the LLM wiki pipeline and the memory library.

## Scope

macOS only. One root per workspace. No web product, no Quick Look extension, no
auto-update, no full-text search inside PDFs or images.

## License

MIT; see [LICENSE](LICENSE).
