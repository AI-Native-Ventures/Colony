# CI Fast Lane Design

## Goal

Make ordinary web changes complete through CI in minutes without removing any
existing safety proof.  A production promotion must require only the proofs
that the exact promotion diff makes relevant.

## Scope

This slice changes CI routing only.  It removes the now-disabled `develop`
merge-queue event path, stops production-promotion pull requests from forcing
Rust and desktop jobs, and makes the Promotion Gate validate raw path
relevance for every core and secondary lane.

It does not delete tests, alter test commands, weaken the release tag verifier,
or change artifact-evidence work.

## Design

`Detect Changed Paths` remains the authoritative classifier.  It exposes raw
flags for Rust, desktop frontend, desktop native, and every secondary lane.
For release pushes it still enables complete coverage.  For pull requests,
including `develop` to `main` promotions, each job runs only if its raw flag is
true.

The Promotion Gate remains the sole production aggregate.  It requires a
successful result when the relevant raw flag is true.  When a lane is not
relevant, it accepts only a skipped or successful result; a failure or
cancellation still fails closed.  This preserves a truthful promotion proof
without making a web-only candidate compile Rust, Tauri, Windows, and relay
code.

## Acceptance

1. A web-only promotion selects Web and does not select Rust, Desktop, or Relay
   Suites.
2. A Rust promotion selects Rust Lint, Unit Tests, Desktop, and Relay Suites.
3. A relevant job cannot be skipped or failed without Promotion Gate failing.
4. A non-relevant failed dependency cannot be silently accepted.
5. Release pushes retain broad coverage.
6. The release-pipeline contract detects restoration of forced promotion core
   lanes or removal of a promotion relevance check.
