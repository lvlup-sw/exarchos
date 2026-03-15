# A-Skew-ed Reasoning

**Time limit:** 2 seconds

Given a skew heap (binary tree where parent <= children), find the lexicographically minimal and maximal input permutations that produce that heap via the specified insertion algorithm. If impossible, output "impossible".

A skew heap is a binary tree satisfying the heap property (each node's value is less than or equal to its children's values). The insertion algorithm works by merging the new element as a single-node heap with the existing heap using a specific merge procedure that alternates swapping left and right children along the rightmost path.

## Input

The first line contains an integer n (1 <= n <= 300,000), the number of nodes. The next n lines each contain two integers l_i and r_i, the left and right children of node i (0 means no child). Node 1 is always the root with value 1, node 2 has value 2, etc.

## Output

If a valid insertion order exists, output two lines: the lexicographically smallest and largest permutations that produce the given heap. Otherwise, output "impossible".
