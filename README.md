# nitpicker

A Claude Code mod that adds a picky QA pass to your workflow. When the main agent finishes a turn that changed files, a reviewer agent builds and runs the app, looks at it (screenshots, a headless browser, tmux, whatever fits), compares it against the reference or the previous version, and writes a terse numbered list of nitpicks:

```
1. ui parity in the settings modal is effectively non existent
2. hover does not show up in settings
3. margins are very weirdly done (see /tmp/nitpick/margins.png)
4. stutters when loading images / new messages (make async?)
5. jump to latest isnt centered
```

The list goes back to the main agent as a prompt to fix what is real, and the reviewer checks again, up to 3 rounds per prompt. A clean review ends with an LGTM toast.

The reviewer never edits your project: its edits inside the project and git commands that change the repository (stash, checkout, reset, commit, ...) are refused. To look at an older version it uses `git worktree add` under `/tmp`. It keeps per-project notes (how to launch the app, what the reference is) in its agent memory under the project's `.claude/` folder.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install nitpicker --marketplace torisetxd/nitpicker
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install nitpicker --marketplace torisetxd/nitpicker
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `torisetxd/nitpicker`, then Add plugin.

## Use

It is off by default in every project.

| Command | What it does |
| --- | --- |
| `/nitpick on` / `/nitpick off` | Turn automatic reviews on or off for the current project |
| `/nitpick now [focus]` | Run one review now, e.g. `/nitpick now check the settings modal` |
| `/nitpick mode ask` | Put the nitpicks in your prompt box to edit and send yourself (`mode auto` sends them straight to the main agent) |
| `/nitpick rounds <n>` | Automatic rounds per prompt before it stops (default 3) |
| `/nitpick reset` | Clear the round count and earlier nitpicks |
| `/nitpick` | Show the current status |

If you send your own prompt while a review is running, your prompt wins: that review is shown to you but not sent.

The main agent can also call the reviewer itself as the `nitpicker:reviewer` agent type.

## Notes

- Each round is a full agent run on your session's model, so several rounds add up.
- For desktop GUI apps the reviewer needs a screenshot tool (grim, spectacle, gnome-screenshot, ImageMagick `import`) and ideally xdotool, ydotool or wtype to drive input. Without them it falls back to code and logs and says what it could not check.
- A turn counts as having changed files when it used Edit, Write or NotebookEdit, or a shell command that looks like a write (`sed -i`, a redirect into a project file, `git commit`, ...).
- The reviewer's instructions are `REVIEWER_PROMPT` near the top of `hooks/register.ts`; edit them to change its taste.
