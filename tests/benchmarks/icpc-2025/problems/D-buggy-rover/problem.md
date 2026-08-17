# Buggy Rover

**Time limit:** 2 seconds

A rover on a grid with a direction ordering (a permutation of N, E, S, W). At each step, the rover tries directions in order and moves in the first valid direction (not blocked, not off-grid). Cosmic rays can change the direction ordering at any time. Given a log of the rover's moves, find the minimum number of direction ordering changes needed.

## Input

The first line contains two integers R and C, the number of rows and columns. The next R lines describe the grid ('.' is open, '#' is blocked, 'S' is the start). The last line is the move log string.

## Output

Output a single integer: the minimum number of direction ordering changes.
