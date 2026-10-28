Features and safeguards
=======================

Current features
----------------

* Open a three-panel editor tab: repository activity left, chat center and repositories right.
* Browse issues, PRs, your comments and later responses, and recent local commits.
* Highlight your issues/PRs and flag participation and responses after your latest reply.
* Find direct @mentions you have not answered with the Mentions button.
* Open issues, PRs, comments and GitHub-backed commits in the external browser.
* Discover immediate child directories containing ``.git``, including worktrees.
* Start each repository's session lazily when clicked.
* Group active repository sessions in the first box, above other repositories.
* Preserve independent conversation histories and drafts while switching repositories.
* Render Markdown and inline/display LaTeX equations as HTML with native MathML.
* Open the Settings page to choose the CLI executable, model and request timeout
  (one hour by default).
* Cancel a request and report visible CLI/model errors.
* Send independent parallel questions/actions while tools run, enabled by default.
* Switch Parallel OFF to queue messages for the main agent after current work.
* Show activity icons during startup and generation, including background sessions.
* Distinguish open sessions with a tinted repository background and solid indicator;
  active work uses a different tint and spinner, independently of selection.
* Resize panels by dragging their dividers or using the left/right arrow keys.
* Automatically approve file reads and read-only Git/GitHub tools; remember URL-root consent.
* Send with Enter, insert new lines with Shift+Enter and open HTTP/HTTPS links.
* Display live messages, commands, tool results, available reasoning and session events.
* Toggle information categories above the chat without discarding history or affecting tools.
* Save histories and drafts locally, stop on close and resume saved sessions lazily.
* Right-click a repository to close, start fresh or delete its latest/all sessions.
* Generate an evidence-linked PostMortem table for the full selected conversation.
* Export its coherent-stage analysis and complete source transcript as JSON.

Messages are limited to 20,000 characters. Parallel requests receive up to 80,000
characters of visible conversation context. The UI does not automatically include
editor selections or file contents.

Data boundaries
---------------

No workspace files are attached automatically. Each clicked repository is the
working directory of its own CLI client and session. Configuration discovery,
skills, on-demand instructions and host Git context are enabled. The native
Copilot system instructions are preserved; only response formatting guidance is
appended. Repository file hooks and cross-session store integration stay disabled.

Built-in tools can read files, execute commands (including ``gh`` for pull
requests) and edit files. Local file reads, HTTPS reads from ``github.com``,
``raw.githubusercontent.com`` and ``api.github.com``, read-only GitHub MCP tools,
and shell commands classified as read-only by the CLI's parser are automatically
approved. Every command in a shell pipeline or compound command must be read-only;
file-write redirection and unclassified commands still require confirmation.
Shell URL destinations must also be GitHub roots or previously approved roots.
Repository-changing Git/GitHub actions are not automatically approved.

Other HTTP/HTTPS reads require explicit consent for the URL's root (scheme,
hostname and port). **Allow <root> and remember** saves that approval across
sessions and repositories. Review or remove saved roots under
**Arranged Agents: Approved Url Origins** in Settings. Different schemes,
subdomains, ports and redirect destinations require their own approval.
Rejections are not saved. Sandbox escalation, warnings and managed requests
requiring human approval always remain manual, even for an approved root.

Remaining tool permission requests appear directly in the
conversation panel with repository/operation details and **Allow once** / **Reject**
choices. Commands, paths, proposed changes and sandbox warnings are presented
readably; raw JSON is available only through the technical-events filter.
Copilot's questions use inline choice buttons and optional free-text answers,
not JSON payloads. They do not open modal dialogs, issue notification sounds, take keyboard
focus or disappear when display filters are unchecked. Requests from background
repositories also remain visible. Cancellation or closure rejects pending requests;
no pending request is approved on cancellation or closure. Relevant file/tool results may be sent to Copilot; normal CLI
authentication and GitHub access rights apply.

The application's own script is authorized by a CSP nonce; model responses
cannot introduce scripts. Raw HTML is escaped and images are not loaded.
HTTP/HTTPS URLs open externally through VS Code after host-side validation;
executable and local-file schemes are rejected. Tool output is escaped plain
text with safe URL detection, not interpreted as Markdown or HTML.
Math rendering disables trusted TeX commands.
Only packaged UI resources are available, without remote fonts or scripts.

The log displays events and readable reasoning supplied by the CLI; it cannot
expose reasoning or tool information that the CLI does not emit. Only messages
and concise tool summaries are enabled by default. Tool input deltas are grouped
as technical events; raw fragments in older saved histories are also hidden by
default. Reasoning, output, technical events and timestamps are
opt-in, while errors remain visible. Raw tool event
metadata is available under **Event details**, also hidden by the
**Session / events** filter. Visibility filters only affect
display, not execution, permissions, pending questions or retained conversation context.

Workspace Trust is required. The CLI's normal session persistence and GitHub's
service-side policies still apply; disabling session-store integration is not a
promise that no CLI state is written.

Lifecycle
---------

Startup and each response have a two-minute deadline. Cancellation or an error
stops that repository's CLI process; other repository sessions are unaffected.
Click the stopped repository to start a fresh session. Earlier messages remain
visible with a restart notice but are not replayed as context.

Closing the tab, removing a repository from the refreshed list or deactivating
the extension stops the affected clients, including requests still starting.
Normal tab/window closure flushes the history and drafts after shutdown.

Reopening with the same parent restores the selected repository, histories and
drafts without launching any CLI process. Clicking a saved repository resumes
the same SDK session and its model context. Interrupted operations are marked,
not replayed; pending tools and permission prompts are not continued. A failed
resume is reported rather than silently replaced with a new session. **New
session** provides an explicit fresh start, retaining the visible transcript
without sending that old transcript to the new model session.

Versioned JSON snapshots are stored per parent in the extension's VS Code global
storage with atomic, serialized writes. On POSIX, the directory is private and
files use mode 0600. These files contain plaintext conversations, tool output and
drafts; they are not encrypted, synced or included in the repository. Damaged or
unsupported snapshots fail visibly instead of being silently discarded.

Repository session menu
-----------------------

Right-click a repository, or focus it and press Shift+F10, for these actions:

* **Close session** stops its CLI without deleting history or resumable context.
* **New session** archives the current conversation and starts a blank session.
* **Delete latest session** permanently deletes the current conversation and
  restores the previous archived conversation, if any, without starting Copilot.
* **Delete all sessions for this repository** deletes its current and archived
  conversations managed by Arranged Agents.

Deletion requires inline confirmation, not a modal popup. It removes both local
application history and the corresponding saved Copilot sessions through the
official SDK API. Other repositories, unrelated Copilot sessions and repository
files are not affected. If deletion fails midway, successfully deleted histories
stay deleted, while remaining histories are retained with a visible error for retry.
Session-management actions flush the saved snapshot immediately.

Known limitations
-----------------

There are no automatic editor attachments or Marketplace publication. Model
context resumption depends on the CLI's own saved session still being available.
A crash can lose changes since the latest periodic save; normal closure flushes
pending writes. Multiple windows sharing a parent use the same snapshot, with
the last save taking precedence. Existing windows running an older extension
version cannot migrate their in-memory transcripts automatically.

The activity sidebar is read-only and uses the selected repository's GitHub CLI
authentication, independently of Copilot. Issues/PRs show open discussions in
pages of 20; Comments combines pages of discussions you commented on or reviewed,
including closed ones. The full comment/review histories of each returned
discussion are paginated to compute participation and later responses accurately.
Submitted reviews and inline review comments count as participation; pending
reviews do not. Editing an older comment is not a new response. These flags compare
timestamps, not whether you have read a response. Use Refresh to fetch new activity;
there is no background polling. Mentions shows direct username pings in descriptions,
comments and reviews without a subsequent response from you in the discussion,
including closed issues/PRs. Team mentions and your own pings are excluded.
GitHub search indexing can delay the Comments and Mentions feeds,
and its normal result limit applies.

Commits shows the latest 30 commits of the current local branch, including
unpublished commits. Links use the GitHub origin (or first fetch remote);
unpublished hashes may not exist on GitHub until pushed. Without a GitHub remote,
local commits remain visible with an explicit notice and no link. Missing CLI,
authentication, permissions, rate-limit and API errors are displayed in the sidebar,
not replaced with an empty result.

Automated tests cover rendering, prompts and real SDK subprocess lifecycle
using an explicit local CLI fixture. A real authenticated CLI model request and
VSIX installation have passed locally. These checks do not replace interactive
extension-host validation of Workspace Trust, deactivation and visual layout.
Application tests cover repository discovery and isolated persistent SDK sessions;
DOM tests execute the compiled chat UI. See :doc:`development`.
