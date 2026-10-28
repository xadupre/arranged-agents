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

From a Bash terminal in the checkout:

.. code-block:: bash

   ./start.sh

The launcher installs missing project dependencies, compiles the extension,
and opens a new VS Code development window. Other installed extensions are
disabled in that window. It does not send a model request automatically.
Close the development window and rerun the script after editing the code.

The launcher chooses a desktop ``code`` executable rather than the restricted
``remote-cli`` executable. In WSL, make the Windows VS Code ``bin`` directory
available on ``PATH``. If only a remote CLI is available, use VS Code's
**Run Arranged Agents** launch configuration with F5 instead.

Ask a question
--------------

Trust the workspace, then run **Arranged Agents: Ask Copilot** from the Command
Palette. Enter a question such as:

.. code-block:: text

   Explain AbortController in three points and give a TypeScript example.

If the editor has selected text, explicitly choose **Include selection** or
**Question only**. Dismissing the consent dialog sends nothing. The answer
opens in a side panel, with headings, lists, tables and code blocks rendered
from Markdown. Cancel a running request through the progress notification.

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

   npm ci --omit=optional
   npm run package
   code --install-extension ./arranged-agents-0.1.0.vsix

Alternatively use **Extensions: Install from VSIX** in VS Code. GitHub releases
created by the release workflow attach a VSIX; they do not publish to the
VS Code Marketplace. The project is currently ``UNLICENSED``.
