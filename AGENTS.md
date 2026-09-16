# Project instructions

## Browser testing

- Always use the browser extension tools for browser inspection and interaction.
- Discover the existing browser tabs and use the already signed-in Job Hunters session. Do not substitute a fresh preview, isolated browser profile, standalone Playwright, or CDP session for product UI acceptance testing.
- If the user is using the tab, open a separate QA tab in the same extension-connected browser so their work is not interrupted.
- Inspect current page state before acting. Verify visible results in the browser rather than treating a successful build as UI proof.
- If the extension is unavailable, report the blocker and ask the user to connect it. Do not silently switch browser systems.
- Keep provider logins human-driven. Never inspect passwords, raw cookie values, or unrelated browser data.
- Do not start real applications merely to test the UI without explicit authorization. Label fixture-only tests and distinguish them from real end-to-end acceptance tests.
- Unit tests, typechecks, builds, and backend/VM fixture tests may use their normal tooling; browser UI testing still uses the extension.
