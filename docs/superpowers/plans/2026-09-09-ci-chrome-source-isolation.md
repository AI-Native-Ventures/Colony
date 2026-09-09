# CI Chrome source isolation

Acceptance: GitHub-hosted Ubuntu dependency installs stop consulting the unrelated Google Chrome repository. Preserve every other source and all APT/Playwright exit statuses, signatures, hashes, retries and installation gates. No actual local APT or build commands.

1. Add one shared preflight with explicit hosted-runner and Ubuntu guards. Match exact Chrome repository URIs, comment only matching one-line entries, disable Chrome-only deb822 stanzas, and reject ambiguous mixed stanzas before writing anything.
2. Call it before both existing dependency retry loops. Propagate preflight failures without a fallback that masks them.
3. Add an executable fixture suite exercising URI isolation, unrelated-source preservation, mixed-stanza rejection, idempotence, non-hosted no-op, write failure and wrapper failure propagation. Fake APT, sudo, pnpm and the idle wrapper; never invoke system package installation.
4. Prove the wrapper integration regression fails before wiring, then run only the focused fixtures and syntax checks. Root owns workflow registration, commit and push.

Implemented `scripts/ci-isolate-chrome-source.py` and called it before both dependency retry loops. The fixture regression failed with the old wrapper because the unrelated active Chrome source blocked both simulated update attempts. After wiring, `python3 scripts/test-ci-apt-sources.py` passed all 10 tests in 3 seconds. `bash -n` passed for both wrappers. All package-manager, sudo, Playwright and idle-runner calls in the fixtures were stubs; no real local APT or build ran. Real runner proof remains the next GitHub CI gate.
