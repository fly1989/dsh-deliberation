# Changelog

All notable public changes to this project are documented here.

## Unreleased

### Repository

- Keep the personal `debug/` lab local-only while retaining the public architecture and research notes.
- Add a CI hygiene check that rejects tracked debug artifacts, runtime output, release tarballs, and machine-specific paths.
- Align the architecture guide with the DSH `0.1.1-rc.2` compatibility line used by CI.

## 0.1.0 — 2026-08-31

Initial experimental preview.

### Added

- Primary-controlled `deliberate` tool with independent-alternative, trajectory-audit, and masked-review roles.
- Concurrent bounded branches with per-branch timeout, sibling failure isolation, recursion prevention, and compact structured packets.
- Step-bounded reasoning-masked history projection plus a current-Turn automatic provider.
- Opt-in automatic review with `updates-only`, `all`, and `observe-only` publication modes.
- Reason-only and read-only child capability profiles.
- Multimodal projection that preserves supported image references and skips unsupported or over-budget inputs before child creation.
- English and Chinese installation, configuration, troubleshooting, architecture, and research documentation.

### Safety and evidence boundaries

- Automatic review is disabled by default.
- Failed, aborted, timed-out, malformed, or role-mismatched child results publish no packet.
- Child certainty is self-reported and is not fact verification.
- Tool filtering is not workspace or process isolation.
- No correctness or inference-cost improvement is claimed before paired evaluation.
