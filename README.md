# dsh-deliberation

English | [简体中文](README.zh-CN.md)

An unofficial DeepSeek Harness plugin for bounded, Primary-controlled deliberation and opt-in reasoning-masked review.

> **Status: experimental preview.** The runtime and failure boundaries are tested. Paired benchmark data does not yet establish a correctness or cost benefit, so automatic review is disabled by default.

The plugin adds two related capabilities:

| Capability | Trigger | What it does |
| --- | --- | --- |
| `deliberate` tool | The Primary calls it | Runs 1–3 bounded alternative, audit, or masked-review children concurrently and returns compact JSON packets |
| automatic masked review | Optional `agent/turn-stopping` hook | Re-reads the current tool-bearing Turn without its recorded reasoning and publishes only decision-relevant updates |

Children propose evidence, uncertainty, possible errors, and next checks. They never vote, select a winner, or replace the Primary.

## Quick start

### Requirements

- Node.js `22.19+` or `24+`
- `pnpm` available on `PATH` (`dsh plugin` forwards installs to pnpm)
- a working DeepSeek Harness Web profile and model credentials

Check the prerequisites:

```powershell
node --version
pnpm --version
npx @deepseek-ai/dsh --version
```

### Install the published package

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-deliberation@0.1.0
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

Restart a running Web process after adding, removing, or updating the bundle. The dump should contain all three rows:

```text
subagent-mid-fork-step-family-in-process
subagent-mid-fork-current-turn-in-process
tool-deliberation
```

Start Web from the directory that should become the Agent workspace.

### Test a local checkout before publishing

```powershell
git clone https://github.com/fly1989/dsh-deliberation.git
cd dsh-deliberation
npm ci
npm run release:check

# Latest DSH anchors `.` to this checkout before entering the profile directory.
npx @deepseek-ai/dsh plugin --profile web add .
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

The local install is a link, so rebuild after changing TypeScript and restart the runtime after changing bundle membership or compiled code:

```powershell
npm run build
```

## First manual test

The plugin registers a model-facing tool named `deliberate`. The model still chooses whether to call it, so use an explicit smoke prompt first:

```text
Inspect this workspace and diagnose the failing check. Do not edit yet.
First use the read-only tools to collect one concrete observation. Then call
deliberate with one trajectory-audit branch and one masked-review branch over
the most recent completed Step. Use route=same; use capability=read-only for
the audit and reason-only for the masked review. After receiving the packets,
choose the cheapest discriminating check and continue normally.
```

Expected behavior:

1. The Primary performs at least one completed tool-bearing Step.
2. A generic `deliberate` tool card appears.
3. Separate child Sessions run; their transcripts do not enter the Primary context.
4. The tool result contains one compact packet per successful branch.
5. The Primary decides whether to use the packet.

## Enable automatic masked review

Automatic review is deliberately opt-in. The included example is a complete DSH config-row replacement:

```powershell
$reviewPatch = (Resolve-Path .\examples\auto-review.patch.yml).Path
npx @deepseek-ai/dsh --profile web --patch $reviewPatch --dump-config
npx @deepseek-ai/dsh --profile web --patch $reviewPatch
```

The example enables:

```yaml
autoReview:
  enabled: true
  scope: tool-bearing-turns
  provider: mid-fork-current-turn
  route: same
  capability: read-only
  publish: updates-only
  timeoutMs: 300000
```

For a persistent deployment, copy the complete `tool-deliberation` entry from [`examples/auto-review.patch.yml`](examples/auto-review.patch.yml) into the profile's `cordis.patch.yml`. DSH patch rows replace the target row's entire `config`; they do not deep-merge nested keys. Ordinary profile patch edits hot-reload, but installing or removing the plugin bundle still requires a restart.

Use `publish: observe-only` first when collecting shadow-evaluation data. It runs and persists the child but never writes to the Primary inbox.

## Roles

| Role | History | Incumbent | Intended use |
| --- | --- | --- | --- |
| `independent-alternative` | fresh / `spawn` | hidden | Find one materially different mechanism or strategy |
| `trajectory-audit` | completed prefix / `fork` | visible | Falsify the current trajectory and localize the earliest questionable decision |
| `masked-review` | older native prefix + recent-Step snapshot | hidden | Re-read observable actions/results without the selected Steps' recorded reasoning |

Manual `masked-review` requires `recentSteps` from `1` through `maxRecentSteps` (8 in the bundle). A Step is one completed model decision and every tool call/result caused by that response; parallel tool calls remain one Step. The active Step containing `deliberate` is excluded.

Automatic review uses `window: current-turn`: earlier completed Turns remain native history, while completed Steps in the stopping Turn become the reasoning-masked snapshot.

## Result packet

Children return structured decision support, never hidden reasoning or a full transcript:

```json
{
  "role": "masked-review",
  "status": "update",
  "items": [
    { "kind": "possible_error", "certainty": "likely", "content": "..." },
    { "kind": "unknown", "certainty": "uncertain", "content": "..." },
    { "kind": "suggestion", "certainty": "likely", "content": "..." }
  ]
}
```

- `status`: `update` or `no_update`
- `kind`: `observation`, `conclusion`, `assumption`, `unknown`, `possible_error`, or `suggestion`
- `certainty`: `certain`, `likely`, or `uncertain`

Certainty is the child's self-report, not fact verification. A real timeout, abort, child error, malformed packet, or role mismatch publishes no packet. A strict final-text JSON fallback is accepted only when the child Session proves that its Turn completed normally.

## Configuration reference

### Tool configuration

| Key | Bundle value | Meaning |
| --- | ---: | --- |
| `freshProvider` | `spawn` | Provider used by `independent-alternative` |
| `forkProvider` | `fork` | Provider used by `trajectory-audit` |
| `midForkProvider` | `mid-fork-step` | Prefix of the recent-Step provider family |
| `maxRecentSteps` | `8` | Maximum K exposed to manual masked review |
| `maxBranches` | `3` | Maximum branches in one tool call |
| `maxDepth` | `1` | Absolute child delegation-depth ceiling |
| `branchTimeoutMs` | `600000` | Independent wall-clock timeout per manual branch |
| `routes` | `same` | Deployment-approved model routes visible to the Primary |
| `capabilityProfiles` | `reason-only`, `read-only` | Deployment-approved child tool boundaries |
| `debug` | `false` | Safe lifecycle breadcrumbs; never logs prompts or child content |

### Automatic review

| Key | Values | Meaning |
| --- | --- | --- |
| `enabled` | `false` / `true` | Mount or disable the stopping-boundary policy |
| `scope` | `tool-bearing-turns` / `all-primary-turns` | Eligible top-level Primary Turns |
| `provider` | default `mid-fork-current-turn` | Deployment-owned history projection |
| `route` | default `same` | Child provider/model route |
| `capability` | default `read-only` in bundle | Child tool ceiling |
| `publish` | `updates-only` / `all` / `observe-only` | Which packets may enter the Primary inbox |
| `timeoutMs` | `300000` | Automatic child wall-clock timeout |

### Projection provider

| Key | Bundle value | Meaning |
| --- | ---: | --- |
| `window` | `recent-steps` or `current-turn` | Snapshot selection policy |
| `mask` | `reasoning-only` | Remove reasoning/replay state; `action-only` is an evaluation overlay |
| `maxSnapshotChars` | `65536` | Whole-snapshot text budget; overflow skips rather than truncates |
| `maxSnapshotImages` | `20` | Projected-suffix image ceiling |

Routes and capabilities are allowlists, not registrations. The portable `same` route inherits the Primary model; it is not model-family independence. `read-only` requests `read`, `grep`, and `glob`, but a profile that does not expose those tools safely degrades toward reasoning-only execution.

## Safety and runtime boundaries

- Children never receive `deliberate`; `maxDepth` prevents recursive branch growth.
- Manual siblings run concurrently and fail independently.
- Reasoning masking never edits the append-only Parent Session.
- In-process children share the workspace. Tool filtering is not filesystem, process, or credential isolation.
- The bundle provides no mutation-capable child profile and cannot roll back files, commands, databases, or network side effects.
- Image-bearing reviews start only when the effective child route explicitly supports image input; otherwise they skip before child creation.
- `turn-stopping` is a deterministic checkpoint, not a token-entropy detector.
- Same-model agreement is weak evidence. Children are proposal generators, not external fact verifiers.
- Every automatic attempt pays for a child LLM call; a published update also creates a Primary assimilation Step.

## Troubleshooting

### `deliberate` is missing

Restart Web after installing the bundle, then inspect:

```powershell
npx @deepseek-ai/dsh plugin --profile web why dsh-deliberation
npx @deepseek-ai/dsh --profile web --dump-config
```

### The model did not call `deliberate`

Installation makes the tool available; it does not force invocation. Use the explicit smoke prompt above. Automatic review is a separate runtime path and remains disabled unless configured.

### Automatic review ran but the Primary showed no update

With `updates-only`, a valid `no_update` intentionally creates no parent notice or assimilation Step. Use `publish: all` for protocol debugging or `observe-only` for shadow evaluation.

### Git installation is blocked by pnpm build approval

Git-hosted source dependencies run `prepare`, which pnpm 10 may block until the profile's `pnpm-workspace.yaml` allows the package build. Prefer the published npm package or follow the exact `allowBuilds` key printed by pnpm and rerun the install.

### pnpm reports missing DSH peer dependencies

DSH profiles intentionally set `autoInstallPeers: false`. Out-of-tree plugins declare the Host APIs as peers, while the DSH launcher supplies the installation's single Cordis/DSH instances through its healed profile fallback. A peer warning during `plugin add` is therefore expected; do not install a second Cordis copy into the plugin. Confirm compatibility with `--dump-config` and an actual Web boot.

## Development and release check

```powershell
npm ci
npm run release:check
```

The release check runs type checking, all tests, the production build, and an npm tarball dry run. The package targets the DSH `0.1.1-rc.2` line; DeepSeek Harness is still a developer preview, so rerun the smoke test after every Harness upgrade.

## Documentation

- [Runtime flow](docs/FLOW.zh-CN.md)
- [Cordis / Harness / source mapping](docs/CORDIS-HARNESS-MAPPING.zh-CN.md)
- [Research assumptions, papers, local experiments, and evaluation plan](docs/MASKED-REVIEW-RESEARCH-NOTES.zh-CN.md)
- [Reasoning-masked fork implementation notes](docs/REASONING-MASKED-FORK-EXPERIMENT.zh-CN.md)
- [Terminology](docs/TERMS.zh-CN.md)
- [Deferred and unsupported work](docs/DEFERRED.zh-CN.md)

MIT. This project is not affiliated with or endorsed by DeepSeek.
