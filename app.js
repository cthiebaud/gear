// Parses config.dot (standard Graphviz DOT) into signal-chain diagrams and
// renders them as HTML. Edit config.dot to change the diagrams -- no code
// changes needed. The file must also be valid input to real Graphviz
// (`dot -Tsvg config.dot`), VS Code's DOT preview, GitHub's native .dot
// rendering, etc. -- this app only reads it, it doesn't require anything
// non-standard.
//
// Vocabulary this app gives meaning to (all of it is either standard DOT
// or attributes real Graphviz just ignores if it doesn't recognize them):
//   node id                    -> stable identity, matched against
//                                  PEDAL_SPECS for physical calibration
//                                  (width, per-port jack position).
//   shape=record, label="<p> t|Name|<p2> t2"
//                               -> a device: the one plain (unprefixed)
//                                  cell is its display name, every
//                                  `<port>` cell declares a port that
//                                  edges can reference (`id:port`).
//   shape=plain, label=<<TABLE>...<TD PORT="p">...</TABLE>>
//                               -> same, for devices needing 2D port
//                                  layout (stereo pairs, grouped jacks)
//                                  instead of a single record row.
//   owner="..."                -> caption under the pedal image.
//   image="file.png"           -> only for nodes with no PEDAL_SPECS
//                                  entry (guitar, amps): they have no
//                                  jacks to calibrate, so there's nothing
//                                  for PEDAL_SPECS to key on.
//   place="free"                 -> renders as a plain box outside the
//                                  board rectangle (independent of
//                                  whether it happens to have a
//                                  PEDAL_SPECS entry for real-width
//                                  scaling -- e.g. the telecaster has one
//                                  just so its image scales like a
//                                  pedal's) instead of the default,
//                                  "on top of the board", packed into the
//                                  bordered rectangle's rows. *Where*
//                                  around the board a "free" node actually
//                                  ends up (which compass side, and its
//                                  size if it's one of the 3 flagged in
//                                  FLEXIBLE_SIZE_IDS) is computed, not
//                                  configured -- see placeFreeItems.
//   id:port -> id2:port2 [kind="..."]
//                               -> a connection. kind is through (the
//                                  default, omit it) | loop-out | loop-in
//                                  | fork | power -- picks the line style
//                                  and, for loop-out/loop-in, which side
//                                  of a pair nests inside the other. Any
//                                  other edge attribute (e.g. conn="trs")
//                                  is carried through unused by this app,
//                                  for your own reference or other tools.
// Ports are required on every edge, even ones this app won't draw (e.g.
// a guitar -> pedal edge, where the guitar has no calibrated jack) --
// explicit beats a guessed default, and it costs nothing since undrawn
// edges don't need to resolve to anything.
//
// Declaration order in the file (first time each node id appears, either
// as its own node statement or inside an edge) is what determines board
// layout order -- same principle as the old custom syntax's "line order
// determines connections", just carried over to DOT's flat edge list.
// `{ rank=same; a; b; c; }` overrides that for the nodes it lists: they
// become one explicit row, in that order, instead of wherever automatic
// width-based packing would otherwise put them (see segmentBoard). It's
// real Graphviz syntax (same-tier grouping), not an app-specific
// invention, so the file stays valid input to `dot -Tsvg` too.
//
// Multiple rigs, one page: index.html?config=NAME loads NAME.dot instead
// of the default config.dot (see main()). Layout -- both the on-board row
// breaks and where every "free" node ends up -- is computed fresh from
// whatever NAME.dot describes; there's no separate per-config stylesheet
// to keep in sync.

// Real-world scale: widths are the actual measured footprint (see
// pedal-dimensions-fixed.txt -- width = left-to-right, the dimension
// that matters for board space), one shared mm-to-px ratio applied to
// all of them, so two pedals of different real size actually look
// different size next to each other.
const PX_PER_MM = 2.2;

// jack coordinates are fractions (0-1) of the *cropped* image's own
// width/height, read off the product photo's silhouette (see
// scratchpad/analyze_pedals.py). Convention: input on the right, output
// on the left, matching how this rig is actually wired -- so `in` is
// always the larger x of the pair. Port names here must match the
// `<port>` names declared in that pedal's DOT record/HTML label exactly
// -- that's the only place the two are tied together. `approx: true`
// means the photo doesn't actually show the jacks (e.g. a top-down shot)
// and the jack point is a placeholder, not a reading.
const PEDAL_SPECS = {
  telecaster :{
    file: 'telecaster.png',
    widthMm: 200,
    out: { x: 0.94, y: 0.94 },
  },
  strobostomp_hd: {
    file: 'peterson-strobostomp-hd.png',
    widthMm: 66,
    in: { x: 1, y: 0.55 },
    out: { x: 0, y: 0.55 },
    power: { x: 0.788, y: 0 },
  },
  ua1176: {
    file: 'ua-1176.png',
    widthMm: 65,
    in: { x: 0.705, y: 0 },
    out: { x: 0.285, y: 0 },
    power: { x: 0.5, y: 0.05 },
  },
  centavo: {
    file: 'warm-audio-centavo.png',
    widthMm: 170,
    in: { x: 0.655, y: 0 },
    out: { x: 0.343, y: 0 },
    power: { x: 0.221, y: 0.015 },
  },
  tim_v3: {
    file: 'paul-c-tim-v3.png',
    widthMm: 117,
    in: { x: 0.833, y: 0 },
    out: { x: 0.167, y: 0 },
    // Brig is inserted in Tim's Boost/FX loop, off the dedicated loop jacks.
    loopOut: { x: 0.667, y: 0 },
    loopIn: { x: 0.333, y: 0 },
    power: { x: 0.5, y: 0.03 },
  },
  brig: {
    file: 'strymon-brig.png',
    widthMm: 68.6,
    in: { x: 0.817, y: 0 },
    out: { x: 0.579, y: 0 },
    power: { x: 0.125, y: 0.027 },
  },
  electric_blue_chorus: {
    file: 'mad-professor-electric-blue.png',
    widthMm: 58,
    in: { x: 1, y: 0.5 },
    out: { x: 0, y: 0.5 },
    power: { x: 0.962, y: 0.7 },
  },
  capistan: {
    file: 'strymon-elcap-v2.png',
    widthMm: 101.6,
    in: { x: 0.85, y: 0 },
    exp: { x: 0.462, y: 0 },
    out: { x: 0.655, y: 0 },
    power: { x: 0.12, y: 0.025 },
  },
  bluesky: {
    file: 'strymon-bluesky.png',
    widthMm: 101.6,
    in: { x: 0.85, y: 0 },
    out: { x: 0.271, y: 0 },
    power: { x: 0.12, y: 0.025 },
  },
  psplit: {
    file: 'lehle-p-split-iii.png',
    widthMm: 91.4,
    // Real hardware: 1 input, 2 outputs (DIR + ISO), fully passive (no
    // power jack, so no `power` entry -- a device just doesn't get wired
    // to the PSU if it has no port for it).
    in: { x: 0.857, y: 0 },
    outDir: { x: 0.624, y: 0 },
    outIso: { x: 0.136, y: 0 },
  },
  simplifier_x: {
    file: 'dsm-simplifier-x.png',
    widthMm: 125,
    in: { x: 0.888, y: 1 },
    out: { x: 0.212, y: 1 },
    loopOut: { x: 0.619, y: 1 },
    loopIn: { x: 0.348, y: 1 },
    power: { x: 0.117, y: 0.039 },
  },
  // Real hardware, per the owner: 9.3cm wide x 20cm deep -- notably taller
  // (front-to-back) than any stompbox here, which is expected for an
  // expression pedal and is why it gets its own sidebar next to the
  // packed rows instead of joining them (see renderPage). Photographed
  // from the toe end looking back at the jack panel, so this is a
  // portrait-oriented crop, unlike every other pedal here.
  dvp5: {
    file: 'dunlop-volume-x-8.png',
    widthMm: 85,
    sidebar: true, // rendered next to the packed rows, not packed into one -- see renderPage
    // Click-calibrated via calibrate.html. Jack panel, left to right:
    // OUTPUT, TUNER, EXP, INPUT.
    exp: { x: 0.59, y: 0 },
  },
  ironball: {
    file: 'Engl-E606.png',
    widthMm: 240,
    in: { x: 0.5, y: 0 },
    out: { x: 0.212, y: 0.9 },
    loopIn: { x: 0.667, y: 0.915 },
    loopOut: { x: 0.333, y: 0.925 },
  },
  // Only here so its image scales to true width like a pedal's, same
  // reasoning as the telecaster. `in` isn't a real calibrated jack (no
  // input port is actually visible in the product photo used) -- just a
  // top-left placeholder so a connector has somewhere to land, same
  // convention as any other `approx`-flagged point.
  twin_reverb: {
    file: 'fender-twin-reverb.png',
    widthMm: 250, // 26.25in, Fender '68 Custom Twin Reverb spec sheet
    approx: true,
    in: { x: 0.5, y: 0.03 },
  },
};

// Voodoo Lab power supply: 10 real DC outputs, calibrated by clicking
// the actual unit's photo (calibrate.html) -- 2 @ 12V/400mA (hc12), 4 @
// 9V/400mA ("high current" -- hc9), 4 @ 9V/100mA ("isolated" -- iso).
// Matched against pedal power draws in voltage_&_ampère.txt -- see
// config.dot's power edges for the actual assignment. Synthesized
// directly in buildModel rather than through PEDAL_SPECS -- it's not
// "one more pedal" for row-packing purposes, and always place="free"
// (nothing in config.dot has to say so).
const PEDAL_POWER_ID = 'pedal_power';
const POWER_SUPPLY = {
  file: 'voodoolab-4x4.png',
  widthMm: 176,
  hc9_1:  { x: 0.065, y: 1 },
  hc12_1: { x: 0.115, y: 1 },
  hc9_2:  { x: 0.200, y: 1 },
  hc12_2: { x: 0.255, y: 1 },
  iso1:   { x: 0.333, y: 1 },
  iso2:   { x: 0.413, y: 1 },
  iso3:   { x: 0.697, y: 1 },
  iso4:   { x: 0.775, y: 1 },
  hc9_3:  { x: 0.853, y: 1 },
  hc9_4:  { x: 0.930, y: 1 },
};

const DEFAULT_WIDTH_PX = 120;

// --- DOT label sub-parsers ----------------------------------------------
//
// dotparser gives us the DOT grammar proper (nodes, edges, attr lists,
// ports on edges) but hands back a record or HTML-like *label* as an
// opaque string -- Graphviz parses those with its own separate
// mini-grammars, which a minimal DOT parser has no reason to implement.
// These two functions are that: just enough to read a label's `<port>`
// declarations and its one plain display-name cell back out.

// Graphviz record label: cells separated by `|`, each either plain text
// (the device's display name -- there should be exactly one such cell)
// or `<port> text` (declares a port named `port`). Doesn't support
// record's `{ }` sub-row grouping -- nothing here needs a multi-row
// record, and a device that does can use an HTML-like label instead.
function parseRecordLabel(label) {
  const ports = [];
  let name = null;
  for (const rawCell of label.split('|')) {
    const cell = rawCell.trim();
    const m = cell.match(/^<([^>]+)>\s*(.*)$/);
    if (m) {
      ports.push(m[1]);
    } else if (cell && name == null) {
      name = cell;
    }
  }
  return { name, ports };
}

// HTML-like label: an XML fragment (Graphviz's HTML labels are XML, not
// permissive HTML), so DOMParser's XML mode reads it directly. Ports are
// whatever elements carry a PORT="..." attribute (typically <TD>s); the
// display name is read off the first TABLE's own PORT-less title-ish
// cell if present, otherwise left null (2D-port devices don't strictly
// need a single "name cell" the way a record does).
function parseHtmlLabel(html) {
  const doc = new DOMParser().parseFromString(`<root>${html}</root>`, 'application/xml');
  if (doc.querySelector('parsererror')) return { name: null, ports: [] };
  const ports = Array.from(doc.querySelectorAll('[PORT]')).map(el => el.getAttribute('PORT'));
  return { name: null, ports };
}

// dotparser represents an `eq` value that was written as an HTML-like
// label (`label=<...>`) as `{ type: 'id', value, html: true }` instead of
// a plain string, to distinguish it from an ordinary quoted string that
// happens to contain angle brackets.
function isHtmlLabelValue(v) {
  return v != null && typeof v === 'object' && v.html === true;
}

function parseLabel(eq) {
  if (isHtmlLabelValue(eq)) return parseHtmlLabel(eq.value);
  return parseRecordLabel(String(eq));
}

// --- DOT AST -> model -----------------------------------------------------
//
// dotparser's attr_list is an array of {id, eq} pairs (possibly several
// bracketed groups concatenated) -- flattened here into one plain object,
// which is the only "translation" most of this app needs: downstream
// code reads attrs.kind, attrs.owner etc. directly, the same names used
// in the DOT file itself.
function attrsToObject(attrList) {
  const obj = {};
  for (const a of attrList || []) obj[a.id] = a.eq;
  return obj;
}

// Whether a node is packed into the board's rows or rendered as a free
// box outside it -- see the `place=` entry in the vocabulary comment at
// the top of the file. Purely a routing concern (which DOM parent it
// ends up in -- CSS can't move an element between parents), deliberately
// independent of whether the node has a PEDAL_SPECS entry (that's just
// physical calibration -- real width, jack coordinates -- and plenty of
// free nodes have one too, e.g. the telecaster, just so their image
// scales to true width like a pedal's).
const VALID_PLACES = new Set(['board', 'free']);

function makeNode(id, attrs) {
  const spec = PEDAL_SPECS[id] || null;
  const label = attrs.label != null ? parseLabel(attrs.label) : { name: null, ports: [] };
  const place = attrs.place || 'board';
  if (!VALID_PLACES.has(place)) {
    throw new Error(`config.dot: node "${id}" has place="${place}", expected one of ${[...VALID_PLACES].join('/')}`);
  }
  return {
    id,
    name: label.name || id,
    owner: attrs.owner || null,
    place,
    spec,
    image: spec ? '/images/' + spec.file : (attrs.image ? '/images/' + attrs.image : null),
    url: attrs.url || null, // product page to open when the image is clicked, if any
    el: null, // <img> element, filled in during render
  };
}

// Walks a parsed DOT graph's top-level statements in order, collecting
// every node (from an explicit node_stmt or its first appearance in an
// edge -- DOT doesn't require declaring a node before wiring it) and
// every edge, in file order. That order is also board layout order (see
// packRows) -- same role the old custom syntax's line order played.
//
// pedal_power is handled specially: it's a real node in the DOT graph
// (so `pedal_power:hc9_1 -> brig:power [kind=power]` reads naturally),
// but it doesn't go through PEDAL_SPECS or ordinary row-packing -- it
// gets its own synthesized node (matching POWER_SUPPLY) and its own row,
// same as before.
function buildModel(ast) {
  const graph = ast[0];
  if (!graph) throw new Error('config.dot: no graph found');

  const nodeAttrs = new Map(); // id -> attrs object (from any node_stmt seen)
  const order = []; // ids, first-seen order
  const edges = []; // { fromId, fromPort, toId, toPort, attrs }
  const rankGroups = []; // arrays of ids, one array per `{ rank=same; ... }` block

  function see(id) {
    if (!nodeAttrs.has(id)) {
      nodeAttrs.set(id, {});
      order.push(id);
    }
  }

  function walk(stmt) {
    if (stmt.type === 'node_stmt') {
      const id = stmt.node_id.id;
      see(id);
      Object.assign(nodeAttrs.get(id), attrsToObject(stmt.attr_list));
    } else if (stmt.type === 'edge_stmt') {
      const attrs = attrsToObject(stmt.attr_list);
      for (let i = 0; i < stmt.edge_list.length - 1; i++) {
        const from = stmt.edge_list[i], to = stmt.edge_list[i + 1];
        if (!from.port || !to.port) {
          throw new Error(`config.dot: edge ${from.id} -> ${to.id} is missing a :port on one or both ends`);
        }
        see(from.id);
        see(to.id);
        edges.push({ fromId: from.id, fromPort: from.port.id, toId: to.id, toPort: to.port.id, attrs });
      }
    } else if (stmt.type === 'subgraph' && stmt.children) {
      // A `{ rank=same; a; b; c; }` block is a subgraph whose children are
      // one graph-level attr_stmt (rank=same) plus a bare node_stmt per
      // member (dotparser's shape for it, confirmed by hand -- there's no
      // separate AST node type for "rank group"). Walk it like any other
      // subgraph (so the members still get `see()`d and their own attrs
      // merged), and additionally collect their ids as one row group, in
      // the order listed.
      const isRankSame = stmt.children.some(c =>
        c.type === 'attr_stmt' && c.target === 'graph' &&
        (c.attr_list || []).some(a => a.id === 'rank' && String(a.eq) === 'same')
      );
      const groupIds = [];
      stmt.children.forEach(c => {
        walk(c);
        if (isRankSame && c.type === 'node_stmt') groupIds.push(c.node_id.id);
      });
      if (isRankSame && groupIds.length) rankGroups.push(groupIds);
    }
  }
  (graph.children || []).forEach(walk);

  const psu = {
    id: PEDAL_POWER_ID,
    name: 'Pedal Power 4x4',
    owner: 'Voodoo Lab',
    place: 'free',
    spec: POWER_SUPPLY,
    image: '/images/' + POWER_SUPPLY.file,
    url: (nodeAttrs.get(PEDAL_POWER_ID) || {}).url || null,
    el: null,
  };
  const nodes = new Map(); // id -> node object
  for (const id of order) {
    nodes.set(id, id === PEDAL_POWER_ID ? psu : makeNode(id, nodeAttrs.get(id)));
  }

  const links = edges.map(e => {
    let kind = e.attrs.kind || 'through';
    // Power edges get a more specific kind for rendering purposes --
    // 'power-hc' for the 400mA "high current" outputs (hc9_*/hc12_* --
    // see POWER_SUPPLY) vs plain 'power' for the 100mA "isolated" ones
    // (iso*) -- derived from the PSU-side port name rather than a
    // separate config.dot attribute, since that naming already encodes
    // it and config.dot shouldn't have to repeat it.
    if (kind === 'power') {
      const psuPort = e.fromId === PEDAL_POWER_ID ? e.fromPort : (e.toId === PEDAL_POWER_ID ? e.toPort : null);
      if (psuPort && psuPort.startsWith('hc')) kind = 'power-hc';
    }
    return {
      from: nodes.get(e.fromId),
      fromPoint: e.fromPort,
      to: nodes.get(e.toId),
      toPoint: e.toPort,
      kind,
    };
  });

  // Board layout order, in first-seen order, spec or not (renderPage
  // splits it by `place` from there). The PSU is only included if it's
  // actually wired to something -- same as any other node, it just has
  // no way to end up unwired other than a config.dot that doesn't
  // bother, since it's synthesized rather than declared.
  const psuHasPower = links.some(l => l.from === psu || l.to === psu);
  const nodeList = order
    .filter(id => id !== PEDAL_POWER_ID || psuHasPower)
    .map(id => nodes.get(id));
  const rowGroups = rankGroups.map(ids => ids.map(id => nodes.get(id)));

  return { nodeList, links, psu, rowGroups };
}

// --- Renderer -----------------------------------------------------------

function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children || []) {
    if (child != null) node.append(child);
  }
  return node;
}

// `baseWidthPx` is always a *scale=1* width (see the Board layout section
// below) -- stashed on the element's dataset so applyScale() can rescale it
// later without either side needing to recompute or re-look-up anything.
function sizedImage(src, alt, baseWidthPx, approx) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  img.dataset.baseWidth = baseWidthPx;
  img.style.width = Math.round(baseWidthPx) + 'px';
  img.style.height = 'auto';
  if (approx) img.classList.add('approx');
  return img;
}

// Every box gets the node's own DOT id as its HTML id -- generally useful
// as a hook for one-off styling tweaks.
function renderNodeBox(node, baseWidthPx) {
  const box = el('div', 'node-box');
  box.id = node.id;
  if (node.image) {
    // Without an explicit width, an absolutely-positioned box (every free
    // node, see renderPage) shrink-wraps to its widest *content* -- for a
    // long device name (the Telecaster's especially) that's the label
    // text on one unwrapped line, not the image, so the box silently
    // renders far wider than nodeSizePx ever told the placement math to
    // expect, and everything downstream of that width (this node's own
    // position, anything placed relative to it) ends up wrong -- this is
    // what free items overlapping the rectangle traced back to. Pinning
    // the box to the image's own width forces the label to wrap under it
    // instead, which is what measureLabelHeights already measured against.
    box.dataset.baseWidth = baseWidthPx;
    const img = sizedImage(node.image, node.name, baseWidthPx, node.spec && node.spec.approx);
    node.el = img; // shapeInfoFor/localRect read the <img> itself, regardless of whether it's link-wrapped below
    if (node.url) {
      const link = el('a', null, [img]);
      link.href = node.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = `${node.name} — product page`;
      box.append(link);
    } else {
      box.append(img);
    }
  } else {
    box.classList.add('no-image');
  }
  box.append(el('div', 'node-name', [document.createTextNode(node.name)]));
  if (node.owner) {
    box.append(el('div', 'node-owner', [document.createTextNode(node.owner)]));
  }
  return box;
}

// --- Board layout -----------------------------------------------------
//
// Computes the whole page's geometry in JS, at "scale=1" (i.e. the same px
// values a scale of 1 always renders at -- see applyScale, near main()),
// then main() solves for the largest scale that fits the viewport with no
// scrolling. Two things are searched for, in this order: (1) how many rows
// the on-board chain's freely-packable runs break into (see
// candidateRowPlans/widthForRowCount) -- primarily to keep the resulting
// rectangle's aspect ratio close to what the viewport wants (a better fit
// there directly means a bigger achievable scale, i.e. less uncovered
// space), tie-broken by minimizing total connector length; (2) for that
// choice of rows, exactly where each `place="free"` node ends up: its own
// real (x, y) around the rectangle (see placeFreeItems), not a bucket in
// a fixed grid, by the same wire-length metric. Both searches are small
// and exact (n is ~15) -- no randomness, so results are reproducible and
// (re-)explainable.

const ROW_GAP_X_PX = 48;    // horizontal gap between pedals in a row -- keep in sync with .chain's base gap in style.css
const ROW_GAP_Y_PX = 1.6;   // vertical gap between stacked rows -- keep in sync with .board-rows's base gap
const BOARD_LOWER_GAP_PX = 40; // gap between the row-stack and the sidebar (DVP5) -- keep in sync with .board-lower's base gap
const BOARD_PADDING_X_PX = 32; // .board left/right padding, base
const BOARD_PADDING_Y_PX = 28; // .board top/bottom padding, base
const COMPASS_GAP_PX = 16;  // gap between free items sharing a compass side, and between a side and the board
const MAX_ROWS_PER_RUN = 12; // row-count search cap -- one row per pedal, for any realistic pedal count

// The 3 items rule 4 allows to deviate from true real-world scale --
// everything else (pedals, PSU, DVP5, P-Split) always renders at true
// relative size. Sized against a fraction of the winning row height (see
// nodeSizePx) rather than their own real width/height.
const FLEXIBLE_SIZE_IDS = new Set(['telecaster', 'twin_reverb', 'ironball']);
const FLEX_MIN_RATIO = 0.5, FLEX_MAX_RATIO = 2.5;

// Power edges get a much lower weight in the wire-length objective than
// signal/exp cables: nobody's judging this rig by how short its power
// leads are, and letting them compete equally with signal-path wire length
// would happily wreck a clean signal layout just to shave a few px off a
// power cable. Not zero -- a small weight still keeps the PSU from landing
// somewhere arbitrary when it's otherwise a tie -- just far from equal.
const WIRE_WEIGHT = { power: 0, 'power-hc': 0 };
function wireWeight(kind) { return WIRE_WEIGHT[kind] ?? 1; }

// True real-world-scale width, before the solved `scale` is applied --
// every node except the 3 FLEXIBLE_SIZE_IDS ones renders at this.
function nodeRealWidthPx(node) {
  return node.spec ? node.spec.widthMm * PX_PER_MM : DEFAULT_WIDTH_PX;
}

// Real (photographed) aspect ratio, read once by preloadImages (see
// main()) before any layout math happens -- geometry needs actual height,
// not just width, and "height:auto" only exists once something is in the
// DOM, which is too late for a pre-render solve.
function nodeAspect(node) {
  return node.image ? (node.naturalH / node.naturalW) : (90 / 120); // no-image boxes: match .node-box.no-image's fixed footprint
}

// A node's base (scale=1) box size. Real-scale for everything except the 3
// flexible items, which instead target a height clamped to
// [FLEX_MIN_RATIO, FLEX_MAX_RATIO] * refRowH (the shortest row in the
// winning row plan) -- see the FLEXIBLE_SIZE_IDS comment above.
// `h` here is the node-box's *total* footprint (image + label block below
// it -- see measureLabelHeights), not just the image: every position in
// this file is now rendered literally (position:absolute, see renderPage),
// so a node's real footprint has to include everything CSS would
// otherwise have quietly wrapped around, or two boxes placed "just
// touching" by this math end up actually overlapping once each one's
// name/owner text renders for real. `w` stays image-only -- it's what
// sizedImage actually sets on the <img>, and nothing here reserves extra
// *horizontal* space for a label wider than its own image (a longstanding
// simplification, not new).
function nodeSizePx(node, refRowH) {
  const aspect = nodeAspect(node);
  const labelH = node.labelH || 0;
  if (FLEXIBLE_SIZE_IDS.has(node.id)) {
    const naturalTotalH = nodeRealWidthPx(node) * aspect + labelH;
    const totalH = Math.max(FLEX_MIN_RATIO * refRowH, Math.min(FLEX_MAX_RATIO * refRowH, naturalTotalH));
    const imgH = Math.max(1, totalH - labelH);
    return { w: imgH / aspect, h: totalH };
  }
  const w = nodeRealWidthPx(node);
  return { w, h: w * aspect + labelH };
}

// Greedily bin-packs a chain into rows that each fit within maxWidthPx,
// using each node's real rendered width -- keeps consecutive (adjacent in
// the signal chain) pedals next to each other, only breaking to a new row
// once the current one is full. Order-preserving (declaration order stays
// intact, see the "Reordering" decision in the plan) -- the only thing
// under this function's control is *where* it breaks.
function packRows(chain, maxWidthPx) {
  const rows = [[]];
  let used = 0;
  for (const node of chain) {
    const w = nodeRealWidthPx(node);
    const row = rows[rows.length - 1];
    if (row.length > 0 && used + ROW_GAP_X_PX + w > maxWidthPx) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push(node);
    used += (rows[rows.length - 1].length > 1 ? ROW_GAP_X_PX : 0) + w;
  }
  return rows;
}

// The smallest maxWidthPx that packs `items` into at most `k` rows, found
// by binary search on the answer using packRows itself as the feasibility
// check -- exact, and reuses packRows rather than reimplementing
// bin-packing a second way. Lower bound is 0, not the widest single
// item's own width: that bound would be correct for the *different*
// problem of optimally partitioning into exactly k groups minimizing the
// largest group's sum (where every group must hold at least its own
// widest member) -- packRows is a plain greedy left-to-right packer, and
// a fresh (empty) row always accepts its first item regardless of the
// threshold (see packRows: the width check only applies once
// `row.length > 0`), so a threshold *below* the widest item is still
// perfectly valid, it just means that item ends up alone. Starting `lo`
// too high silently made some row counts unreachable (e.g. two different
// k's could converge on the same threshold and yield the same actual row
// count, one k short of what was actually achievable).
function widthForRowCount(items, k) {
  const widths = items.map(nodeRealWidthPx);
  if (k <= 1) return widths.reduce((a, w) => a + w, 0) + Math.max(0, items.length - 1) * ROW_GAP_X_PX;
  if (k >= items.length) return Math.max(...widths);
  let lo = 0, hi = widths.reduce((a, w) => a + w, 0);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (packRows(items, mid).length <= k) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Splits the on-board chain into fixed segments (an explicit `{ rank=same;
// ... }` group from config.dot, rendered as exactly one row, in the order
// listed) and free-packable segments (everything else, handed to
// packRows/widthForRowCount) -- same split buildRows used to do, just
// returned as data instead of immediately packed at one fixed width.
function segmentBoard(onBoard, rowGroups) {
  const onBoardSet = new Set(onBoard);
  const groupOf = new Map(); // node -> its group's node array
  for (const group of rowGroups) {
    const members = group.filter(n => onBoardSet.has(n));
    if (!members.length) continue;
    for (const n of members) groupOf.set(n, members);
  }

  const segments = [];
  let pending = [];
  const flush = () => { if (pending.length) segments.push({ fixed: false, nodes: pending }); pending = []; };
  const emitted = new Set();
  for (const node of onBoard) {
    if (emitted.has(node)) continue; // already emitted as part of an earlier group
    const group = groupOf.get(node);
    if (group) {
      flush();
      segments.push({ fixed: true, nodes: group });
      group.forEach(n => emitted.add(n));
    } else {
      pending.push(node);
    }
  }
  flush();
  return segments;
}

// Yields every candidate full row plan: one row-count choice per
// free-packable segment, cross-producted (capped -- current configs only
// ever have one such segment, so this is just that segment's own options;
// guarded anyway against a future config with more than one).
function* candidateRowPlans(onBoard, rowGroups) {
  const segments = segmentBoard(onBoard, rowGroups);
  const freeSegIdxs = segments.map((s, i) => (s.fixed ? -1 : i)).filter(i => i >= 0);
  const optionsPerSeg = freeSegIdxs.map(i => {
    const cap = Math.min(segments[i].nodes.length, MAX_ROWS_PER_RUN);
    return Array.from({ length: cap }, (_, k) => k + 1);
  });

  function* cross(i, acc) {
    if (i === optionsPerSeg.length) { yield acc; return; }
    for (const k of optionsPerSeg[i]) yield* cross(i + 1, [...acc, k]);
  }

  let count = 0;
  for (const combo of cross(0, [])) {
    if (++count > 64) break; // sanity cap on the cross-product
    const rows = [];
    let ci = 0;
    for (const seg of segments) {
      if (seg.fixed) { rows.push(seg.nodes); continue; }
      const k = combo[ci++];
      // Both ends of the row-count range are built directly rather than
      // via packRows + a computed width threshold: k=1 (one row) would
      // need a threshold exactly equal to the items' own total width,
      // which risks a false split from ordinary floating-point summation
      // error right at that boundary (packRows' own `>` check landing on
      // the wrong side of an intended tie); k >= seg.nodes.length (one row
      // per node) can't be reached via *any* threshold at all -- packRows
      // still greedily combines any adjacent items that together fit
      // under it, however small the threshold, so it's built directly
      // instead of asking packRows to (re-)discover either shape.
      let rowsForSeg;
      if (k <= 1) rowsForSeg = [seg.nodes];
      else if (k >= seg.nodes.length) rowsForSeg = seg.nodes.map(n => [n]);
      else rowsForSeg = packRows(seg.nodes, widthForRowCount(seg.nodes, k));
      rows.push(...rowsForSeg);
    }
    yield rows;
  }
}

// Computes every node's local {x, y, w, h} (top-left origin at the
// row-stack's own top-left) for one row plan, mirroring the actual CSS:
// .board-rows stacks rows, and each row alternates direction
// (row-reverse on every other one, same rule renderPage's rowEl className
// uses) so that consecutive rows' "joining" pedals -- the actual endpoints
// of the one chain edge that crosses the row break -- land on the same
// side, the snake pattern that keeps that transition short. Reused by both
// the solver (scale=1 sizes) and, indirectly, real rendering (same rows,
// same alternation, just scaled).
// `flip` XORs into every row's own alternation bit -- a single global
// left/right mirror of the whole rectangle. Alternation itself (odd rows
// reversed relative to even ones) stays on regardless: it's what keeps a
// chain edge that crosses a row break short (the two pedals it connects
// land on the same side, one row above the other), and that's still true
// under either flip state, just mirrored along with everything else.
// *Which* of the two flip states is better is a real, and cheap, second
// thing to search for (see solveLayout) -- worth doing because it's the
// only lever that changes which literal edge of the rectangle a given
// pedal (e.g. StroboStomp, wired to the guitar) ends up on, which a
// free node's own wire length (see placeFreeItems) very much cares about,
// and because a *single* row has no adjacent row to alternate against in
// the first place, so without a flip choice it would always render
// mirrored for no reason at all.
function measureRows(rows, flip) {
  const pos = new Map();
  let y = 0;
  let width = 0;
  // .board-rows is `flex-direction: column-reverse` (see style.css), so
  // rows[0] -- the first one appended to the DOM, in renderPage -- ends up
  // rendered at the *bottom*, not the top, and each following row stacks
  // upward from there. Walking the array back-to-front here, while
  // accumulating y top-down, is what makes this function's y values
  // actually match that rendering, not just each row's own internal
  // (order-independent) height sum -- matters for telling a free node
  // "above" from "below" correctly (see placeFreeItems), not for
  // in-rectangle wire length, which only ever depends on *relative*
  // positions and so was never affected by this. `reversed` still keys off
  // each row's own original array index (rowIdx), matching renderPage's
  // identical rule for its row-reverse className -- that's a left/right
  // alternation, independent of which order rows are walked in here.
  for (let rowIdx = rows.length - 1; rowIdx >= 0; rowIdx--) {
    const row = rows[rowIdx];
    const reversed = (rowIdx % 2 === 0) !== flip;
    let x = 0;
    let rowH = 0;
    row.forEach((node, i) => {
      const { w, h } = nodeSizePx(node, 0); // refRowH unused for non-flexible on-board nodes
      if (i > 0) x += ROW_GAP_X_PX;
      pos.set(node, { x, y, w, h });
      x += w;
      rowH = Math.max(rowH, h);
    });
    if (reversed) {
      for (const node of row) {
        const p = pos.get(node);
        p.x = x - p.x - p.w;
      }
    }
    width = Math.max(width, x);
    y += rowH + ROW_GAP_Y_PX;
  }
  return { pos, width, height: rows.length ? y - ROW_GAP_Y_PX : 0 };
}

function portPoint(pos, node, which) {
  const p = pos.get(node);
  const frac = jackFraction(node, which);
  if (!p || !frac) return null;
  return { x: p.x + frac.x * p.w, y: p.y + frac.y * p.h };
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// Total wire length for every link whose both ends currently have a known
// position, weighted per wireWeight -- the rule-3/rule-5 tie-break metric,
// shared by the row-count search and the free-item placement search.
function totalWireLength(links, pos) {
  let total = 0;
  for (const link of links) {
    const a = portPoint(pos, link.from, link.fromPoint);
    const b = portPoint(pos, link.to, link.toPoint);
    if (a && b) total += manhattan(a, b) * wireWeight(link.kind);
  }
  return total;
}

const COMPASS_SIDES = ['above', 'left', 'right', 'below'];

// Which rectangle edge a point is nearest, in the rectangle's own local
// frame (0,0)-(boardW,boardH) -- and, along that edge, the coordinate
// (x for above/below, y for left/right) a node anchored to that point
// would ideally sit at. Point can be anywhere, inside the rectangle or
// arbitrarily far outside it (a free node's own connections routinely put
// its anchor well past the rectangle's own bounds): clamping the point
// into the rectangle first is what finds the true nearest boundary point
// when it's outside (a clamped coordinate that actually moved is exactly
// the one that was pinned to an edge); a point already inside instead
// picks whichever of the 4 edges it's closest to, same rule jackEdge uses
// for a jack fraction.
function nearestEdge(boardW, boardH, px, py) {
  const cx = Math.min(boardW, Math.max(0, px));
  const cy = Math.min(boardH, Math.max(0, py));
  const xPinned = cx !== px, yPinned = cy !== py;
  if (xPinned || yPinned) {
    const overX = px < 0 ? -px : px - boardW;
    const overY = py < 0 ? -py : py - boardH;
    if (xPinned && (!yPinned || overX >= overY)) return { side: px < 0 ? 'left' : 'right', coord: cy };
    return { side: py < 0 ? 'above' : 'below', coord: cx };
  }
  const d = { above: py, below: boardH - py, left: px, right: boardW - px };
  const side = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
  return { side, coord: (side === 'above' || side === 'below') ? px : py };
}

// A free node's own pull point: the weighted centroid of every connection
// it actually has a resolvable anchor for right now. `resolvedPos` is
// whatever's known at this point in the 2-pass placement below (see
// placeFreeItems) -- board nodes are always in it; a *free* node only
// once its own first-pass position has been computed, which is exactly
// what makes the second pass able to anchor a free<->free edge (e.g.
// P-Split <-> Ironball, or Twin Reverb, which connects to nothing *but*
// P-Split) that the first pass necessarily couldn't.
function freeNodeAnchor(node, links, resolvedPos) {
  let sx = 0, sy = 0, sw = 0;
  for (const l of links) {
    if (l.from !== node && l.to !== node) continue;
    const other = l.from === node ? l.to : l.from;
    const otherPoint = l.from === node ? l.toPoint : l.fromPoint;
    const p = resolvedPos.get(other);
    if (!p) continue;
    const frac = jackFraction(other, otherPoint);
    const a = frac ? { x: p.x + frac.x * p.w, y: p.y + frac.y * p.h } : { x: p.x + p.w / 2, y: p.y + p.h / 2 };
    const wt = wireWeight(l.kind);
    sx += a.x * wt; sy += a.y * wt; sw += wt;
  }
  return sw ? { x: sx / sw, y: sy / sw } : null;
}

// Assigns every free node to whichever rectangle edge its own anchor (see
// freeNodeAnchor) is nearest, grouped by edge -- one round of the 2-pass
// process in placeFreeItems.
function assignEdges(freeNodes, links, resolvedPos, boardW, boardH, refRowH) {
  const bySide = { above: [], left: [], right: [], below: [] };
  for (const node of freeNodes) {
    const { w, h } = nodeSizePx(node, refRowH);
    const anchor = freeNodeAnchor(node, links, resolvedPos);
    // No resolvable anchor at all (not even a free<->free one) can only
    // happen if a node has no edges whatsoever -- buildModel wouldn't have
    // included it in nodeList in the first place, so this is unreachable
    // in practice; the fallback is just defensive.
    const { side, coord } = anchor ? nearestEdge(boardW, boardH, anchor.x, anchor.y) : { side: 'above', coord: boardW / 2 };
    bySide[side].push({ node, w, h, coord });
  }
  return bySide;
}

// Lays same-edge items out along that edge, in ideal-coordinate order,
// nudging later ones forward just enough to clear the one before --
// preserves each item's own ideal position exactly where nothing else
// contends for it, same principle as packRows but along a line instead of
// bin-packing by width.
function layoutAlongEdge(items) {
  const sorted = [...items].sort((a, b) => a.coord - b.coord);
  const starts = new Map();
  let cursor = -Infinity;
  for (const it of sorted) {
    let start = it.coord - it.size / 2;
    if (cursor > -Infinity) start = Math.max(start, cursor);
    starts.set(it.node, start);
    cursor = start + it.size + COMPASS_GAP_PX;
  }
  return starts;
}

// Turns one edge assignment (see assignEdges) into real positions, in the
// rectangle's own local frame -- (0,0) is the rectangle's own top-left,
// and a position here is free to be negative or exceed boardW/boardH
// (e.g. several wide items sharing the top edge can easily need more
// width than the rectangle itself has -- solveLayout finds the true
// overall bounding box afterward, over every node's actual position, not
// just this rectangle's own).
function layoutBySide(bySide, boardW, boardH) {
  const pos = new Map();
  const extents = { above: 0, below: 0, left: 0, right: 0 };
  for (const side of COMPASS_SIDES) {
    const items = bySide[side];
    if (!items.length) continue;
    const horizontal = side === 'above' || side === 'below';
    const along = items.map(it => ({ node: it.node, coord: it.coord, size: horizontal ? it.w : it.h }));
    const reserve = Math.max(...items.map(it => (horizontal ? it.h : it.w))) + COMPASS_GAP_PX;
    extents[side] = reserve;
    const starts = layoutAlongEdge(along);
    for (const it of items) {
      const start = starts.get(it.node);
      const x = side === 'left' ? -reserve : side === 'right' ? boardW + COMPASS_GAP_PX : start;
      const y = side === 'above' ? -reserve : side === 'below' ? boardH + COMPASS_GAP_PX : start;
      pos.set(it.node, { x, y, w: it.w, h: it.h });
    }
  }
  return { pos, extents };
}

// Places every free node -- guitar, amps, the PSU, DVP5's neighbors --
// around the rectangle at its own real (x, y), not bucketed into a fixed
// compass column/row the way a CSS grid would force it to be (a grid
// area's align-items:center throws away exactly the "how far along this
// edge" information the search computes -- see the plan/commit message
// for why that was the actual bug behind free items landing far from
// what they connect to). Two rounds: the first can only anchor a node via
// its connections to *board* nodes (nothing free has a position yet); the
// second re-resolves every node's anchor with the first round's free-node
// positions folded in too, so a free<->free edge -- P-Split <-> Ironball,
// and Twin Reverb, which connects to nothing else -- gets a real anchor
// on both ends instead of an arbitrary fallback.
function placeFreeItems(freeNodes, links, boardPos, boardW, boardH, refRowH) {
  const round1 = layoutBySide(assignEdges(freeNodes, links, boardPos, boardW, boardH, refRowH), boardW, boardH);

  const resolved2 = new Map(boardPos);
  for (const [n, p] of round1.pos) resolved2.set(n, p);
  return layoutBySide(assignEdges(freeNodes, links, resolved2, boardW, boardH, refRowH), boardW, boardH);
}

// Two-tier comparison used across row-plan candidates: primarily maximize
// the achievable scale (rule 1 + rule 5 -- a bad aspect ratio directly
// wastes visible space no matter how tidy the wiring is), tie-broken
// (within a few percent) by minimizing total wire length (rule 3).
function isBetterLayout(a, b) {
  if (a.scale > b.scale * 1.03) return true;
  if (b.scale > a.scale * 1.03) return false;
  return a.wireLength < b.wireLength;
}

// Ties the row-count search and free-item placement search together: for
// each candidate row plan, lay out the rectangle (+ DVP5's sidebar, if
// present), place every free node (see placeFreeItems), find the true
// overall bounding box (rectangle and every free node, all of it -- not
// an approximation from the rectangle's own size plus per-side extents,
// since free items sharing an edge can collectively need more room than
// the rectangle itself has), and score that box against the available
// viewport space. Returns the winning arrangement's absolute position for
// *every* node (`pos`), already shifted so the whole thing starts at
// (0, 0) -- ready for renderPage/applyScale to place directly, no
// grid/flex layout left for the browser to still have an opinion about.
function solveLayout(onBoard, sidebarNodes, freeNodes, links, rowGroups, availW, availH) {
  let best = null;
  for (const rows of candidateRowPlans(onBoard, rowGroups)) {
  for (const flip of [false, true]) {
    const rowGeom = measureRows(rows, flip);

    // DVP5 (if present) sits beside the row-stack, top-aligned, full
    // board-lower height -- same structure as today's .board-sidebar.
    let boardW = rowGeom.width, boardH = rowGeom.height;
    const boardPos = new Map();
    for (const [n, p] of rowGeom.pos) boardPos.set(n, p);
    if (sidebarNodes.length) {
      let sx = rowGeom.width + BOARD_LOWER_GAP_PX;
      for (const n of sidebarNodes) {
        const { w, h } = nodeSizePx(n, 0);
        boardPos.set(n, { x: sx, y: 0, w, h });
        boardH = Math.max(boardH, h);
      }
      boardW = sx + Math.max(...sidebarNodes.map(n => nodeSizePx(n, 0).w));
    }
    for (const [, p] of boardPos) { p.x += BOARD_PADDING_X_PX; p.y += BOARD_PADDING_Y_PX; }
    boardW += 2 * BOARD_PADDING_X_PX;
    boardH += 2 * BOARD_PADDING_Y_PX;

    const rowHeights = rows.map(row => Math.max(...row.map(n => nodeSizePx(n, 0).h), 0));
    const refRowH = rowHeights.length ? Math.min(...rowHeights) : DEFAULT_WIDTH_PX;

    const { pos: freePos } = placeFreeItems(freeNodes, links, boardPos, boardW, boardH, refRowH);

    let minX = 0, minY = 0, maxX = boardW, maxY = boardH;
    for (const [, p] of freePos) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
    }
    const totalW = maxX - minX, totalH = maxY - minY;
    const scale = Math.min(availW / totalW, availH / totalH);

    const pos = new Map();
    for (const [n, p] of boardPos) pos.set(n, { x: p.x - minX, y: p.y - minY, w: p.w, h: p.h });
    for (const [n, p] of freePos) pos.set(n, { x: p.x - minX, y: p.y - minY, w: p.w, h: p.h });
    const wireLength = totalWireLength(links, pos);

    const candidate = { rows, flip, pos, boardOffset: { x: -minX, y: -minY }, boardW, boardH, totalW, totalH, scale, wireLength };
    if (!best || isBetterLayout(candidate, best)) best = candidate;
  }
  }
  return best;
}

// Renders the whole page as one absolutely-positioned canvas
// (.board-canvas, explicit width/height set by applyScale): the rectangle
// (.board -- the packed rows solveLayout chose, plus DVP5's sidebar, if
// present, full-height alongside them, both still plain flex layout
// internally, unchanged) sits at solved.boardOffset, and every
// `place="free"` node (guitar, amps, the PSU...) sits at its own real
// (x, y) from solved.pos -- no grid, no compass buckets, nothing left for
// the browser's own alignment rules to override. Every node's image is
// sized at its base (scale=1) width here; main() calls applyScale
// afterward to bring the whole canvas (position, size, gaps, fonts -- see
// style.css) to the solved scale in one pass.
function renderPage(solved, sidebarNodes, freeNodes) {
  const canvas = el('div', 'board-canvas');
  canvas.dataset.baseWidth = solved.totalW;
  canvas.dataset.baseHeight = solved.totalH;

  const board = el('div', 'board');
  board.dataset.baseLeft = solved.boardOffset.x;
  board.dataset.baseTop = solved.boardOffset.y;
  // board-lower holds just the pedal-row-stack and any sidebar item, side
  // by side -- top-aligned (not stretched/centered) so StroboStomp HD, at
  // the near end of the bottom row right beside the sidebar, has clearance
  // underneath for its `in` jack to route into.
  const boardLower = el('div', 'board-lower');
  const rowStack = el('div', 'board-rows');
  solved.rows.forEach((rowNodes, rowIdx) => {
    const reversed = (rowIdx % 2 === 0) !== solved.flip; // must match measureRows' identical rule exactly, or rendering would disagree with what was actually solved for
    const rowEl = el('div', 'chain board-row' + (reversed ? ' row-reverse' : ''));
    rowNodes.forEach(n => rowEl.append(renderNodeBox(n, nodeSizePx(n, 0).w)));
    rowStack.append(rowEl);
  });
  boardLower.append(rowStack);

  if (sidebarNodes.length) {
    const sidebar = el('div', 'board-sidebar');
    sidebarNodes.forEach(n => sidebar.append(renderNodeBox(n, nodeSizePx(n, 0).w)));
    boardLower.append(sidebar);
  }
  board.append(boardLower);
  canvas.append(board);

  for (const node of freeNodes) {
    const p = solved.pos.get(node);
    const box = renderNodeBox(node, p.w);
    box.classList.add('free');
    box.dataset.baseLeft = p.x;
    box.dataset.baseTop = p.y;
    canvas.append(box);
  }

  return canvas;
}

// --- Connector overlay (libavoid) ------------------------------------------

// Which enclosure edge a jack sits on, from its fractional position --
// whichever edge (top/bottom/left/right) it's closest to. This is what
// "perpendicular to the pedal" means: the wire has to leave in that
// edge's direction before it's allowed to turn.
function jackEdge(frac) {
  const d = { top: frac.y, bottom: 1 - frac.y, left: frac.x, right: 1 - frac.x };
  return Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
}

// libavoid's Avoid::ConnDirFlag bitflags (see connend.h in the Adaptagrams
// source) -- the libavoid-js typings leave this enum as a stub, so the
// values are hardcoded here to match the underlying C++ enum.
const CONN_DIR = { top: 1, bottom: 2, left: 4, right: 8 };

// ShapeConnectionPin's x/yPortionOffset must be strictly within [0,1] --
// a jack calibrated right at an edge can read as e.g. -0.002 (a click a
// pixel outside the cropped photo), which is exactly what should mean
// "this edge", so it's clamped rather than rejected. jackEdge() above
// still runs on the raw, unclamped fraction.
const PIN_PORTION_EPS = 0.001;
function clampPortion(v) {
  return Math.min(1 - PIN_PORTION_EPS, Math.max(PIN_PORTION_EPS, v));
}

// Every edge names its port explicitly (buildModel requires it), and
// every port a device actually declares has a calibrated fraction in
// PEDAL_SPECS -- so this is a direct lookup, no fallback chain needed.
function jackFraction(node, which) {
  return (node.spec && node.spec[which]) || null;
}

// The actual audio signal path (as opposed to power/exp control cables)
// -- see connectorArrows: these 4 kinds get their direction arrows
// classed by direction (colored green/red in style.css) rather than by
// kind, regardless of which of the 4 signal kinds it is. All visual
// styling (stroke color/width, dash pattern, arrow fill) lives in
// style.css's .connector-KIND / .connector-arrow-KIND rules -- this file
// only ever picks which class applies, never a color, so there's one
// place to look for "what does X look like" instead of two.
const SIGNAL_KINDS = new Set(['through', 'loop-out', 'loop-in', 'fork']);

// Turns a routed polyline into a path string with rounded elbows, for the
// same soft-corner look the old jsPlumb Flowchart connector had: each
// interior vertex is shortened on both sides by `radius` and bridged with
// a quadratic curve through the original corner point.
function roundedPathD(points, radius) {
  let d = `M ${points[0][0]} ${points[0][1]} `;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const inX = x - (x - px) / inLen * r, inY = y - (y - py) / inLen * r;
    const outX = x + (nx - x) / outLen * r, outY = y + (ny - y) / outLen * r;
    d += `L ${inX} ${inY} Q ${x} ${y} ${outX} ${outY} `;
  }
  const [lx, ly] = points[points.length - 1];
  return d + `L ${lx} ${ly}`;
}

// libavoid's shapeBufferDistance only guarantees clearance *from the
// shape* -- it says nothing about the length of the specific segment
// that touches the pin. If the router's bend point happens to land
// already level with the pin along the required axis, that final
// "perpendicular" segment can collapse to a fraction of a pixel while a
// long segment one bend further back (needed to reach the pin's
// position along the *other* axis) does all the visible work, parallel
// to the pedal's border right next to it. This restores a real minimum
// by shifting that bend point -- and the one before it, together, so
// the segment between them keeps its own shape -- further from the pin,
// borrowing the extra length from the segment one bend further back.
const MIN_STUB_PX = 14;
// How much extra stub length each successive connector touching the same
// node gets, on top of MIN_STUB_PX -- see the lane-assignment comment on
// wireConnectors for why this is keyed per-node rather than per-kind.
const LANE_STEP_PX = 10;

function ensureMinStub(points, edge, atStart, minLen) {
  if (!edge || points.length < 4) return;
  const axis = (edge === 'top' || edge === 'bottom') ? 1 : 0;
  const step = atStart ? 1 : -1;
  const pinIdx = atStart ? 0 : points.length - 1;
  const bendIdx = pinIdx + step;
  const nextBendIdx = bendIdx + step;
  const thirdIdx = nextBendIdx + step;
  if (thirdIdx < 0 || thirdIdx >= points.length) return;

  const pin = points[pinIdx], bend = points[bendIdx], nextBend = points[nextBendIdx], third = points[thirdIdx];
  const len = Math.abs(bend[axis] - pin[axis]);
  if (len >= minLen) return;
  // bend[axis] == pin[axis] in the degenerate (near-)zero-length case, so
  // there's no direction to read off the collapsed segment itself --
  // fall back to how the path continues past it.
  const dir = Math.sign(bend[axis] - pin[axis]) || Math.sign(third[axis] - nextBend[axis]) || 1;
  const shift = (minLen - len) * dir;

  // The segment (nextBend -> third) is what actually shrinks to pay for
  // this -- don't borrow more than it has, or the path would invert.
  const available = Math.abs(third[axis] - nextBend[axis]);
  if (Math.abs(shift) >= available - 1) return;

  bend[axis] += shift;
  nextBend[axis] += shift;
}

const EDGE_AXIS = { top: 1, bottom: 1, left: 0, right: 0 };
const EDGE_SIGN = { top: -1, bottom: 1, left: -1, right: 1 }; // direction, along that axis, that points away from the pedal

// ensureMinStub() borrows length from the segment past the *other* end
// of a short stub -- which doesn't work when both ends are short at
// once, the common case for a plain 4-point "hop" between two adjacent
// pedals whose jacks share an edge (e.g. two top-edge jacks): there's
// nothing to borrow, since the segment it would borrow from *is* the
// other end's own stub. For that specific shape, size the shared middle
// segment once so it clears each pin's own minLen simultaneously,
// instead of shifting each end independently.
function ensureMinStubPair(points, fromEdge, toEdge, fromMinLen, toMinLen) {
  if (points.length !== 4 || !fromEdge || !toEdge) {
    ensureMinStub(points, fromEdge, true, fromMinLen);
    ensureMinStub(points, toEdge, false, toMinLen);
    return;
  }
  if (EDGE_AXIS[fromEdge] !== EDGE_AXIS[toEdge] || EDGE_SIGN[fromEdge] !== EDGE_SIGN[toEdge]) {
    ensureMinStub(points, fromEdge, true, fromMinLen);
    ensureMinStub(points, toEdge, false, toMinLen);
    return;
  }
  const axis = EDGE_AXIS[fromEdge], sign = EDGE_SIGN[fromEdge];
  const pinStart = points[0], pinEnd = points[3];
  const wantStart = pinStart[axis] + sign * fromMinLen;
  const wantEnd = pinEnd[axis] + sign * toMinLen;
  const busCoord = sign < 0 ? Math.min(wantStart, wantEnd) : Math.max(wantStart, wantEnd);
  points[1][axis] = busCoord;
  points[2][axis] = busCoord;
}

const ARROW_LEN_PX = 9;
const ARROW_HALF_WIDTH_PX = 4;
const ARROW_GAP_PX = 3; // breathing room between the pedal border and the arrowhead itself

function unit(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

// An isosceles triangle marking signal direction, tip at `tip` and base
// centered on `base` -- both ends of a connector get one, both pointing
// the same way (source -> target), so a loop-out/loop-in pair (which
// would otherwise look identical) still reads as two opposite flows.
function trianglePointsStr(base, tip, halfWidth) {
  const [bx, by] = base, [tx, ty] = tip;
  const [dx, dy] = unit(tx - bx, ty - by);
  const px = -dy, py = dx;
  return `${tx},${ty} ${bx + px * halfWidth},${by + py * halfWidth} ${bx - px * halfWidth},${by - py * halfWidth}`;
}

// Direction arrows for one routed connector: a small triangle just past
// the source pin pointing forward into the wire (base pulled ARROW_GAP_PX
// off the pedal border, so the arrowhead doesn't sit right on top of it),
// and the mirror-image arrowhead at the target pin (tip held back the
// same gap, base further still into the wire) -- built from the
// polyline's own first/last segments, so they follow whatever libavoid
// actually routed, not an assumed straight line. The wire itself (drawn
// separately from `points`) still runs all the way to the actual pin.
//
// For a signal kind (SIGNAL_KINDS), the two arrows are classed by which
// end they're on -- .connector-arrow-out / -in, colored green/red in
// style.css -- rather than by kind, so a loop-out/loop-in pair (which
// would otherwise look identical) still reads as two opposite flows
// regardless of which of the 4 signal kinds it is. Power/exp arrows keep
// their own kind's class (and thus color) on both ends, same as the
// line itself.
function connectorArrows(points, kind) {
  const [sx, sy] = points[0], [sx2, sy2] = points[1];
  const startForward = unit(sx2 - sx, sy2 - sy);
  const startBase = [sx + startForward[0] * ARROW_GAP_PX, sy + startForward[1] * ARROW_GAP_PX];
  const startTip = [sx + startForward[0] * (ARROW_GAP_PX + ARROW_LEN_PX), sy + startForward[1] * (ARROW_GAP_PX + ARROW_LEN_PX)];

  const [ex, ey] = points[points.length - 1], [ex2, ey2] = points[points.length - 2];
  const endForward = unit(ex - ex2, ey - ey2);
  const endTip = [ex - endForward[0] * ARROW_GAP_PX, ey - endForward[1] * ARROW_GAP_PX];
  const endBase = [ex - endForward[0] * (ARROW_GAP_PX + ARROW_LEN_PX), ey - endForward[1] * (ARROW_GAP_PX + ARROW_LEN_PX)];

  const isSignal = SIGNAL_KINDS.has(kind);
  const ends = [
    { pts: trianglePointsStr(startBase, startTip, ARROW_HALF_WIDTH_PX), cls: isSignal ? 'out' : kind },
    { pts: trianglePointsStr(endBase, endTip, ARROW_HALF_WIDTH_PX), cls: isSignal ? 'in' : kind },
  ];
  return ends.map(({ pts, cls }) => {
    const polygon = document.createElementNS(SVG_NS, 'polygon');
    polygon.setAttribute('points', pts);
    polygon.setAttribute('class', 'connector-arrow-' + cls);
    return polygon;
  });
}

// Clearance libavoid keeps between a wire and any pedal -- this is also
// what enforces "perpendicular for a minimum length before bending": a
// pin's connector is the only thing allowed to cross a shape's buffer
// zone, and only in its fixed exit direction (see CONN_DIR below), so
// raising this raises the guaranteed straight run before the first turn.
// Ceiling: must stay under half the tightest gap in the layout or two
// pedals' buffer zones start overlapping -- currently the tightest is
// .board-rows's own gap (see style.css), which is well under double
// this value, so that corridor specifically may still run tighter than
// this promises; widen that gap if wires there need to stay clear too.
const SHAPE_BUFFER_PX = 18;
// Extra clearance baked directly into each image's own obstacle
// rectangle (see shapeInfoFor) -- a fallback for where SHAPE_BUFFER_PX's
// router-level clearance doesn't hold (see its comment above). Same
// tight-corridor caveat applies: can't create room that isn't there.
const OBSTACLE_MARGIN_PX = 5;
const CORNER_RADIUS_PX = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Registers every node touched by a link as a libavoid obstacle (a
// ShapeRef matching its rendered rectangle, relative to `root`) plus one
// ShapeConnectionPin per jack actually used, then asks the router to
// compute every route in a single pass. Unlike jsPlumb's Flowchart
// connector -- which computes each path independently from just its own
// two endpoints, with no awareness of any other connector or of the
// pedals themselves -- libavoid treats every pedal as an obstacle to
// route around (so a wire can no longer cross a pedal's face) and, via
// the nudge* routing options below, actively separates any two segments
// that would otherwise land on the same line. That's a property of the
// router, not a per-link patch, so it holds for any config.dot, not just
// the cases seen so far.
function wireConnectors(Avoid, root, sections) {
  const rootRect = root.getBoundingClientRect();
  const localRect = imgEl => {
    const r = imgEl.getBoundingClientRect();
    return { left: r.left - rootRect.left, top: r.top - rootRect.top, right: r.right - rootRect.left, bottom: r.bottom - rootRect.top };
  };

  // libavoid-js's enum members are embind objects wrapping the real
  // number in `.value` (e.g. Avoid.RouterFlag.OrthogonalRouting.value),
  // not plain numbers as the (beta, community) typings claim -- and the
  // routing-type constant used for the Router itself is a distinct enum
  // (RouterFlag) from the one used per-connector (ConnType).
  const ORTHOGONAL_ROUTER = Avoid.RouterFlag.OrthogonalRouting.value;
  const ORTHOGONAL_CONN = Avoid.ConnType.ConnType_Orthogonal.value;

  const router = new Avoid.Router(ORTHOGONAL_ROUTER);
  router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance.value, SHAPE_BUFFER_PX);
  // libavoid's nudging options (nudgeOrthogonal*, performUnifyingNudging-
  // PreprocessingStep, nudgeSharedPathsWithCommonEndPoint) were used here
  // to keep parallel connectors from overlapping, but they also nudge a
  // connector's own endpoint off its actual pin -- confirmed by disabling
  // them: Tim.loopOut -> Brig.in went from a collapsed, ~30px-mispositioned
  // straight line to a correctly-shaped, sub-pixel-accurate route once
  // nudging was off. A pin landing on the wrong jack is worse than two
  // wires running close together, so nudging is out; overlap prevention
  // needs a different mechanism (see TODO below).

  const shapes = new Map(); // node -> { shape, w, h } (w/h are the *unpadded* image size, in local px)
  const pins = new Map(); // node -> Map(pointName -> classId)
  let nextClassId = 1;

  // The routing obstacle is the image's own box plus OBSTACLE_MARGIN_PX
  // on every side, so a connector can't graze a pedal's edge even where
  // SHAPE_BUFFER_PX's router-level clearance doesn't hold (see its
  // comment above) -- belt and suspenders, not a replacement for it.
  // Padding the *shape* only, and not the pin fractions along with it,
  // would silently drag every jack off its calibrated spot toward the
  // shape's new, larger center; paddedFraction() below re-expresses each
  // pin's original 0-1 fraction (calibrated against the real image) in
  // the padded shape's own coordinate space instead, so it still lands
  // on the actual photographed jack.
  function paddedFraction(frac, sizePx) {
    return (OBSTACLE_MARGIN_PX + frac * sizePx) / (sizePx + 2 * OBSTACLE_MARGIN_PX);
  }

  function shapeInfoFor(node) {
    if (shapes.has(node)) return shapes.get(node);
    if (!node.el) return null;
    const r = localRect(node.el);
    const rect = new Avoid.Rectangle(
      new Avoid.Point(r.left - OBSTACLE_MARGIN_PX, r.top - OBSTACLE_MARGIN_PX),
      new Avoid.Point(r.right + OBSTACLE_MARGIN_PX, r.bottom + OBSTACLE_MARGIN_PX)
    );
    const shape = new Avoid.ShapeRef(router, rect);
    const info = { shape, w: r.right - r.left, h: r.bottom - r.top };
    shapes.set(node, info);
    return info;
  }

  function shapeFor(node) {
    return shapeInfoFor(node)?.shape || null;
  }

  function pinFor(node, which) {
    let byPoint = pins.get(node);
    if (!byPoint) {
      byPoint = new Map();
      pins.set(node, byPoint);
    }
    if (byPoint.has(which)) return byPoint.get(which);
    const frac = jackFraction(node, which);
    const info = frac && shapeInfoFor(node);
    let classId = null;
    if (frac && info) {
      classId = nextClassId++;
      const px = paddedFraction(frac.x, info.w), py = paddedFraction(frac.y, info.h);
      new Avoid.ShapeConnectionPin(info.shape, classId, clampPortion(px), clampPortion(py), true, 0, CONN_DIR[jackEdge(frac)]);
    }
    byPoint.set(which, classId);
    return classId;
  }

  // Two *different* connectors landing on the same corridor only happens
  // when they converge near a shared node -- every connector has its own
  // distinct pair of endpoints, so with plain obstacle-avoiding routing
  // (no nudging) two connectors that don't share a node essentially never
  // pick the same path. What does happen: a node whose two used ports
  // sit close together on the same edge (e.g. Brig's in=0.81/out=0.571,
  // both near the top) gets two independent connectors -- one touching
  // each port -- whose shortest paths naturally want the same nearby
  // corridor near that node, regardless of whether the node is acting as
  // source or target in either link (Brig is a target in one of these
  // and a source in the other). So lanes are counted per node, counting
  // every connector that touches it at all -- not split by source vs.
  // target side, which would miss exactly this case.
  const nodeLane = new Map(); // node -> next lane index to hand out
  function nextLane(node) {
    const n = nodeLane.get(node) ?? 0;
    nodeLane.set(node, n + 1);
    return n;
  }

  const drawList = []; // { connRef, kind }
  for (const { links } of sections) {
    for (const link of links) {
      const fromShape = shapeFor(link.from);
      const toShape = shapeFor(link.to);
      const fromClass = pinFor(link.from, link.fromPoint);
      const toClass = pinFor(link.to, link.toPoint);
      if (!fromShape || !toShape || fromClass == null || toClass == null) continue;
      const connRef = new Avoid.ConnRef(router, new Avoid.ConnEnd(fromShape, fromClass), new Avoid.ConnEnd(toShape, toClass));
      connRef.setRoutingType(ORTHOGONAL_CONN);
      const fromEdge = jackEdge(jackFraction(link.from, link.fromPoint));
      const toEdge = jackEdge(jackFraction(link.to, link.toPoint));
      const fromMinLen = MIN_STUB_PX + nextLane(link.from) * LANE_STEP_PX;
      const toMinLen = MIN_STUB_PX + nextLane(link.to) * LANE_STEP_PX;
      const label = `${link.from.name}.${link.fromPoint} -> ${link.to.name}.${link.toPoint}`;
      drawList.push({ connRef, kind: link.kind, fromEdge, toEdge, fromMinLen, toMinLen, label });
    }
  }

  router.processTransaction();

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'connector-overlay');
  for (const { connRef, kind, fromEdge, toEdge, fromMinLen, toMinLen, label } of drawList) {
    const poly = connRef.displayRoute();
    const points = [];
    for (let i = 0; i < poly.size(); i++) {
      const p = poly.at(i);
      points.push([p.x, p.y]);
    }
    if (points.length < 2) continue;
    ensureMinStubPair(points, fromEdge, toEdge, fromMinLen, toMinLen);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', roundedPathD(points, CORNER_RADIUS_PX));
    path.setAttribute('class', 'connector-' + kind);
    path.setAttribute('data-link', label);
    svg.append(path);
    // No direction arrows on an exp cable -- unlike audio (through/loop/
    // fork, one-way source->target) or power (PSU->pedal, also one-way),
    // an expression jack is a two-way control loop: the receiving pedal
    // supplies a reference voltage out to the pot, the wiper position
    // comes back in on the same cable. An arrowhead would claim a
    // directionality that isn't really there.
    if (kind !== 'exp') {
      for (const arrow of connectorArrows(points, kind)) svg.append(arrow);
    }
  }
  root.append(svg);
}

function nextFrame() {
  return new Promise(res => requestAnimationFrame(res));
}

// Delays `fn` until `waitMs` after the *last* call -- window resize fires
// continuously while the user drags, and both a full relayout and a full
// wireConnectors re-route are too heavy (the latter rebuilds every
// libavoid obstacle/pin and re-routes every connector) to redo on each
// individual event.
function debounce(fn, waitMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

function waitForImages(container) {
  const imgs = Array.from(container.querySelectorAll('img'));
  return Promise.all(
    imgs.map(img => (img.complete ? Promise.resolve() : new Promise(res => {
      img.addEventListener('load', res, { once: true });
      img.addEventListener('error', res, { once: true });
    })))
  );
}

// Reads every node's real (photographed) naturalWidth/naturalHeight before
// any layout math happens -- the geometry solver (see the Board layout
// section) needs real aspect ratios, not just widths, and needs them
// *before* building any DOM. Off-DOM Image() objects, not <img> elements
// appended somewhere temporary: nothing here needs to be visible, and the
// browser cache means the real <img> elements renderPage creates later
// reuse this same fetch instead of downloading twice. Missing/broken image
// files resolve (not reject) with a 1x1 fallback aspect so a single bad
// path can't hang the whole page.
function preloadImages(nodeList) {
  return Promise.all(nodeList.filter(n => n.image).map(node => new Promise(resolve => {
    const img = new Image();
    img.onload = () => { node.naturalW = img.naturalWidth; node.naturalH = img.naturalHeight; resolve(); };
    img.onerror = () => { node.naturalW = 1; node.naturalH = 1; resolve(); };
    img.src = node.image;
  })));
}

// Measures every node's real label-block height (name + owner, if any --
// see renderNodeBox) at its real (scale=1) rendered width, once, before
// any layout math runs, and stashes it as node.labelH for nodeSizePx to
// read -- see that function's comment for why a node's real total
// footprint, not a guessed constant, is what geometry needs now that
// nothing is left to CSS flow layout to reconcile against actual content.
// A real DOM measurement, not a formula: the Telecaster's name alone is
// long enough to wrap 2-3 lines depending on width, which no constant
// could get right for every node. Built inside a `section.config` host so
// `--ui-scale`'s default of 1 (see style.css) resolves the exact same
// calc()s real rendering uses. A `no-image` node has no image to size
// against and isn't part of any width-bearing row/free-item math either,
// so it's left at 0 -- its own fixed min-height (see .node-box.no-image)
// covers it.
function measureLabelHeights(nodeList) {
  const host = el('section', 'config');
  host.style.position = 'absolute';
  host.style.visibility = 'hidden';
  host.style.left = '-9999px';
  host.style.top = '0';
  const probe = el('div', 'node-box');
  host.append(probe);
  document.body.append(host);

  for (const node of nodeList) {
    if (!node.image) { node.labelH = 0; continue; }
    // Constraining the probe itself to the same width the real box will
    // be pinned to (see renderNodeBox) is what makes this measurement
    // mean anything -- an unconstrained flex column sizes to its widest
    // *child*, and with no width to wrap against, the name would measure
    // as one long unwrapped line here regardless of how it actually
    // renders. (For the 3 FLEXIBLE_SIZE_IDS nodes this is still only an
    // approximation -- their real final width isn't known until a row
    // height is, later -- using their natural real width tends to
    // under-measure slightly, since the bracket almost always narrows
    // them further, which only wraps a label *more*. Every other node's
    // width is fixed, so this is exact for them.)
    const w = Math.round(nodeRealWidthPx(node));
    probe.style.width = w + 'px';
    const spacer = document.createElement('div');
    spacer.style.width = w + 'px';
    spacer.style.marginBottom = 'calc(0.5rem * var(--ui-scale))'; // mirrors .node-box img's own margin-bottom
    const children = [spacer, el('div', 'node-name', [document.createTextNode(node.name)])];
    if (node.owner) children.push(el('div', 'node-owner', [document.createTextNode(node.owner)]));
    probe.replaceChildren(...children);
    node.labelH = probe.offsetHeight;
  }
  host.remove();
}

// How much px space the board actually has to work with. #app is a
// flex:1 item in body's column layout (see style.css) -- its own
// getBoundingClientRect is already exactly "the viewport, minus the
// header and body's padding", computed by the browser instead of
// reimplemented by hand here (and, thanks to #app's min-height:0, this
// stays accurate even mid-resize while it still holds the previous,
// possibly oversized board -- flex-shrink lets #app's own box shrink to
// its fair share regardless of content, content can overflow it instead).
// Doesn't depend on anything the layout solver computes, so, unlike the
// old fitToViewport, this never needs a render-measure-render cycle: it's
// just as valid to call before the board exists as after.
function availableSpace() {
  const rect = document.getElementById('app').getBoundingClientRect();
  return { availW: Math.max(200, rect.width), availH: Math.max(200, rect.height) };
}

// Applies a solved scale directly -- real px, no CSS zoom/transform (see
// the plan: zoom's mobile quirks, combined with any resize-triggered
// recompute, are what caused the old scroll/resize feedback loop). Every
// image's base (scale=1) width was stashed on its own dataset by
// sizedImage; --ui-scale drives everything else that needs to track it
// (gaps, padding, font sizes -- see style.css's calc(... * var(--ui-scale))
// rules).
// `data-base-*` is the same one convention every absolutely-positioned or
// explicitly-sized thing here uses for its own scale=1 value -- an <img>'s
// own width (see sizedImage), .board-canvas's overall width/height (so it
// has a real size for #app's flex centering to center against -- an
// absolutely-positioned child, which every direct child of .board-canvas
// now is, contributes nothing to a normal parent's own size), and every
// absolutely-positioned node's left/top (the rectangle itself, and every
// free node -- see renderPage). One attribute name, one lookup here,
// regardless of which of those a given element needs.
function applyScale(section, scale) {
  section.style.setProperty('--ui-scale', scale);
  for (const el of section.querySelectorAll('[data-base-width]')) {
    el.style.width = Math.round(parseFloat(el.dataset.baseWidth) * scale) + 'px';
  }
  for (const el of section.querySelectorAll('[data-base-height]')) {
    el.style.height = Math.round(parseFloat(el.dataset.baseHeight) * scale) + 'px';
  }
  for (const el of section.querySelectorAll('[data-base-left]')) {
    el.style.left = Math.round(parseFloat(el.dataset.baseLeft) * scale) + 'px';
  }
  for (const el of section.querySelectorAll('[data-base-top]')) {
    el.style.top = Math.round(parseFloat(el.dataset.baseTop) * scale) + 'px';
  }
}

async function main() {
  // index.html?config=NAME loads NAME.dot instead of the default
  // config.dot -- see the vocabulary comment.
  const configName = new URLSearchParams(location.search).get('config') || 'config';
  const text = await fetch(`${configName}.dot`).then(res => res.text());
  // dotparser.min.js is a UMD build (global `dotParser`, not an ES
  // export), loaded via a classic <script> tag in index.html before this
  // one, so it's already on window here.
  const ast = window.dotParser.parse(text);
  const { nodeList, links, rowGroups } = buildModel(ast);
  await preloadImages(nodeList);
  measureLabelHeights(nodeList);

  const onBoard = nodeList.filter(n => n.place === 'board' && !(n.spec && n.spec.sidebar));
  const sidebarNodes = nodeList.filter(n => n.place === 'board' && n.spec && n.spec.sidebar);
  const freeNodes = nodeList.filter(n => n.place === 'free');

  const root = document.getElementById('app');
  const section = el('section', 'config');
  root.append(section);
  const sections = [{ links, section }]; // .el filled in below, once the board actually exists

  const { AvoidLib } = await import('./libs/libavoid/index.js');
  await AvoidLib.load();
  const avoid = AvoidLib.getInstance();

  // Re-routing rebuilds the whole overlay from scratch (wireConnectors
  // always appends a fresh <svg>), so the previous one has to go first or
  // they'd stack up, one per resize.
  function route() {
    const old = root.querySelector('.connector-overlay');
    if (old) old.remove();
    wireConnectors(avoid, root, sections);
  }

  // Rebuilds the board from scratch at whatever scale currently fits --
  // needed (not just a rescale) because a resize can change *how many
  // rows* or *which compass side* the solve picks, not just how big
  // everything renders. Images are already cached from preloadImages, so
  // this doesn't need its own waitForImages wait to know real sizes --
  // only two animation frames to guarantee the browser has actually
  // reflowed the freshly-appended DOM before anything reads its geometry
  // (an image's own `load` event, if one somehow still fires here, can
  // land a frame before that reflow).
  async function relayout() {
    const { availW, availH } = availableSpace();
    const solved = solveLayout(onBoard, sidebarNodes, freeNodes, links, rowGroups, availW, availH);
    section.replaceChildren();
    const boardGrid = renderPage(solved, sidebarNodes, freeNodes);
    section.append(boardGrid);
    sections[0].el = boardGrid;
    applyScale(section, solved.scale);

    await nextFrame();
    await nextFrame();

    // One bounded corrective pass, never re-triggered by itself (only a
    // genuine resize re-enters relayout) -- guards against the solver's
    // model of gap/font/padding sizes not being *perfectly* linear in
    // scale (font metrics/kerning round to whole pixels), not a
    // measure-adjust-loop the way the old fitToViewport's zoom was.
    const rect = boardGrid.getBoundingClientRect();
    if (rect.width > availW + 1 || rect.height > availH + 1) {
      const corr = Math.min(availW / rect.width, availH / rect.height);
      applyScale(section, solved.scale * corr);
    }
  }

  async function relayoutAndRoute() {
    await relayout();
    route();
  }

  await relayoutAndRoute();

  // Routes drawn against mid-resize geometry would be visibly wrong for
  // the whole debounce wait -- pedals already moved/rescaled, wires still
  // pointing at where they used to be. Hide the (now stale) overlay on the
  // very first resize event, before the debounce even starts its wait;
  // relayoutAndRoute's route() replaces it with a fresh (default-visible)
  // one once it actually runs, so there's nothing to explicitly un-hide.
  //
  // Only innerWidth/innerHeight actually changing schedules a relayout --
  // guards against mobile browsers firing `resize` for reasons that don't
  // change either (e.g. the dynamic toolbar's own show/hide animation),
  // which is exactly the kind of event that fed the old feedback loop.
  let lastW = window.innerWidth, lastH = window.innerHeight;
  const scheduleRelayout = debounce(() => {
    if (window.innerWidth === lastW && window.innerHeight === lastH) return;
    lastW = window.innerWidth; lastH = window.innerHeight;
    relayoutAndRoute();
  }, 150);
  window.addEventListener('resize', () => {
    const overlay = root.querySelector('.connector-overlay');
    if (overlay) overlay.style.visibility = 'hidden';
    scheduleRelayout();
  });
}

main();
