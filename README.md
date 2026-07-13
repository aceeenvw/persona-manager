# ⊹ PERSONA MANAGER ⊹

A prettier, mobile-first replacement for SillyTavern's native Persona Management
panel. Clicking the Persona Management drawer button opens a clean, themed modal
for browsing, organizing and editing your personas.

## Features

- **Drawer takeover** — replaces the native Persona Management panel with a themed
  modal (toggle off in settings to restore the default panel).
- **Card grid** with avatar tiles, an "Active" pill on the current persona, lock /
  default badges, favorites, and per-card actions (edit / move / remove / delete).
- **Quick filters** for active, default, locked, favorite, and unsorted personas,
  plus **Recently used** sorting.
- **Active-persona spotlight** with live lock toggles (chat / character / default).
- **Folders** (virtual), **favorites**, drag-and-drop assignment, and bulk-select
  actions (move / favorite / export / delete).
- **Full editor** — title, description with a token-budget bar, position / depth /
  role, connections (active-persona locks + connection avatars), lorebook binding
  (open in the World Info editor), and private notes (never sent to the model).
- **Rename / duplicate / change image / set default / delete** per persona.
- **Duplicate-description warning** for exact matches, shown without blocking edits.
- **Two full-screen modes** — maximize the editor panel, and a per-description
  full-screen that coexists with CodeMirror Pro.
- **Grid size** (small / medium / large) and **pagination** (10 / 30 / 60 / 100).
- **Backup / Restore** the whole library as a ZIP (personas + photos), and
  **Export** a selected subset from the bulk-select bar.
- **Convert a character into a persona** from the header.
- **Override themes** — Native (follows your SillyTavern theme), GitHub Dark, Light,
  Dracula, Solarized Dark, and Nord. Pick from the extension settings or the in-modal
  palette button.
- **Mobile-first** — full-screen takeover, an overlay folder sidebar, a full-screen
  editor with a back button, responsive card density, touch-friendly targets, and
  a compact More menu for secondary actions.
- **Bilingual UI** — English and Russian.

## Installation

Install via SillyTavern's extension installer using this repository URL, or clone it
into `data/<user>/extensions/` (third-party). Then reload SillyTavern.

## Usage

Click the **Persona Management** drawer button to open the manager. Use the toolbar
to search, sort, create folders and enter bulk-select mode. Click a card to switch
to that persona; use the pencil to open the editor. Backup / Restore / Convert and
the theme picker live in the modal header.

## Credits

Author: **aceenvw**. Licensed AGPL-3.0-or-later.
