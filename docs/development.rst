Development and automation
==========================

Local checks
------------

.. code-block:: bash

   npm ci --omit=optional
   npm run check
   npm run coverage
   npm run package

``check`` runs Prettier, ESLint, TypeScript compilation and the unit tests.
``coverage`` writes an HTML report and ``lcov.info`` under
``build/coverage/typescript``. Coverage includes unexercised extension code;
unit coverage is not evidence that the interactive VS Code UI has been tested.
None of these commands sends a model request.

``npm run smoke`` sends one real request through the authenticated local CLI
and checks the result and Markdown renderer. It uses your Copilot allowance.
Override the executable with ``ARRANGED_AGENTS_CLI_PATH`` if needed.

Use **Test Arranged Agents activation** in the Run and Debug view for an F5
activation check. A successful run writes host versions and the loaded extension
path to ``dist/scripts/extension-host-smoke-result.json``. It tests the development
extension, not VSIX installation.

Manual validation
-----------------

Install the packaged VSIX, then check:

* Activation and **Arranged Agents: Ask Copilot** in a trusted workspace.
* Question-only requests and explicit consent before including a selection.
* Markdown headings, lists, tables and fenced code in the side panel.
* Cancellation, concurrent commands, deactivation, missing/login-invalid CLI
  and invalid models.
* Blocking in an untrusted workspace and inactive HTML, links and images.

Building documentation
-----------------------

Python is only needed for documentation, not the extension:

.. code-block:: bash

   python -m venv .venv
   .venv/bin/python -m pip install -r docs/requirements.txt
   .venv/bin/python -m sphinx -n -W --keep-going -b html docs build/docs/html

On Windows, use ``.venv/Scripts/python.exe`` instead. Open
``build/docs/html/index.html`` after a successful build. Sphinx warnings fail the
build, including broken internal references.

GitHub Actions
--------------

The workflows follow the same split as
`onnx-light-viewer <https://github.com/xadupre/onnx-light-viewer>`_, adapted to this
TypeScript-only extension:

* **Tests**: pushes to ``main``, pull requests and manual runs. Installs from the
  lockfile, checks formatting/lint/tests, audits high-severity dependencies and
  packages the VSIX on Linux and Windows.
* **Nightly coverage**: daily at 03:00 UTC and manual runs. Collects TypeScript
  coverage, retains a GitHub artifact and uploads it to Codecov. Configure the
  repository in Codecov and provide the ``CODECOV_TOKEN`` repository secret;
  upload failures are reported, not ignored.
* **Weekly documentation**: Mondays at 03:00 UTC, manual runs and documentation
  pull requests. Builds strict Sphinx HTML and retains an artifact. Scheduled
  and manual failures open an issue; pull-request failures do not.
* **Release**: ``v*`` tags or published GitHub releases. Tests and packages the
  tagged source, retains the VSIX and attaches it to the GitHub release.

Actions are pinned to commits. Only release publication has write access to
repository contents, and only the documentation-failure job can create issues.
No workflow runs the authenticated Copilot smoke test.

For a release, first update ``package.json`` and ``package-lock.json`` to the
intended version, commit the change, then tag that commit with the corresponding
``v``-prefixed version and push the tag. A published GitHub release rebuilds and
replaces the asset for its tag. No workflow publishes to the Marketplace.

Unlike the reference project's native ONNX addon, this project has no
project-specific C++ binding to build. It produces a single untargeted VSIX;
there are no C++ or Python coverage jobs.

Dependency and packaging policy
-------------------------------

The project has no selected license. ``npm run package`` uses ``--skip-license``
while the package remains ``UNLICENSED``; this is a packaging policy, not a license
grant.

Keep the Zod and Azure Identity overrides until their upstream dependency chains
are safe to update. The retained development-only Azure Identity/MSAL/UUID chain
has moderate advisories; removing the Azure pin previously selected a high-severity
MSAL dependency. Reassess with ``npm audit`` before changing it, and separately
check production dependencies with ``npm audit --omit=dev --omit=optional``.
