# Third-Party Notices

This portable package contains iLab CONJURE, CPython for Windows, Bun, Node.js,
Python packages installed from `requirements-webui.txt`, the Playwright Core
runtime, and a prebuilt WebUI JavaScript bundle that includes frontend npm
packages from `package-lock.json`.

## CPython

The embedded Python runtime is distributed by the Python Software Foundation.
See the Python license documentation included with the runtime and the upstream
license information at:

https://docs.python.org/3/license.html

## Bun

The Bun runtime is distributed under the MIT license. See the upstream license
at:

https://github.com/oven-sh/bun/blob/main/LICENSE.md

## Node.js

The Node.js runtime is distributed under the MIT license and includes software
under compatible third-party licenses. The package includes the exact upstream
license text for its bundled Node.js version as `NODEJS-LICENSE`.

## Playwright Core

Playwright Core is distributed under the Apache License 2.0. Its package and
license file are included under `chatgpt-bridge/node_modules/playwright-core/`.

## Python packages

The packaging workflow installs the WebUI dependencies listed in
`requirements-webui.txt`. The build script writes a frozen dependency list to
`python-requirements.lock.txt` in the package root.

Review each dependency's license before redistributing modified packages or
using the bundle in a commercial environment.

## Frontend npm packages

The WebUI JavaScript bundle is built from `package.json` / `package-lock.json`.
It currently includes Konva for the layered input-image editor. Konva is
distributed under the MIT license; review the lock file and upstream package
metadata before redistributing modified bundles.

## iLab CONJURE

iLab CONJURE is licensed under GNU AGPLv3. See `LICENSE` in the package.
