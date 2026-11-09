# Project Overview

> After making any edit or running tests, and before ending a turn or task, check that `npm run tw` is still running, and that any server you started against a local database still is. If one has stopped, treat it as crashed — don't assume it restarts on its own — and restart it before finishing, following the Live Database rule below. Never start `npm run dev` to satisfy this check. This check is silent: don't tell the user the services are still running, and don't mention a restart either. Only bring them up if one won't stay running after a restart.

## Stack
- Node.js (Express): `server.js`
- Mongoose (MongoDB)
- EJS (Templating)
- Tailwind CSS (Styling): `src/input.css` to `public/output.css`, which this project commits
- WebSockets (ws)
- Stripe (Payments)
- Cloudflare R2 (Storage)
- Resend (Transactional email)
- Nodemon (Development)

## Scripts
- `npm run tw`: Starts Tailwind CSS watch mode.
- `npm run dev`: Starts the server with nodemon. Read the Live Database rule first.
- `npm run watch`: The same, restarting only for changes in the server code. Read the Live Database rule first.
- `npm start`: Starts the server without nodemon. Read the Live Database rule first.
- `npm run make-admin`: Makes an account an admin. It uses `.env`, so it acts on the live database.

## File and Folder Structure
**Hard rule:** Whenever you create, move or edit files, follow this layout. Put new code where it says, even if the project doesn't have that folder yet. If something has no place here, ask before adding a new top-level folder. Don't move existing files as a side effect of other work unless the user asks.

```
grabbn/
├── server.js            App setup, WebSocket server, facades list, startup jobs, startup route map
├── serve.js             One line that imports server.js, kept until the host's start command is confirmed
├── AGENTS.md, readme.md
├── package.json, nodemon.json, .env, .gitignore
├── .vscode/tasks.json   Runs `npm run tw` and `npm run dev` on folder open: don't allow it here, see the Live Database rule
├── config/              config.js holds credit rules and limits; locales/ holds the translations
├── models/              Mongoose models, one per file
├── routes/
│   ├── public.js        Public pages, mounted at /
│   ├── app.js           The app and its sign-in pages, mounted at /
│   ├── admin.js         Admin pages, mounted at /admin, and the admin API, mounted at /api/admin
│   ├── api.js           JSON API, mounted at /api, and the bookmarklet session, mounted at /api before CORS
│   └── webhooks.js      Stripe webhooks, mounted at /api before express.json()
├── middleware/          Express middleware: visitor sessions and admin sessions
├── services/            Shared logic and outside services (email, storage, link previews, credits, translations, WebSocket registry)
│   └── jobs/            Scheduled jobs that rebuild repositories and explore scores
├── views/
│   ├── partials/        Shared by public and app pages: layout, layout-end, sidebar, topbar
│   ├── public/          Public pages, with their own partials in public/partials/
│   ├── app/             App pages, with their own partials in app/partials/ and sign-in pages in app/auth/
│   └── admin/           Admin pages, with their own partials in admin/partials/
├── src/input.css        Tailwind source, the only CSS file to edit
├── public/
│   ├── output.css       Built by Tailwind and committed: never edit it by hand
│   ├── landing.html, popup.html
│   ├── js/              Browser scripts
│   └── data/            categories.json, read by the browser and by services/categories.js
├── clients/extension/   The browser extension
├── scripts/             Scripts run by hand. Only make-admin has an npm script
└── dev_resources/       Git-ignored and internal: journal, tasks, commit message, plans, drafts, one-off scripts, source images
```

- **Routes:** Add each route to its section's file, with a line in that file's `router.routes` list (`{ method, path, label }`). No routes in `server.js`, and no new route file per feature. Logic that several routes share, or that calls an outside service, goes in `services/`.
- **Route order:** Express tries routes in order, so keep a fixed path like `/buckets/bulk` ahead of `/buckets/:name`. In `server.js`, the Stripe webhooks stay before `express.json()`, because their signatures are checked against the raw body, and the bookmarklet session stays before CORS, because any site can call it.
- **Built CSS:** Commit `public/output.css` with any change that adds or removes classes. `npm run build` does nothing, so the host relies on the committed file.
- **Folder names:** No `utils/`, `lib/` or `helpers/`. Helpers go in `services/`, or in `middleware/` if they handle a request.
- **Views:** Every page goes in its section's folder, never directly in `views/`. The folder already says the section, so name files for what they show. A section's own partials go in `views/<section>/partials/`.
- **Local-only files:** Notes, screenshots, logs, prompts, one-off scripts and source images go in `dev_resources/`, not the project root.
- **Instruction files:** `AGENTS.md` is the only one. No `CLAUDE.md` or `.claude/` folder.

## Live Database (hard rule)
This project is live. Its `.env` points at the hosted Atlas database, and startup runs jobs that delete anonymous users and their buckets, so `npm run dev`, `npm run watch` and `npm start` all act on live data.

- Never boot the server with `.env` as it is, and never test against the live site or read its database without the project lead's approval.
- `.vscode/tasks.json` runs `npm run dev` when the folder opens, so don't allow automatic tasks for this folder.
- The scripts in `scripts/` read `.env` too, so they also act on live data. `scripts/seed.js` adds fake curators and buckets, and with `SEED_WIPE=true` it deletes every bucket that has links, plus all link clicks, topic scores and subscriptions.
- To test, set every variable named in `.env` in the environment first: `MONGODB_URI`, `ATLAS_URL` and `MONGODB_URI_SAMPLE` to `mongodb://127.0.0.1:27017`, `MONGODB_DB` to a throwaway name, and placeholders for the rest. Run `node <path to project>/server.js` from a folder with no `.env`, because `server.js` calls `dotenv.config()`. Confirm the override took effect before booting.

## Git Rules

- Always work directly on the current branch (`master`). Never create, switch to, or use a git worktree or a separate branch unless explicitly told to by the user.
- Never pass `isolation: "worktree"` when spawning subagents.
- Do not commit or push unless the user explicitly asks.

## Tailwind UI Rules

- Buttons must use Flexbox centering: always include `flex items-center justify-center` on button elements.
- Border radius is capped at `rounded-md`. Never use `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-3xl`, or `rounded-full` anywhere in the UI.


---

## Agent Instructions for this Project

**Direct File Manipulation via Internal Tools**

When interacting with this project, you are equipped with internal tools (such as `python` and `terminal`) that have direct access to the project directory: `F:\trifoldi\projects\grabbn`.

**Guidelines:**

1. **Prefer Tools over Manual Copy-Paste:** Do not ask the user to copy, paste, or run long code blocks in their terminal if you can accomplish the task using your internal tools.
2. **File Management:** Use your tools to:
   - **Create** new files (e.g., using `python` to write content).
   - **Update/Edit** existing files by overwriting them with the full updated content.
   - **Read** files to understand the current project state.
   - **Delete** files or directories when requested.
3. **Path Management:** Always ensure you are targeting the correct directory (`F:\trifoldi\projects\grabbn`) when executing commands to avoid creating files in the wrong workspace.
4. **Directory Restriction (hard rule):** You may not create, edit, or delete files at any path outside `F:\trifoldi\projects\grabbn`. This holds even if the harness/tool defaults to a different working directory — redirect every file operation back to this project's directory rather than letting it fall through to the default. If a requested change would require touching a path outside this directory, stop and ask instead of proceeding.

**Goal:** Minimize friction for the user by performing file-system operations directly through your interface rather than requesting manual input.

5. **Screenshot Restriction (hard rule):** For the following projects — ozsdiaries, storiesbyshews, jarumiristudios, wapdooz, whimish, allthingsaprons — you are not allowed, under any circumstances, to take screenshots of the UI while working. If a screenshot seems necessary to verify or debug something, stop and explicitly request permission from the user before taking it.

6. **Journal Entries (hard rule):** When adding a new entry to this project's journal (`dev_resources/journal.md`, via the Dispatch dashboard's Journal tab), each individual entry must not exceed 150 characters. Write one entry per feature or change, not one per part of it: a feature with its settings, prompts and tests is a single entry. If it doesn't fit in 150 characters, describe it at a higher level instead of splitting it up; the details belong in the commit message. Only log what will be useful to someone reading the journal later: what changed, why, and any decision or gotcha that isn't obvious from the code. Leave out word lists, examples, test counts, lists of files (the file report covers those) and steps that were undone or redone in the same session. Before adding an entry, read today's entries and skip anything one of them already covers.

7. **Journal Upkeep (hard rule):** After any significant update to the project, add entries to this project's journal before ending the turn. Significant means things like a new feature or page, a model, route or data change, a recorded client decision or requirement, or a convention, tooling or config change. Trivial edits (typos, small copy or style tweaks) don't need an entry. Add entries through the Dispatch dashboard: its Journal tab, or `POST http://localhost:3000/api/project-folders/grabbn/journal` with JSON `{ "content": "..." }`. It files each entry under today's date with the time. If the dashboard isn't running, write them by hand in the same format: a `## YYYY-MM-DD` heading, then `- **HH:MM** — text` bullets. Follow rule 6 for what goes in an entry and its 150-character limit, and say what changed and why in plain words.

8. **Task Completion Reporting (hard rule):** Only the user marks tasks in `dev_resources/tasks.json` as done. Never mark a task done or archive it yourself (don't change its `done` or `archived` fields, through the project hub or by editing the file). Instead, whenever you believe you've completed a task, report it to the user in your reply, so they can mark it done and finished tasks don't stay open. Give the task's ID and title, what you did, and how you checked it works. If you finished only part of a task, say what's still left.

9. **Push Commit Message (hard rule):** Every time you add an entry to this project's journal, also create or update `dev_resources/commit_message.txt` before ending the turn. The Dispatch dashboard's Push button commits with this file's text, so it must cover everything done since the last push, not just your latest change. If the file doesn't exist, create it. If it does, keep what's already in it and add the new work. Write it as a git commit message: a summary line of 72 characters or fewer that covers all of the work in the file, then a blank line, then one `- ` bullet per change saying what changed and why in plain words. Rewrite the summary line whenever it no longer covers everything. Never stage, commit or push this file yourself: the dashboard leaves it out of every commit and deletes it once a push has used it, so the next journal entry starts a fresh one.

10. **Journal File Reports (hard rule):** Every journal entry you add must also report the files its work created, modified or deleted, as paths relative to this project's folder with forward slashes. The Dispatch dashboard lists each day's files under that day's entries, so this is what keeps a day's changes traceable. With the dashboard running, send them with the entry: `POST http://localhost:3000/api/project-folders/grabbn/journal` with JSON `{ "content": "...", "files": { "created": ["..."], "modified": ["..."], "deleted": ["..."] } }`, leaving out any list that would be empty. When the `CLAUDE_CODE_SESSION_ID` environment variable is set, also send it as the `X-Agent-Session` header, so the entry's record keeps which Claude Code session wrote it. When writing the journal by hand, put them under the entry as sub-bullets indented two spaces, one line per kind: ``- Created: `path/one.js`, `path/two.js` ``, then ``- Modified: ...`` and ``- Deleted: ...``. List each file under the entry for the change that touched it. The 150-character limit is for the entry's text, not its file list.

11. **Tasks (hard rule):** This project's to-do list is `dev_resources/tasks.json`, shown in the Dispatch dashboard's Tasks tab. Whenever something needs doing later (a follow-up, a known bug, something left out of the current work), add it there as a task, not as a TODO comment, a Markdown note or anywhere else. With the dashboard running, use its API: `POST http://localhost:3000/api/project-folders/grabbn/tasks` with JSON `{ "title": "...", "description": "...", "dueDate": "YYYY-MM-DD", "tags": ["..."] }`. Only the title is required (80 characters at most); the description is limited to 500 characters and each tag to 30. When the `CLAUDE_CODE_SESSION_ID` environment variable is set, also send it as the `X-Agent-Session` header, as for journal entries. Never edit `tasks.json` by hand: the dashboard gives each task its ID and records who created it. If the dashboard isn't running, say so and ask instead of writing the file. Marking tasks done or archiving them is the user's alone (rule 8, Task Completion Reporting).
