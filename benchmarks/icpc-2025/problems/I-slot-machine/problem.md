# Slot Machine

**Time limit:** 2 seconds

**Interactive problem**

There are n wheels, each with n symbols. You can rotate any wheel by any amount. After each rotation, your friend tells you the number of distinct symbols currently visible (one per wheel). Your goal is to make all wheels show the same symbol. You have at most 10,000 actions.

This is an interactive problem requiring stdin/stdout dialogue. After each rotation command, read the number of distinct symbols. Stop when the response is 1.

## Interaction

First, read n. Then repeatedly:
- Write "i k" to rotate wheel i by k positions
- Read the number of distinct visible symbols

The interaction ends when you receive 1 (all symbols match).
