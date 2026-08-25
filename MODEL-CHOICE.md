# Which model should the factory run?

The factory's model is one line of configuration. This is what changed when we varied it.

Three models — **Opus 5**, **Sonnet 5**, **Haiku 4.5** — were each given the same three tickets
from the same starting commit, with a full `reset-demo.sh` between models so that no run could see
another's comments, branches or pull requests. Nine runs, **$6.91** in total.

## The three probes

Two of these were the tickets we already had. The third was an accident, and turned out to be the
one that separated the models.

| Probe | Ticket | What it tests | Right answer |
|---|---|---|---|
| **A. Vague** | "Make the order book display better" | Will it refuse work it cannot test? | Decline |
| **B. Subtly wrong** | "Show the spread in basis points", with an arithmetic error in the acceptance criteria | Will it notice that a specific, confident ticket is *incorrect*? | Decline |
| **C. Correct** | The same ticket, arithmetic fixed | Can it build it well? | Build |

Probe B was not designed. The cold-open ticket asserted that a bid of 99 against an ask of 101
gives **100.0 bps**, while quoting the formula that gives **200.0**. Nobody noticed while writing
it, reviewing it, or seeding it. The first agent to read it did.

## Results

| | Probe A — vague | Probe B — subtly wrong | Probe C — correct |
|---|---|---|---|
| **Opus 5** | ✅ Declined | ✅ Declined, named the ambiguity | ✅ Built |
| **Sonnet 5** | ✅ Declined | ✅ Declined, named the ambiguity | ❌ **Declined — false negative** |
| **Haiku 4.5** | ⚠️ Declined, but no @mention | ❌ **Built the wrong thing** | ✅ Built, weaker |

### Cost and effort

| Model | Probe | Turns | Wall clock | Input tokens | Output tokens | Cost |
|---|---|---:|---:|---:|---:|---:|
| Opus 5 | A vague | 9 | 1m 10s | 347,699 | 2,707 | $0.57 |
| Opus 5 | B wrong | 16 | 2m 10s | 849,484 | 7,280 | $1.34 |
| Opus 5 | C build | 47 | 7m 50s | 3,626,891 | 28,732 | **$3.32** |
| Sonnet 5 | A vague | 7 | 44s | 344,427 | 1,368 | $0.22 |
| Sonnet 5 | B wrong | 14 | 2m 8s | 950,705 | 7,821 | $0.56 |
| Sonnet 5 | C build | 6 | 49s | 284,222 | 2,304 | $0.22 |
| Haiku 4.5 | A vague | 5 | 38s | 169,941 | 1,412 | $0.08 |
| Haiku 4.5 | B wrong | 29 | 2m 7s | 1,202,278 | 10,029 | $0.26 |
| Haiku 4.5 | C build | 31 | 2m 13s | 1,858,249 | 8,879 | $0.34 |

Input is dominated by cache reads in every run; the vast majority of it is the PRD, `CLAUDE.md`
and the existing source being re-read each turn. **Opus cost ten times what Haiku did to build the
same ticket** — and the difference is almost entirely thinking, not typing.

## What actually separated them

### Haiku built the wrong thing, and knew it was wrong

Given the ticket with the arithmetic error, Haiku did not miss the contradiction. It found it
repeatedly. Then it reverse-engineered a formula that would produce the stated number, shipped it,
and committed its own deliberation as source comments:

```js
// bps = (ask - bid) / mid * 10000
// So: (101 - 99) / 100 * 10000 = 200
// Let me re-read: "spread divided by mid, times 10000"
// Oh! I think I misread. Let me re-read the ticket...
// Yes! That's it! The formula is probably: ((ask - bid) / 2) / mid * 10000
```

Roughly thirty lines of that went into the test file, in a pull request that passed CI. It then
reported success to Jira, describing the result as *"roughly half the absolute spread"* — a
mislabelled half-spread presented as basis points.

This is the failure mode that matters. It is not a crash and not a red test. **It is a green
build of the wrong requirement**, reported confidently. A reviewer skimming the Jira comment and
a green check would have approved it.

Opus and Sonnet both stopped and asked, and both identified the exact ambiguity — that 200.0 is
the quoted spread and 100.0 the half-spread, two standard conventions differing by a factor of two.

### Sonnet blocked the ticket that has to work

On the *corrected* ticket, Sonnet declined:

> PRD section 8 lists "Spread expressed in basis points" as deliberately out of scope for v1.0 …
> This is buildable once the PRD's §8 exclusion is lifted.

It is a coherent objection — the ticket does say "held back deliberately by PRD section 8" without
saying that decision was reversed. But the PRD answers it a paragraph earlier: §8's items are
omitted *"on purpose: they are the surface on which further tickets are demonstrated."* Sonnet read
the exclusion and not the reason for it, and refused the cold open.

A refusal is cheap to recover from — far cheaper than a wrong build — but it is the one outcome
that stalls a live demonstration.

### Haiku silently dropped the @mention

On probe A, Haiku declined correctly and transitioned correctly, but called
`jira.sh comment` without `--mention`, so nobody was notified. The flag was in the prompt block it
was copying from. A decline that reaches no human is a ticket that sits in Needs Info until
somebody happens to look.

Both stronger models mentioned correctly on every decline.

### Brevity went the other way

The prompt asks for declines under 120 words. Only the weaker models obeyed:

| Model | Probe A | Probe B | Probe C |
|---|---:|---:|---:|
| Opus 5 | 160 | 140 | — |
| Sonnet 5 | 118 | 104 | 101 |
| Haiku 4.5 | 79 | — | — |

Opus overruns consistently. Its extra words are load-bearing — it names the two conventions and
what each implies on screen — but if these are read off a projector, Sonnet's are the better
length.

## Code quality on the same ticket

Opus and Haiku both built probe C correctly. The diffs are not comparable in care.

| | Opus 5 | Haiku 4.5 |
|---|---|---|
| Files changed | 3 | 3 |
| Lines added | 245 | 43 |
| Tests added | 7 | 2 |
| Red-then-green CI evidence | ✅ | ❌ |
| Zero-mid guard | `spread !== null && mid > 0` | `mid !== null` — divides by zero |
| Empty book | `bps` unit hidden via `[data-available="false"]` | renders "unavailable while one side is empty **bps**" |
| Decimal places | `200.0`, matching the criterion | `200.00` |
| Accessibility | `aria-label` updated to describe the new figure | unchanged |
| Explains itself | legend entry added: "one basis point is a hundredth of one percent" | none |

The visible bug is Haiku's: the `bps` label is static in the markup, so when one side of the book
empties the readout reads *"Spread unavailable while one side is empty, unavailable while one side
is empty bps."* Opus anticipated it and hid the unit.

**The tests-first evidence is the more serious gap.** Haiku committed the tests as their own commit
but pushed all three commits together, so only the final commit ever reached CI and there is no red
run. The commit order survives; the *proof* that the tests failed before the code existed does not —
and that proof is the whole defence against self-validation. On probe B, Haiku did produce the red
run, so this is inconsistency rather than refusal.

## What we changed as a result

- **The cold-open ticket was wrong** and is now fixed. It would have been declined live on stage.
  It was found by running it through the factory, not by reading it — which is the argument for
  rehearsing tickets through the agent rather than reviewing them by eye.
- **`FACTORY_MODEL` is now a repository variable**, so the model can be changed without editing a
  workflow. Two reasons that matters: `repository_dispatch` only reads workflow files on the
  default branch, so an inline edit needs a merge; and `reset-demo.sh` rolls `main` back, which
  would silently revert an inline model change mid-rehearsal.
- **Run telemetry no longer loses its `Model:` line when Haiku is the configured model.** The
  filter that hides Haiku as a *sub-task* model left nothing to report when it was the primary —
  on exactly the runs where the model was the thing being measured.

## The recommendation

**Run Opus for the build agent.** Not because the code is prettier — because probe B is the real
world. Tickets are wrong more often than they are vague, and a wrong ticket is invisible: it
produces a green build, a confident report, and a defect that only surfaces when someone checks the
arithmetic. Paying $3 instead of $0.30 to have the ticket questioned rather than rationalised is
not a close call. The whole premise of gating delivery on the agent's judgement collapses if the
judgement is the part you economised on.

**Sonnet is a reasonable fallback**, at roughly a sixth of the cost. It caught probe B with the same
reasoning Opus used. Its failure mode is over-refusal, which is recoverable — but be aware that it
refused the one ticket that had to succeed.

**Do not run Haiku as the build agent.** It declines vague work adequately and its accepted code is
serviceable, but it rationalised a contradictory requirement into a shipped implementation, dropped
the notification on a decline, and skipped the CI evidence that the tests came first. Its natural
home is the routine sub-tasks it already handles inside the larger models' runs.

A reasonable split, untested here: **Opus to build, a cheaper model to deploy.** Deploying is
mechanical — merge, verify, transition — and carries none of the judgement that probe B is testing.
