# Bride of Pipe Stream

**Time limit:** 12 seconds

A network of Flubber stations, reservoirs, and ducts. Stations can split flow in any proportion. Ducts split flow in fixed proportions. Maximize the minimum percentage that all reservoirs receive.

## Input

The first line contains three integers s, r, d -- the number of stations, reservoirs, and ducts respectively. The next d lines each describe a duct: station type (1 for station, 2 for reservoir), source id, then pairs of (destination, percentage).

## Output

Output a single floating-point number: the maximum achievable minimum percentage across all reservoirs. The answer should be accurate to at least 6 decimal places.
