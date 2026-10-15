# Methodology: network conflation and stranded zone analysis

MARC Transportation Resiliency KC, Phase 2. High Street Consulting. Draft, October 13, 2026.

This note records how the road networks are built, why the design changed from the October 2026 Road Networks deck, and how the stranded zone analysis runs on them. Inputs, vintages and download dates are in `inputs.md`. Parameters live in `config/`. Every step is a script under `scripts/` with a notebook wrapper under `notebooks/`, so MARC can rerun it.

## 1. Conflation

### 1.1 Two networks, one linkage

The project needs two things from a road network that no single source provides:

- A **routable graph** of every drivable public road, so that closures, stranded areas and detours are computed on real connectivity. OpenStreetMap is the only tested source whose roads connect at intersections and keep overpasses separate (Road Networks deck, Wyandotte County test: 98% in one piece, versus 28% for HPMS and 7% for the MARC 9-1-1 centerlines).
- A **scored, attribute-rich segment layer** for Tier 1 roads that carries traffic, functional class, NHS, lanes and condition, and that state and federal data can be joined to reliably. HPMS 2024 is that layer. Its sections are already split where attributes change, and its `Route_ID` with `Begin_Point` and `End_Point` is the state linear referencing system (LRS) that KDOT pavement, KDOT county counts, the National Highway Freight Network, the National Bridge Inventory and MoDOT lettered-route counts all reference.

The October deck used OSM for both roles and attached HPMS to it by spatial matching (15 m, 35 m on freeways, bearing within 20 degrees, name as tiebreak). Inspection of the delivered geodatabase showed why that is fragile:

- Each OSM way kept one HPMS section's route and measures even when it overlapped many sections (up to 161). Measures therefore did not chain along a route, and 264 miles were flagged as low confidence or name mismatch mostly for that reason.
- The OSM ways were not split at intersections, so the layer was not routable as delivered.
- The raw HPMS layer was not retained, so the LRS could not be rebuilt from the deliverable.

The revised design uses each source for one job and connects them once:

| Role | Source | Unit | Used for |
|---|---|---|---|
| Analysis graph | OpenStreetMap (Geofabrik KS and MO) | edge between junction nodes | stranded zones, detours, centrality |
| Scored network | HPMS 2024 (FHWA public release, KS and MO) | section on the state LRS | exposure, sensitivity, criticality scores, project scoring |
| Linkage | OSM edge located on an HPMS route | `(route_id, from_m, to_m)` per edge | moving analysis results onto sections |

Nothing is conflated from HPMS onto OSM. Results flow one way, from OSM edges to HPMS sections.

### 1.2 Analysis graph (OSM)

- Ways are read from the PBF with their node lists. A way is split at every node shared by two or more kept ways. Junction identity comes from the OSM node, not from coordinates, so an overpass and the road beneath never join unless OSM says they do.
- Kept classes are the drivable public `highway` values used by the deck (motorway through residential, links, unclassified, living_street). Private roads, parking aisles and driveways are excluded.
- Each edge keeps `osm_id`, its end nodes, `highway`, `ref`, `name`, `oneway`, `bridge`, `layer`, `maxspeed` and length. Edge IDs are `RD_<osm_id>_<k>` and are stable for a given extract.
- Checks: no intersection remains on an interior vertex; the largest connected component covers at least 99.7% of miles, the deck's baseline.
- Build of October 13, 2026: 102,833 ways after removing ways present in both state extracts, 172,167 edges, 19,715 miles (deck: 19,890), giant component 99.74%, 3.3 minutes. The PBFs are read with a stdlib decoder because Geofabrik no longer publishes XML extracts for US states and the Pro environment has no OSM library.

### 1.3 Scored network (HPMS)

- Routes with measures are built per state from the full-extent `F_System` item (`CreateRoutes` on `Route_ID`, `Begin_Point`, `End_Point`). Non-monotonic measures, gaps and overlaps are logged. Routes whose geometry length and measure span differ by more than 5% are flagged.
- Every HPMS data item becomes a linear event table on the route. No geometry is needed to join them.
- Sections are formed by overlaying the items that should drive a split (default: `F_System`, `AADT`, `NHS`, `Through_Lanes`, `Facility_Type`, `Ownership`, set in `config/segmentation_items.csv`). Remnants shorter than 0.05 mi are merged into the longer neighbor. Sample-panel items such as IRI are attached afterwards by measure overlap, length-weighted.
- Tier 1 is functional class 1 to 6, NHS, and HPMS ramp sections. Ramps that have no HPMS record are not in the scored network; they remain in the analysis graph.
- `asset_id` is `<Route_ID>_<Begin_Point>_<End_Point>` (three decimals), stable for a fixed HPMS vintage.

### 1.4 Linkage

This is the only spatial match left. Edge start, mid and end points are located on `hpms_routes` with a class-dependent radius (freeway 35 m, arterial 20 m, other 15 m). Routes are densified to 10 m vertices and indexed in a KD-tree; each edge point is projected exactly onto the nearest candidate segments and its measure interpolated. Candidates are ranked by bearing at the edge midpoint (within 20 degrees), normalized `ref` against the HPMS route number, and name similarity. A candidate is accepted only if its measure span matches the edge length within 15%, which rejects crossing routes at intersections. Ramps match only ramp sections. Every edge records the route, measures, match quality and method, or null for roads with no LRS.

Directional routes: HPMS opposite-direction carriageways (`Facility_Type` 6) are sometimes measured against travel (90 edges on KS I-435). A one-way edge therefore prefers a route whose measure increases with travel as a scoring tiebreak, but does not require it.

Coverage, October 13, 2026 build: interstates and freeways (1,300 mi) 97.9% by span, 0.8% radius-only, 1.3% unmatched, against the deck's 97% target. All edges: 88.8% span, 0.6% radius-only, 10.7% unmatched (local roads with no HPMS record). The step runs in 1.4 minutes; the Esri Locate Features Along Routes tool it replaced ran 82 minutes on the same input without finishing.

### 1.5 Attaching other data to sections

Rules are rows in `config/conflation_rules.csv` (source, key type, aggregation). Two paths:

- **By LRS key, measure overlap, no search radius:** KDOT county and city counts, NHFN, KDOT pavement (route, direction and mileposts parsed from `KEYID_1`), NBI (route and milepost items), MoDOT lettered-route AADT when received.
- **Spatial, to the section midpoint within 20 m:** MARC functional classification, MoDOT pavement (after removing its paired-direction duplicate geometries, which double-count about 1,090 miles), Unified Government and Shawnee pavement.

Aggregation per attribute: length-weighted mean for AADT, IRI and condition indices; length-majority for class, NHS, ownership and ratings; maximum for lanes. Each attribute records the share of section length covered; under 50% is flagged.

### 1.6 Decisions and open items

- Ramps without an HPMS record (188 miles in the deck) are excluded from the scored network. Decision taken October 13, 2026.
- The KDOT `KEYID_1` route code must be confirmed to map onto HPMS `Route_ID` before the pavement join is trusted.
- ICF's hazard tables are keyed on the previous OSM asset IDs. They must be re-keyed to section IDs before values are delivered.
- Coordinate system is NAD 83 Missouri West per MARC; measures are miles regardless. A national datum update is pending.

## 2. Stranded zone analysis

### 2.1 Framing

Phase 1 (Cambridge Systematics, April 2025) defined the analysis as finding "areas at the highest risk of disruption and severely long detours," considering "the number of egress routes" and "affected populations such as disabled, elderly population, and children." The steering committee singled out one-way-in, one-way-out river communities and asked that emergency managers vet detours. Phase 1 assumed the MARC travel demand model would supply disruption impacts; Phase 2 runs on the OSM graph instead, with detour length as the proxy for delay. The System Advisors working group (February 2027) reviews the detours before stranded zone modeling is finalized.

### 2.2 Method

Per scenario (return period, year, climate scenario, closure depth threshold; all set in `config/build.toml`, with present, 2050 and 2070 as the minimum set):

1. Load the OSM graph with one-way restrictions.
2. Close every edge whose flood depth exceeds the threshold. Depth comes from the edge-keyed depth table (`build.gdb/edge_depths`, one column per scenario); the deck's working threshold is 1 ft and remains a decision for MARC. Until Fathom depths arrive, `scripts/fema_closures.py` fills the `fema_1pct` column with a nominal 1 ft on every non-bridge edge that intersects the FEMA Special Flood Hazard Area (floodway plus 1% annual chance zone, Esri Living Atlas USA Flood Hazard Areas, nine counties). Bridges are exempt because the floodplain polygon crosses every river bridge; the approaches are not exempt. The threshold is run as a ladder (0.5, 1, 1.5, 2 and 3 ft) and every step is published with the scenario layers, so the Explorer can switch between them; the scored network carries the default step (0.5 ft).
3. Stranded zones are the connected components cut off from the main network. Components that were already disconnected at baseline (OSM fragments, 0.3% of miles) are not zones and are left out. For each, report miles, population, jobs, facilities, and the shares that are under 18, 65 and over, and with a mobility disability (CDC PLACES).
4. Egress: edges whose removal would disconnect a component are found on the baseline and on each scenario graph. A zone left with exactly one route out is flagged as single-egress. The baseline and scenario egress counts are reported.
5. Detours: for each closed edge, the shortest surviving path between its ends. Added length is stored on the edge and the path is written as a line layer per scenario for operator review.
6. Centrality: approximate betweenness on the baseline graph, as the network-role input to criticality.
7. Redundancy: on the baseline graph, for every Tier 1 edge (an edge whose linkage span overlaps a scored section; 38,001 edges), the shortest surviving path between its ends when that edge alone is removed, with a 20 mi search cutoff. This is the framework's redundancy measure (detour length from the routable network), computed once and independent of any flood scenario. Edges with no alternative path within the cutoff are flagged as no-path. First run: 17.7 minutes; 29.8% of Tier 1 edges flagged no-path, almost all of them one-way edges inside a freeway, ramp or divided-arterial chain, where the removed edge's start node has no other exit. Only 3 of 1,000 sampled no-path edges are true bridges. See 2.4.
8. Results (closed, stranded, scenario detour miles, baseline redundancy detour miles, centrality) become events on the HPMS routes through the linkage and are overlaid onto the scored sections. Closed, stranded and the two detour measures take the maximum over the overlapping edges; centrality is length-weighted.

### 2.3 Regression check

The deck's Wyandotte County method test (FEMA 1% floodplain as the closure input: 50 miles closed, 28 dry miles stranded, 76 stranded areas) is rerun on the rebuilt graph as the `fema_1pct` scenario, region-wide. First run, October 14, 2026:

| Measure | Value |
|---|---|
| Edges closed (non-bridge, in the SFHA) | 8,512 of 172,167 |
| Closed edges with no detour within the cutoff | 7,254 |
| Detour where one exists | mean 3.9 mi, max 45.2 mi |
| Stranded zones | 1,031 (2,865 road mi, about 107,000 residents, 30,500 jobs, 139 facilities); 133 further pieces were already disconnected at baseline and are not counted |
| Single-egress zones | 987 written (2,213 road mi, about 184,000 residents) |
| Largest stranded zones by population | 21,600 and 15,500 residents (416 and 410 road mi) |

The no-detour share is high for the same reason as baseline redundancy: a closed edge's neighbours along the floodplain are closed too, so a detour measured between the edge's own end nodes rarely exists. The two largest zones are whole districts walled off by contiguous floodplain crossings, which is what a FEMA-polygon closure rule produces and a depth-based rule would not. Wyandotte-only totals and the comparison to the deck are still to be extracted (filter the published layers by county). Differences are explained before any scenario with Fathom data is reported.

### 2.4 Decisions and open items

- Closure depth threshold and return period: MARC decision. The threshold is run as a ladder (0.5, 1, 1.5, 2 and 3 ft) and every step is published with the scenario layers, so the Explorer can switch between them; the scored network carries the default step (0.5 ft).
- Fathom outputs are licensed for this project only; results are a dated snapshot and the scripts are parameterized so MARC can rerun with other hazard data.
- Age shares need a tract-level ACS pull not yet in the inventory.
- Whether redundancy (detour length) scores under criticality or adaptive capacity is still open in the framework; it is computed once and used once.
- Redundancy on one-way chains: measuring the detour between the removed edge's own end nodes marks most freeway and ramp edges as no-path, because a one-way node loses its only exit. The candidate fix is to measure from the last upstream node where a driver still has a choice (the nearest predecessor with out-degree above one) to the first downstream node with an alternative entry. Decision pending; the current `redundancy_no_path` flag should not be scored until it is made.
- Fathom flood scenarios are not yet run: the hazard tables must be delivered keyed on `edge_id` (or on sections, then moved to edges through the linkage). The `fema_1pct` method test runs today and is published as `draft_MARC_Resiliency_Scenarios`.
