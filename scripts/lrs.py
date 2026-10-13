import bisect
from collections import defaultdict

METHODS = ("mean", "majority", "max", "min")


def aggregate(targets, events, rules, eps=1e-9):
    # targets: (key, route_id, from_m, to_m); events: (route_id, from_m, to_m, {attr: value})
    # rules: {attr: method}. Returns {key: {attr: value, "cov_<attr>": share of target length}}.
    by_route = defaultdict(list)
    for rid, a, b, vals in events:
        lo, hi = (a, b) if a <= b else (b, a)
        by_route[rid].append((lo, hi, vals))
    index = {}
    for rid, evs in by_route.items():
        evs.sort(key=lambda e: e[0])
        index[rid] = ([e[0] for e in evs], evs, max(e[1] - e[0] for e in evs))

    out = {}
    for key, rid, a, b in targets:
        lo, hi = (a, b) if a <= b else (b, a)
        length = hi - lo
        acc = {attr: defaultdict(float) for attr in rules}
        if rid in index:
            starts, evs, maxlen = index[rid]
            i = bisect.bisect_left(starts, lo - maxlen - eps)
            while i < len(evs) and evs[i][0] <= hi + eps:
                e_lo, e_hi, vals = evs[i]
                i += 1
                if e_hi - e_lo <= eps:
                    # Point event (bridge, count station): weight 1, half-open [lo, hi) so it lands once.
                    if not (lo - eps <= e_lo < hi - eps or (length <= eps and abs(e_lo - lo) <= eps)):
                        continue
                    w = 1.0
                elif length > eps:
                    w = min(hi, e_hi) - max(lo, e_lo)
                    if w <= eps:
                        continue
                elif e_lo - eps <= lo <= e_hi + eps:
                    w = 1.0
                else:
                    continue
                for attr in rules:
                    v = vals.get(attr)
                    if v is not None and v == v:
                        acc[attr][v] += w
        res = {}
        denom = length if length > eps else 1.0
        for attr, method in rules.items():
            weights = acc[attr]
            res[f"cov_{attr}"] = min(1.0, sum(weights.values()) / denom) if weights else 0.0
            if not weights:
                res[attr] = None
            elif method == "mean":
                res[attr] = sum(v * w for v, w in weights.items()) / sum(weights.values())
            elif method == "majority":
                res[attr] = max(weights.items(), key=lambda kv: (kv[1], str(kv[0])))[0]
            elif method == "max":
                res[attr] = max(weights)
            elif method == "min":
                res[attr] = min(weights)
            else:
                raise ValueError(f"unknown method {method!r} for {attr}")
        out[key] = res
    return out
