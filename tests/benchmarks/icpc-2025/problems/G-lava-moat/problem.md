# Lava Moat

**Time limit:** 4 seconds

Given a triangulated terrain map with elevation values at vertices, find the shortest path at a single elevation that connects the west border to the east border. Output the minimum length or "impossible".

## Input

The first line contains the number of test cases t. Each test case starts with four integers W, H, V, T -- width, height, number of vertices, and number of triangles. Then V lines with x, y, z coordinates for each vertex, followed by T lines with three vertex indices defining each triangle.

## Output

For each test case, output the minimum path length or "impossible". Answers should be accurate to at least 6 decimal places.
