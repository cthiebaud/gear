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
//                                  bordered rectangle's rows. Every
//                                  rendered node also gets id="<node id>"
//                                  in the HTML -- *where* a "free" node
//                                  actually ends up is a pure CSS
//                                  question, not this app's: see below.
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
// width-based packing would otherwise put them (see buildRows). It's
// real Graphviz syntax (same-tier grouping), not an app-specific
// invention, so the file stays valid input to `dot -Tsvg` too.
//
// Multiple rigs, one page: index.html?config=NAME loads NAME.dot instead
// of the default config.dot, and -- convention over configuration, same
// basename -- also loads NAME.css if it exists (a plain <link>, added at
// runtime; see loadConfigStylesheet in main()). That file is entirely
// optional and entirely CSS: it's where a "free" node's actual position
// gets set, by id (e.g. `#telecaster { grid-area: right; }`), against
// the named-area grid .board-grid establishes in style.css (above / left
// / board / right / below). Missing the file just means every free node
// falls back to the grid's default auto-placement -- ugly, not broken.

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
    file: 'fen5250041346_01.png',
    widthMm: 160,
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

function sizedImage(src, alt, widthPx, approx) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  img.style.width = Math.round(widthPx) + 'px';
  img.style.height = 'auto';
  if (approx) img.classList.add('approx');
  return img;
}

// Every box gets the node's own DOT id as its HTML id -- the hook a
// per-config stylesheet (see loadConfigStylesheet in main()) uses to
// position a "free" node, and generally useful for one-off tweaks later.
function renderNodeBox(node) {
  const box = el('div', 'node-box');
  box.id = node.id;
  if (node.image) {
    const img = node.spec
      ? sizedImage(node.image, node.name, node.spec.widthMm * PX_PER_MM, node.spec.approx)
      : sizedImage(node.image, node.name, DEFAULT_WIDTH_PX, false);
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

// Assumed real width of one row of the board rectangle, in mm -- just
// where a row breaks, not rendered as anything itself. 520mm keeps the
// current pedal set to 2 rows (roughly a Pedaltrain Classic 1); a
// compact 3-row board like a Pedaltrain Classic Jr would be closer to
// 450mm. Tune to taste.
const BOARD_ROW_WIDTH_MM = 520;
const BOARD_ROW_WIDTH_PX = BOARD_ROW_WIDTH_MM * PX_PER_MM;
const ROW_GAP_PX = 48; // keep in sync with .chain { gap } in style.css

function nodeWidthPx(node) {
  return node.spec ? node.spec.widthMm * PX_PER_MM : DEFAULT_WIDTH_PX;
}

// Greedily bin-packs a flat chain into rows that each fit within
// BOARD_ROW_WIDTH_PX, using each node's real rendered width. This is
// what actually minimizes total cable run for a fixed serial chain on a
// fixed-width multi-row board: keep consecutive pedals adjacent, and
// only break to a new row when the current one is full.
function packRows(chain, maxWidthPx) {
  const rows = [[]];
  let used = 0;
  for (const node of chain) {
    const w = nodeWidthPx(node);
    const row = rows[rows.length - 1];
    if (row.length > 0 && used + ROW_GAP_PX + w > maxWidthPx) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push(node);
    used += (rows[rows.length - 1].length > 1 ? ROW_GAP_PX : 0) + w;
  }
  return rows;
}

// Lays out the on-board chain into rows, honoring explicit `{ rank=same;
// ... }` groups from config.dot (see buildModel) ahead of automatic
// packing: a node that's part of a group is never auto-packed -- the
// whole group becomes exactly one row, in the order listed, wherever its
// members would otherwise have come up in the chain. Runs of nodes with
// no group are handed to packRows exactly as before, so a config.dot
// with no rank=same blocks at all behaves identically to plain packRows.
function buildRows(onBoard, rowGroups, maxWidthPx) {
  const onBoardSet = new Set(onBoard);
  const groupOf = new Map(); // node -> its group's node array
  for (const group of rowGroups) {
    const members = group.filter(n => onBoardSet.has(n));
    if (!members.length) continue;
    for (const n of members) groupOf.set(n, members);
  }

  const rows = [];
  let pending = [];
  const flushPending = () => {
    if (pending.length) rows.push(...packRows(pending, maxWidthPx));
    pending = [];
  };

  const emitted = new Set();
  for (const node of onBoard) {
    if (emitted.has(node)) continue; // already rendered as part of an earlier group
    const group = groupOf.get(node);
    if (group) {
      flushPending();
      rows.push(group);
      group.forEach(n => emitted.add(n));
    } else {
      pending.push(node);
    }
  }
  flushPending();
  return rows;
}

// Renders the whole page as a grid (.board-grid, 5 named areas -- above /
// left / board / right / below, established in style.css): `place="free"`
// nodes (guitar, amps, the PSU, anything with nothing a player needs to
// reach) are appended directly as its children, each carrying its own
// `id` so a per-config stylesheet can drop it into whichever named area
// (and exact spot within it) it wants via `grid-area`/`justify-self`/etc
// -- this function has no opinion on where a free node ends up, only
// that it's a plain box outside the board. Everything else (the
// default, "on top of the board") goes inside the one bordered
// rectangle in the grid's "board" area -- most of it packed into a
// snaking two- (or more-)row layout by real width (see buildRows), but a
// spec flagged `sidebar` (an expression pedal: much deeper front-to-back
// than any stompbox, so packing it into a row like the others would
// badly distort that row's height) instead renders full-height alongside
// the packed rows, inside that same rectangle. nodeList is already flat
// and in file order (see buildModel) -- there's no tree to flatten
// anymore, DOT's edges carry the topology directly.
function renderPage(nodeList, rowGroups) {
  const onBoard = nodeList.filter(n => n.place === 'board' && !(n.spec && n.spec.sidebar));
  const sidebarNodes = nodeList.filter(n => n.place === 'board' && n.spec && n.spec.sidebar);
  const freeNodes = nodeList.filter(n => n.place === 'free');

  const grid = el('div', 'board-grid');

  const board = el('div', 'board');

  // board-lower holds just the pedal-row-stack and any sidebar item,
  // side by side -- top-aligned (not stretched/centered) so StroboStomp
  // HD, at the near end of the bottom row right beside the sidebar, has
  // clearance underneath for its `in` jack to route into.
  const boardLower = el('div', 'board-lower');
  const rowStack = el('div', 'board-rows');
  const rows = buildRows(onBoard, rowGroups, BOARD_ROW_WIDTH_PX);
  rows.forEach((rowNodes, rowIdx) => {
    const rowEl = el('div', 'chain board-row' + (rowIdx % 2 === 0 ? ' row-reverse' : ''));
    rowNodes.forEach(n => rowEl.append(renderNodeBox(n)));
    rowStack.append(rowEl);
  });
  boardLower.append(rowStack);

  if (sidebarNodes.length) {
    const sidebar = el('div', 'board-sidebar');
    sidebarNodes.forEach(n => sidebar.append(renderNodeBox(n)));
    boardLower.append(sidebar);
  }

  board.append(boardLower);
  grid.append(board);
  freeNodes.forEach(n => grid.append(renderNodeBox(n)));

  return grid;
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

// Scales `section` down (or up) so it fits entirely within the current
// viewport, the way object-fit:contain fits an image into its box --
// whichever axis is tighter (view width vs. the diagram's real width,
// view height vs. its real height) sets the scale, so nothing overflows
// and nothing is cropped. Uses CSS zoom, not transform:scale: zoom also
// shrinks the box's own layout footprint, so #app (and the page) don't
// keep reserving space for the diagram's full, unscaled size -- the
// same reason a genuinely smaller image wouldn't leave blank space
// around it either. Horizontal centering is a plain width:fit-content +
// margin:0 auto rule on section.config in style.css, not something
// computed here -- see that rule's own comment for why it's block
// centering and not flex justify-content (which would throw off the
// measurement below).
//
// Vertical centering can't lean on the same trick: CSS only auto-
// centers a block box on its *horizontal* margins in normal flow --
// `margin-top: auto` computes to 0, it doesn't self-center -- and a
// flex/grid ancestor would reintroduce exactly the symmetric-overflow
// problem the horizontal rule's comment describes, just on the other
// axis. So this computes the leftover vertical space by hand, once the
// section's final scaled height is known, and splits it evenly into a
// marginTop -- set on `section.parentElement`, not `section` itself:
// zoom scales *every* length of the element it's applied to, margins
// included, so a marginTop set directly on the zoomed section would get
// shrunk right back down by finalScale (nearly invisible at small
// scales). The parent isn't zoomed, so a margin there renders at the
// real pixel value computed below. It's applied only *after* zoom is
// set to its final value (never during the natural-size measurement
// below), so it can't skew that measurement the way a permanent
// flex/grid ancestor would.
//
// "Available space" isn't simply the viewport size: body padding, this
// section's own margin, a header, anything else sharing the page all
// eat into it too, and offsetWidth/offsetHeight (naturalW/naturalH)
// don't include an element's own margin. Rather than hand-list every
// padding/margin that could push the page past one viewport (fragile --
// breaks again the next time spacing changes anywhere on the page), the
// document's full natural scrollWidth/scrollHeight minus the section's
// own size stands in for "all the fixed chrome around it," whatever
// that happens to be, and gets subtracted from the viewport instead.
//
// Resets zoom and marginTop first so every call measures the page's
// true natural size, not whatever scale/offset a previous call left
// behind.
function fitToViewport(section) {
  const parent = section.parentElement;
  section.style.zoom = 1;
  parent.style.marginTop = '';
  const naturalW = section.offsetWidth;
  const naturalH = section.offsetHeight;
  if (!naturalW || !naturalH) return;
  const chromeW = document.documentElement.scrollWidth - naturalW;
  const chromeH = document.documentElement.scrollHeight - naturalH;
  const scale = Math.min(
    (window.innerWidth - chromeW) / naturalW,
    (window.innerHeight - chromeH) / naturalH
  );
  const finalScale = scale > 0 ? scale : 1;
  section.style.zoom = finalScale;
  const leftoverH = window.innerHeight - chromeH - naturalH * finalScale;
  parent.style.marginTop = leftoverH > 0 ? `${leftoverH / 2}px` : '';
}

// Delays `fn` until `waitMs` after the *last* call -- window resize
// fires continuously while the user drags, and both fitToViewport and a
// full wireConnectors re-route are too heavy (the latter rebuilds every
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

// Adds NAME.css as a <link>, if it exists -- the per-config stylesheet
// that positions that config's "free" nodes (see the vocabulary comment
// at the top of the file). Missing is not an error: a config that
// hasn't been given one yet just falls back to .board-grid's default
// auto-placement, so this always resolves, never rejects.
function loadConfigStylesheet(name) {
  return new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${name}.css`;
    link.onload = () => resolve();
    link.onerror = () => {
      console.warn(`pedalboard: no ${link.href} (using .board-grid's default placement)`);
      link.remove();
      resolve();
    };
    document.head.appendChild(link);
  });
}

async function main() {
  // index.html?config=NAME loads NAME.dot + NAME.css instead of the
  // default config.dot (+ config.css) -- see the vocabulary comment.
  const configName = new URLSearchParams(location.search).get('config') || 'config';

  const [text] = await Promise.all([
    fetch(`${configName}.dot`).then(res => res.text()),
    loadConfigStylesheet(configName),
  ]);
  // dotparser.min.js is a UMD build (global `dotParser`, not an ES
  // export), loaded via a classic <script> tag in index.html before this
  // one, so it's already on window here.
  const ast = window.dotParser.parse(text);
  const { nodeList, links, rowGroups } = buildModel(ast);

  const root = document.getElementById('app');
  const boardGrid = renderPage(nodeList, rowGroups);

  const section = el('section', 'config', [
    boardGrid,
  ]);
  root.append(section);
  const sections = [{ el: boardGrid, links, section }];

  await waitForImages(boardGrid);
  // An image's `load` event can fire a frame before the browser has
  // actually reflowed the page, so a route computed synchronously here
  // would read stale (often zero-size) positions. Wait for two animation
  // frames to guarantee a real layout pass has happened.
  await nextFrame();
  await nextFrame();

  const { AvoidLib } = await import('./libs/libavoid/index.js');
  await AvoidLib.load();
  const avoid = AvoidLib.getInstance();

  // Re-routing rebuilds the whole overlay from scratch (wireConnectors
  // always appends a fresh <svg>), so the previous one has to go first
  // or they'd stack up, one per resize.
  function route() {
    const old = root.querySelector('.connector-overlay');
    if (old) old.remove();
    wireConnectors(avoid, root, sections);
  }

  // fitToViewport changes section's rendered (and, via zoom, layout)
  // size, which is exactly what route()'s obstacle/pin positions are
  // read from -- so it always runs first, both on first paint and on
  // every resize, or the wires would be routed against stale geometry.
  function fitAndRoute() {
    fitToViewport(section);
    route();
  }

  fitAndRoute();
  // Routes drawn against mid-drag geometry would be visibly wrong for
  // the whole 150ms the debounce is waiting out -- pedals already
  // moved/rescaled, wires still pointing at where they used to be. Hide
  // the (now stale) overlay on the very first resize event, before the
  // debounce even starts its wait; fitAndRoute's route() replaces it
  // with a fresh (default-visible) one once it actually runs, so there's
  // nothing to explicitly un-hide.
  const scheduleFitAndRoute = debounce(fitAndRoute, 150);
  window.addEventListener('resize', () => {
    const overlay = root.querySelector('.connector-overlay');
    if (overlay) overlay.style.visibility = 'hidden';
    scheduleFitAndRoute();
  });
}

main();
