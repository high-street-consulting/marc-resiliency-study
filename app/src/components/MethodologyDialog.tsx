import { useEffect, useRef } from 'react'
import { Icon } from './icons'

// Mirrors docs/methodology.md in the study repo; keep the two in step when a method changes.
const SECTIONS: { title: string; intro?: string; items: { term: string; text: string }[] }[] = [
  {
    title: 'Two networks, one linkage',
    intro:
      'No single road dataset is both routable and attribute-rich, so the study uses two and connects them once.',
    items: [
      {
        term: 'Stranded zone network',
        text: 'OpenStreetMap (Geofabrik Kansas and Missouri extracts, October 12, 2026). Every drivable public road, split into edges at every node two or more roads share. Junctions come from OSM node identity, not coordinates, so an overpass never joins the road beneath it. Used only for routing: stranded zones, detours and centrality. 172,167 edges, 19,715 miles, 99.7% of mileage in one connected piece.',
      },
      {
        term: 'Vulnerability assessment network',
        text: 'FHWA HPMS 2024 public release for Kansas and Missouri, the state linear referencing system (route ID plus begin and end mileposts). Sections are formed by overlaying functional system, AADT, NHS, through lanes, facility type and ownership, so a section breaks wherever one of those changes; remnants under 0.05 mile merge into the longer neighbour. Tier 1 is functional class 1 to 6, NHS, and HPMS ramp sections: 6,801 sections, 5,970 miles. The asset ID is the route ID with the begin and end mileposts.',
      },
      {
        term: 'Linkage',
        text: 'Each OSM edge is located once on the HPMS routes (search radius 35 m on freeways, 20 m on arterials, 15 m elsewhere; bearing within 20 degrees; route number and name as tiebreaks; accepted only when the milepost span matches the edge length within 15%). Interstates and freeways link at 98.7%. Results computed on OSM move onto HPMS sections through this linkage. Nothing flows the other way.',
      },
    ],
  },
  {
    title: 'Attributes on the vulnerability assessment network',
    intro:
      'HPMS items are joined by milepost overlap on the route, with no search radius. Other sources join the same way when they carry the state route ID, and by section midpoint within 20 m when they do not.',
    items: [
      {
        term: 'aadt, nhs, f_system, through_lanes, facility_type, ownership',
        text: 'HPMS full-extent items. These define the section breaks, so each section has one value. HPMS reports AADT only on the inventory direction of divided highways; opposite-direction sections carry none.',
      },
      {
        term: 'iri, psr, cracking_percent, speed_limit',
        text: 'HPMS sample-panel items attached by milepost overlap, length-weighted mean. The matching cov_ field is the share of the section length the item covered.',
      },
      {
        term: 'aadt_kdot_county, nhfn_code, pav_cond_kdot',
        text: 'KDOT county and city counts, the National Highway Freight Network and KDOT pavement condition, joined by route ID and milepost overlap. Length-weighted mean for counts and condition, length-majority for codes.',
      },
      {
        term: 'nbi_min_cond',
        text: 'Lowest National Bridge Inventory condition rating (deck, superstructure, substructure, culvert) among bridges on the section. Bridges are placed by NBI route and milepost where those match an HPMS route, otherwise by route number, otherwise by the nearest route.',
      },
      {
        term: 'pav_cond_modot, pci_ug, paser_shawnee',
        text: 'MoDOT, Unified Government and Shawnee pavement condition, joined spatially to the section midpoint. MoDOT paired-direction duplicate geometries are removed first.',
      },
      {
        term: 'cov_* and low_coverage',
        text: 'Each attached attribute records the share of the section length its source covered. low_coverage flags sections where any attribute covered less than half the section.',
      },
    ],
  },
  {
    title: 'Network analysis values',
    intro:
      'Computed on the OSM graph with one-way restrictions, then moved onto sections through the linkage. Where several edges overlap a section, closure and detour measures take the maximum and centrality the length-weighted mean.',
    items: [
      {
        term: 'centrality',
        text: 'Approximate betweenness centrality on the unflooded graph: the share of shortest paths between sampled origin and destination nodes (500 samples) that pass through the edge. Higher means more of the region routes through it.',
      },
      {
        term: 'redundancy_detour_mi',
        text: 'Remove the edge alone from the unflooded graph and take the shortest surviving path between its two ends, searched up to 20 miles. Computed once for every Tier 1 edge, independent of any flood scenario.',
      },
      {
        term: 'redundancy_no_path',
        text: 'Set to 1 when no alternative path exists within 20 miles. On one-way freeways and ramps a node in the middle of a one-way chain has no other exit once the edge is removed, so most flags today reflect the one-way geometry rather than missing redundancy. The definition is under review and this flag should not be scored yet.',
      },
      {
        term: 'closed, stranded, detour_mi (scenario fields)',
        text: 'For each flood scenario (return period, year, climate scenario and closure depth threshold), an edge is closed when its flood depth exceeds the threshold. The threshold is run as a ladder (0.5, 1, 1.5, 2 and 3 ft) and every step is published with the scenario layers, so the Explorer can switch between them; the scored network carries the default step (0.5 ft). Stranded is set on edges cut off from the main network. detour_mi is the shortest surviving path around a closed edge. Today one scenario is published, the FEMA 1% floodplain method test: every non-bridge edge inside the FEMA floodway or 1% annual chance zone is closed (8,512 of 172,167 edges). Fathom depth scenarios fill in when the edge-keyed depth table is delivered.',
      },
    ],
  },
  {
    title: 'How the map shows the results',
    items: [
      {
        term: 'Redundancy symbology',
        text: 'Each Tier 1 section is drawn in a single-hue teal ramp by the detour length a driver would face if that section alone were lost: lightest and thinnest under 1 mile, darkest and widest over 10 miles. Sections flagged redundancy_no_path with no measured detour draw as a gray dashed line labelled not measured. Lines are 70% opaque so the basemap road names stay readable underneath.',
      },
      {
        term: 'Centrality symbology',
        text: 'The same teal ramp applied to betweenness centrality, from lowest to highest. It is a second option on the vulnerability assessment network row; only one option draws at a time.',
      },
      {
        term: 'FEMA flood hazard areas',
        text: 'FEMA National Flood Hazard Layer (USA Flood Hazard Areas, Esri Living Atlas), drawn under the roads as one translucent blue fill. It covers the regulatory floodway, the 1% annual chance zone (the 100-year floodplain, where flood insurance is mandatory), the 0.2% annual chance zone (500-year), and the levee-protected and future-condition areas FEMA maps; click a polygon to see its class. It is context for where closures are likely, not a scenario; the FEMA 1% method test uses the floodway and 1% zone together as the closure input.',
      },
    ],
  },
  {
    title: 'Stranded zones',
    items: [
      {
        term: 'How a zone is formed',
        text: 'After closing the flooded edges, the graph falls into connected pieces. The largest piece by mileage is the main network; every other piece that still contains roads is a stranded zone, unless it was already disconnected before any closure (OSM fragments, 0.3% of miles). A zone is a set of roads that can still reach each other but cannot reach the rest of the region.',
      },
      {
        term: 'Egress',
        text: 'Edges whose removal would disconnect a zone from the rest of the network are counted on the baseline and on each scenario graph. A zone left with exactly one way out is flagged single-egress.',
      },
      {
        term: 'Population profile',
        text: 'Population, jobs and facilities are allocated to a zone by its share of each census tract’s road mileage. Shares under 18 and 65 and over come from ACS 2020 to 2024 tract tables; mobility disability from CDC PLACES.',
      },
      {
        term: 'Detours for review',
        text: 'Each scenario writes its detour paths as lines so emergency managers can vet them, following the Phase 1 direction that detours be reviewed before stranded zone results are finalized.',
      },
    ],
  },
  {
    title: 'Sources, projection and open items',
    items: [
      {
        term: 'Sources',
        text: 'OpenStreetMap via Geofabrik (ODbL), FHWA HPMS 2024, KDOT, MoDOT, FHWA NBI, US Census ACS, CDC PLACES, FEMA NFHL, and Fathom flood depths delivered by ICF under a project-only licence.',
      },
      {
        term: 'Projection',
        text: 'Layers are built in NAD 83 State Plane Missouri West (US feet), the MARC standard; mileposts are miles regardless.',
      },
      {
        term: 'Open items',
        text: 'Closure depth threshold and return period are MARC decisions. The KDOT pavement route code crosswalk is awaiting KDOT confirmation. Fathom flood scenarios run once edge-keyed depths arrive; the FEMA 1% method test is a stand-in that closes whole floodplain crossings regardless of depth, so its stranded zones are an upper bound. The full write-up is docs/methodology.md in the application source repository.',
      },
    ],
  },
]

export function MethodologyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label="How the values in this Explorer were calculated"
      style={{
        width: 'min(760px, 94vw)',
        maxHeight: '86vh',
        background: '#fff',
        border: 0,
        padding: 0,
        boxShadow: 'var(--sc-shadow-modal)',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '14px 16px 10px',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 10,
          borderBottom: '1px solid var(--sc-hairline)',
        }}
      >
        <div>
          <h2 style={{ margin: 0, font: '600 15px/1.3 var(--sc-font)', color: 'var(--sc-text)' }}>
            Methodology — how the values were calculated
          </h2>
          <div style={{ marginTop: 4, font: '400 11.5px/1.4 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
            MARC Transportation Resilience Phase 2. Draft of October 14, 2026.
          </div>
        </div>
        <button
          aria-label="Close methodology"
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            flex: 'none',
            border: '1px solid var(--sc-input-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 2,
            color: '#555',
          }}
        >
          <Icon name="x" />
        </button>
      </div>
      <div style={{ padding: '4px 16px 16px', overflowY: 'auto' }}>
        {SECTIONS.map((s) => (
          <section key={s.title} style={{ paddingTop: 14 }}>
            <h3 style={{ margin: 0, font: '600 13px/1.3 var(--sc-font)', color: 'var(--sc-blue-deep)' }}>{s.title}</h3>
            {s.intro && (
              <p style={{ margin: '6px 0 0', font: '400 12.5px/1.6 var(--sc-font)', color: 'var(--sc-text)' }}>{s.intro}</p>
            )}
            <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) 1fr', gap: '8px 14px' }}>
              {s.items.map((it) => (
                <div key={it.term} style={{ display: 'contents' }}>
                  <dt style={{ font: '600 12px/1.5 var(--sc-font)', color: 'var(--sc-text)', wordBreak: 'break-word' }}>{it.term}</dt>
                  <dd style={{ margin: 0, font: '400 12.5px/1.6 var(--sc-font)', color: 'var(--sc-text)' }}>{it.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  )
}
