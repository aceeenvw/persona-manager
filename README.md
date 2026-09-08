# ⊹ PERSONA MANAGER ⊹

A prettier, mobile-first replacement for SillyTavern's native Persona Management
panel. Clicking the Persona Management drawer button opens a clean, themed modal
for browsing, organizing and editing your personas.

## Features

- **Drawer takeover** — replaces the native Persona Management panel with a themed
  modal (toggle off in settings to restore the default panel).
- **Card grid** with centered names and smaller titles over the avatars, an active indicator, lock /
  default badges, favorites, and per-card actions (edit / move / remove / delete).
- **Quick filters** for active, default, locked, favorite, and unsorted personas,
  plus **Recently used** sorting.
- **Active-persona spotlight** at the bottom: click its name or avatar to edit, with
  separate native lock controls for the current chat, character or group, and default persona.
- **Folders** (virtual), **favorites**, drag-and-drop assignment, and bulk-select
  actions (move / favorite / export / delete).
- **Full editor** — title, description with a plain token count, position / depth /
  role, connections (active-persona locks + connection avatars), lorebook binding
  (open in the World Info editor), and private notes (never sent to the model).
- **Quiet autosave feedback** shows pending changes and handoff to SillyTavern;
  native notifications report save failures.
- **Rename / duplicate / change image / set default / delete** per persona.
- **Two focused editing modes** — a true full-viewport persona editor on any screen,
  plus CodeMirror Pro's independent full-screen description editor.
- **Cards per row** (Auto / 3–10, default 6), with two columns on mobile, and
  **pagination** (10 / 30 / 60 / 100).
- **Image ratio** (1:1 / 3:4 / 4:5 / 5:4 / 4:3), saved across sessions; defaults to 4:5.
- **Backup / Restore** the whole library as a ZIP (personas + photos), and
  **Export** a selected subset from the bulk-select bar.
- **Convert a character into a persona** from the toolbar.
- **Override themes** — Native (follows your SillyTavern theme), GitHub Dark, Light,
  Dracula, Solarized Dark, and Nord. Pick from the extension settings or the in-modal
  palette button.
- **Mobile-first** — full-screen takeover, an overlay folder sidebar, a full-screen
  editor that opens automatically with a back button, responsive card density,
  touch-friendly targets, and a compact More menu for secondary actions.
- **Bilingual UI** — English and Russian.

## Installation

Install via SillyTavern's extension installer using this repository URL, or clone it
into `data/<user>/extensions/` (third-party). Then reload SillyTavern.

## Usage

Click the **Persona Management** drawer button to open the manager. Use the toolbar
to search, sort, create folders and enter bulk-select mode. Click a card to switch
to that persona; use the pencil to open the editor. Backup / Restore / Convert and
the theme picker live in the same toolbar (under More on mobile).

## Credits

Author: **aceenvw**. Licensed AGPL-3.0-or-later.
