Getting started
===============

Requirements
------------

* VS Code 1.105 or newer.
* Node.js 22.13 or newer and npm for development.
* An installed GitHub Copilot CLI, authenticated with ``copilot login``.
* A GitHub account with Copilot access. Model requests use your allowance.

The integration has been verified with Copilot CLI 1.0.105. The SDK was matched
to CLI 1.0.104; older versions may need an update.

Launch from source
------------------

From a Bash terminal, pass the parent directory containing your repositories:

.. code-block:: bash

   ./start.sh /path/to/repositories

The launcher installs missing project dependencies, compiles the extension,
and opens a new VS Code development window. Other installed extensions are
disabled in that window. The **Arranged Agents** editor tab opens automatically.
Without a directory argument, the source checkout's parent directory is used as
the repository parent, regardless of the terminal's current directory.
The source checkout is still used for compilation.
No Copilot process is started by opening the tab.
Close the development window and rerun the script after editing the code.

The launcher chooses a desktop ``code`` executable rather than the restricted
``remote-cli`` executable. In WSL, make the Windows VS Code ``bin`` directory
available on ``PATH``. If only a remote CLI is available, use VS Code's
**Run Arranged Agents** launch configuration with F5 instead.

Choose a repository and chat
----------------------------

Trust the workspace. The right panel lists only immediate subdirectories with
a ``.git`` directory or file, including Git worktrees. It does not scan recursively
or follow directory symlinks. The left panel is intentionally empty.

Click a repository to start its Copilot session. When **Session ready** appears,
enter a message in the central panel and press **Enter** or click **Send**, for example:

.. code-block:: text

   Explain AbortController in three points and give a TypeScript example.

Use **Shift+Enter** for a new line. Responses and tool activity appear as they
arrive: commands, outputs, errors, available reasoning and session events.
All categories are visible initially. Use the checkboxes above the conversation
to hide or restore categories without changing execution or losing history.
**Event details** expands the raw metadata of tool calls and results.
Uncheck **Session / events** to hide these details as well as session messages,
while keeping commands and output visible through their own filters.

The center renders Markdown headings, lists, tables and code blocks as HTML.
It also renders inline ``$x^2$`` and display ``$$E=mc^2$$`` equations using native
MathML. No remote math assets are loaded. HTTP/HTTPS links, including plain URLs
in tool output, open in the external browser.

Switching repositories preserves each conversation and its unfinished draft.
**Refresh** rescans the parent directory while keeping sessions that still exist.
**Cancel** ends the selected repository's operation and session; click that
repository again to start a new one. Earlier messages are kept on screen as
reference, not replayed to the restarted session.

Closing the application tab or VS Code stops the CLI processes and saves the
histories, drafts, selected repository and session IDs. Reopening with the same
parent restores the transcript and draft without launching Copilot. Click a
repository to resume its existing model context.

Interrupted requests remain visible with a notice and are not resent
automatically. Pending commands and permission prompts are not continued on
resume. If the CLI's saved session is unavailable, an error is shown; **New
session** explicitly starts fresh while keeping the on-screen history for
reference, not replaying it to the model.

History is stored in private, unencrypted JSON files beneath the extension's
VS Code global storage, outside the repositories.

Configuration and remote workspaces
-----------------------------------

Set ``arrangedAgents.cliPath`` to the absolute path of your CLI if it cannot be
found on ``PATH``. This is a machine-scoped setting. Optionally select a model
with ``arrangedAgents.model``; an empty value uses the CLI default.

For Remote SSH, WSL and dev containers, the CLI must be installed and
authenticated on the machine running the workspace extension.

Install a VSIX
--------------

.. code-block:: bash

   npm ci
   npm run package
   code --install-extension ./arranged-agents-0.1.0.vsix

Alternatively use **Extensions: Install from VSIX** in VS Code. GitHub releases
created by the release workflow attach a VSIX; they do not publish to the
VS Code Marketplace. The project is currently ``UNLICENSED``.

For an installed VSIX, open a parent directory in VS Code and run
**Arranged Agents: Open** from the Command Palette. **Arranged Agents: Ask
Copilot** is retained as an alias. Automatic tab opening is limited to the
development launch.
