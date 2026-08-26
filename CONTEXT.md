# Domain Language

## Observation evidence

An immutable, source-addressed memory record extracted from conversation. It preserves the observation text, timestamp, relevance, and available Pi source-entry IDs.

## Active observation

Observation evidence that remains part of the normal memory projection because its meaning is unresolved, unique, current, uncertain, or not safely preserved elsewhere.

## Retired observation

Observation evidence omitted from the normal memory projection after an explicit lifecycle event records a locally accepted preservation reason. Retirement does not delete the evidence.

## Reflection revision

An immutable synthesized orientation record supported by observation evidence. Any change to its content or support creates a new revision with a new memory ID.

## Current reflection

A reflection revision selected for the normal memory projection and responsible for any preservation obligations assigned to it.

## Superseded reflection

A historical reflection revision replaced by a newer revision. It remains recallable but is omitted from the normal memory projection only after its preservation obligations transfer safely.

## Preservation obligation

The requirement that information used to justify an observation's retirement remains represented by a current reflection or another active observation.

## Lifecycle event

An immutable branch-local record that changes the projected status of observation evidence or reflection revisions without rewriting their original records.

## Memory projection

The deterministic current view derived from observation evidence and lifecycle events. It contains active observations and current reflections.

## Context projection

The bounded, deterministic subset of the memory projection rendered into Pi's compaction summary for the main model.
