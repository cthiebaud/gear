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
//                                  scaling, which some free nodes have
//                                  just so their image scales like a
//                                  pedal's) instead of the default,
//                                  "on top of the board", packed into the
//                                  bordered rectangle's rows. *Where*
//                                  around the board a "free" node actually
//                                  ends up (which compass side) is
//                                  computed, not configured -- see
//                                  placeFreeItems.
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
// `<port>` names declared in that device's DOT record/HTML label exactly
// -- that's the only place the two are tied together. `stub: F` overrides,
// for that one jack, the minimum straight run wireConnectors otherwise
// computes before its connector's first bend (MIN_STUB_PX, plus
// LANE_STEP_PX per further connector sharing the node -- see
// wireConnectors) -- e.g. `stub: 0` for a jack where that computed
// minimum reads as an awkward kink against a neighboring pedal. F is a
// fraction of *this device's own* real-world width (nodeRealWidthPx),
// same convention as x/y above, not an absolute px count -- a stub
// tuned by eye on one pedal's photo should still look proportionally
// right if that pedal's widthMm or config.json's shared PX_PER_MM ever
// changes, rather than silently drifting into an absolute length that
// no longer matches the device it was tuned against. Nothing else about
// routing changes: the connector's own lane index is still consumed as
// usual (so later connectors on the same node still get spaced past
// it), only the length it's compared against is replaced.
// `sidebar: true` renders the node beside the packed rows instead of
// inside one (see renderPage). Loaded at runtime from a JSON file
// (`${configName}.json`, see main()) rather than baked in here, same
// "edit data, not code" reasoning as config.dot itself; empty until
// then.
let PEDAL_SPECS = {};

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
// free nodes have one too, just so their image scales to true width like
// a pedal's).
const VALID_PLACES = new Set(['board', 'free']);

// A PEDAL_SPECS entry's `file` is either a plain "Foo.png" (one static
// photo) or a ["Foo-off.png", "Foo-on.png"] pair -- a node with the pair
// gets its whole photo swapped between them instead of relying solely on
// the drawn .led-dot overlay (see setLedImage/renderNodeBox): some panels
// (the Ironball's row of little indicator lights) read far better as an
// actually-lit photo than a synthetic dot. Off-first by position, not by
// filename convention, so config.json is the only place this is decided --
// nothing here parses filenames to guess which is which, and nothing ever
// requests a variant this array doesn't actually list.
function makeNode(id, attrs) {
  const spec = PEDAL_SPECS[id] || null;
  const label = attrs.label != null ? parseLabel(attrs.label) : { name: null, ports: [] };
  const place = attrs.place || 'board';
  if (!VALID_PLACES.has(place)) {
    throw new Error(`config.dot: node "${id}" has place="${place}", expected one of ${[...VALID_PLACES].join('/')}`);
  }
  const hasLedImages = !!(spec && Array.isArray(spec.file));
  const image = spec
    ? '/images/' + (hasLedImages ? spec.file[0] : spec.file)
    : (attrs.image ? '/images/' + attrs.image : null);
  return {
    id,
    name: label.name || id,
    owner: attrs.owner || null,
    place,
    spec,
    image,
    hasLedImages,
    ledOffSrc: hasLedImages ? image : null,
    ledOnSrc: hasLedImages ? '/images/' + spec.file[1] : null,
    ledIsOn: false, // tracked explicitly rather than read off the dot's own classList -- a hasLedImages node deliberately never gets the dot's 'on' class (see settleLedOn/renderNodeBox), so there'd be nothing in the DOM to read it back from

    url: attrs.url || null, // product page to open when the image is clicked, if any
    el: null, // <img> element, filled in during render
  };
}

// Whatever's patched into a loop-out/loop-in pair (e.g. Electric Blue
// Chorus -> Capistan -> BlueSky, between Ironball's send and return) is
// visually part of the loop even though each of those interior edges is
// its own ordinary `through`/`fork` connector -- being "inside a loop" is
// a fact about the edge's place in the chain, not something worth
// authoring on the edge itself in config.dot (rearrange what's patched
// into a loop and it would just be wrong until someone remembered to
// retag it). So it's derived here, once, by walking forward from the
// loop-out's target until the matching loop-in's source is reached, and
// flagging every link crossed along the way (see link.insideLoop, read
// back in wireConnectors). Also doubles as a config.dot sanity check: a
// loop-out with no way back to its own node is almost certainly a typo.
function markLoopInteriorLinks(links) {
  const outgoing = new Map(); // node id -> its own outgoing links
  for (const link of links) {
    if (!outgoing.has(link.from.id)) outgoing.set(link.from.id, []);
    outgoing.get(link.from.id).push(link);
  }

  // Plain DFS path search, backtracking on dead ends (undoing `visited`
  // on the way back out) so one branch's dead end doesn't wrongly rule
  // out reaching the same node via a different one.
  function findPath(fromId, toId, visited) {
    if (fromId === toId) return [];
    visited.add(fromId);
    for (const link of outgoing.get(fromId) || []) {
      if (visited.has(link.to.id)) continue;
      const rest = findPath(link.to.id, toId, visited);
      if (rest) return [link, ...rest];
    }
    visited.delete(fromId);
    return null;
  }

  for (const loopOut of links) {
    if (loopOut.kind !== 'loop-out') continue;
    const master = loopOut.from.id;
    const loopIn = links.find(l => l.kind === 'loop-in' && l.to.id === master);
    if (!loopIn) {
      throw new Error(`config.dot: "${master}" has a loop-out but no loop-in back into it`);
    }
    const path = findPath(loopOut.to.id, loopIn.from.id, new Set());
    if (!path) {
      throw new Error(`config.dot: "${master}"'s loop-out (into "${loopOut.to.id}") never reaches its loop-in (from "${loopIn.from.id}") -- check what's patched into the loop`);
    }
    for (const link of path) link.insideLoop = true;
  }
}

// Walks a parsed DOT graph's top-level statements in order, collecting
// every node (from an explicit node_stmt or its first appearance in an
// edge -- DOT doesn't require declaring a node before wiring it) and
// every edge, in file order. That order is also board layout order (see
// packRows) -- same role the old custom syntax's line order played.
//
// A power supply node is an ordinary node like any other (see the
// PEDAL_SPECS entry) -- it just always has place="free" in config.dot,
// so it's laid out beside the board like the guitar or an amp rather
// than packed into a row, and its `id:port -> id2:port2` edges read the
// same as any other device's.
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

  const nodes = new Map(); // id -> node object
  for (const id of order) {
    nodes.set(id, makeNode(id, nodeAttrs.get(id)));
  }

  const links = edges.map(e => {
    const kind = e.attrs.kind || 'through';
    return {
      from: nodes.get(e.fromId),
      fromPoint: e.fromPort,
      to: nodes.get(e.toId),
      toPoint: e.toPort,
      kind,
    };
  });

  markLoopInteriorLinks(links);

  // Board layout order, in first-seen order, spec or not (renderPage
  // splits it by `place` from there).
  const nodeList = order.map(id => nodes.get(id));
  const rowGroups = rankGroups.map(ids => ids.map(id => nodes.get(id)));

  return { nodeList, links, rowGroups };
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

// node-name background for any node whose config.json spec has no
// dominantColor of its own (see renderNodeBox) -- RAL 7021 (Schwarzgrau).
const DEFAULT_NODE_COLOR = '#23282B';

// Picks black or white for text over `hexColor`, by standard YIQ perceived
// brightness -- used to keep a pedal's own dominantColor (config.json)
// readable as a node-name background regardless of how light or dark it is.
function contrastingTextColor(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? '#000000' : '#ffffff';
}

// `baseWidthPx` is always a *scale=1* width (see the Board layout section
// below) -- stashed on the element's dataset so applyScale() can rescale it
// later without either side needing to recompute or re-look-up anything.
function sizedImage(src, alt, baseWidthPx) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  img.dataset.baseWidth = baseWidthPx;
  img.style.width = Math.round(baseWidthPx) + 'px';
  img.style.height = 'auto';
  return img;
}

// Builds one <svg> from a MUSIC_ICONS entry (see assignSoundIcons, further
// down) -- 'fill' glyphs paint solid with currentColor (optionally
// fill-rule: evenodd, where the source icon relies on it for a punched-out
// notehead), 'stroke' glyphs are line art, currentColor'd the same way.
// Each icon keeps its own source viewBox/transform rather than all being
// normalized to one, since flattening every glyph's own coordinate system
// down to a shared box isn't worth the risk of mistranscribing one.
function buildMusicIcon(iconDef) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', iconDef.viewBox);
  for (const d of iconDef.paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    if (iconDef.transform) path.setAttribute('transform', iconDef.transform);
    if (iconDef.mode === 'stroke') {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', iconDef.strokeWidth);
      if (iconDef.strokeLinecap) {
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
      }
    } else {
      path.setAttribute('fill', 'currentColor');
      if (iconDef.fillRule) path.setAttribute('fill-rule', iconDef.fillRule);
    }
    svg.append(path);
  }
  return svg;
}

// A pedal's own attached sound (config.json's `eatfruit` override, or the
// shared default -- see playArrivalSound) used to fire off the image's own
// click, tangled up with switching its LED on. This button splits that
// back out on its own -- a visitor can preview the sound on demand,
// independent of the LED (see renderNodeBox's imgWrap click handler,
// which no longer plays it). node.soundIcon is assigned once, up front,
// by assignSoundIcons -- see its own comment for why.
function renderSoundButton(node) {
  const button = el('button', 'node-sound-toggle');
  button.type = 'button';
  button.title = `${node.name} — play sound`;
  button.append(buildMusicIcon(node.soundIcon));
  button.addEventListener('click', () => playArrivalSound(node.id));
  return button;
}

// Every box gets the node's own DOT id as its HTML id -- generally useful
// as a hook for one-off styling tweaks.
function renderNodeBox(node, baseWidthPx) {
  const box = el('div', 'node-box');
  box.id = node.id;
  // Set below, inside the ledFrac branch -- any node with an LED has a
  // sound worth previewing on demand, board pedal or place="free" alike
  // (see playArrivalSound); read back after the image block to decide
  // whether this node gets its own renderSoundButton.
  let hasSound = false;
  if (node.image) {
    // Without an explicit width, an absolutely-positioned box (every free
    // node, see renderPage) shrink-wraps to its widest *content* -- for a
    // long device name that's the label text on one unwrapped line, not
    // the image, so the box silently
    // renders far wider than nodeSizePx ever told the placement math to
    // expect, and everything downstream of that width (this node's own
    // position, anything placed relative to it) ends up wrong -- this is
    // what free items overlapping the rectangle traced back to. Pinning
    // the box to the image's own width forces the label to wrap under it
    // instead, which is what measureLabelHeights already measured against.
    box.dataset.baseWidth = baseWidthPx;
    const img = sizedImage(node.image, node.name, baseWidthPx);
    node.el = img; // shapeInfoFor/localRect read the <img> itself directly -- no longer ever link-wrapped, see node.url below

    // Shrink-wraps to the image's own rendered box (see calibrate.html's
    // identical .imgwrap) so the LED dot below can be positioned as a
    // plain x/y % -- the same fraction-of-image-box convention the jack
    // points already use (see jackFraction/portPoint) -- without the
    // node-name label underneath throwing off the percentages.
    const imgWrap = el('div', 'img-wrap');
    imgWrap.append(img);

    const ledFrac = jackFraction(node, 'led');
    if (ledFrac) {
      const led = el('div', 'led-dot');
      led.style.left = (ledFrac.x * 100) + '%';
      led.style.top = (ledFrac.y * 100) + '%';
      imgWrap.append(led);
      node.ledEl = led; // read by blinkLed() during traceFrom's cascade, keyed off NODES_BY_ID
      hasSound = true; // playArrivalSound already picks eatfruit vs. eatghost per node.place

      // The product-page link used to wrap the image, which put it in
      // direct competition with this same click for the same small
      // target -- landing on the tiny LED dot instead of the link (or
      // vice versa) was fiddly enough to be annoying. The link has moved
      // to the node-name label below instead, so the whole image is free
      // to mean just one thing: click anywhere on it -- the led-dot
      // included, it's a plain child of imgWrap so the click still
      // bubbles up here -- toggles this LED.
      img.classList.add('led-toggle');
      img.title = `${node.name} — toggle LED`;
      imgWrap.addEventListener('click', () => {
        // hasLedImages: the dot's own 'on' class never gets set at all (see
        // settleLedOn) -- the -on photo already shows it lit for real, so
        // there's no DOM state to toggle() back off of; ledIsOn is this
        // node's only record of which way it's currently switched. 'lit'
        // is a separate, style-free class kept in sync either way -- the
        // .node-sound-toggle visibility hook (see style.css) needs a class
        // it can :has() regardless of which photo path lit the LED.
        const isOn = node.hasLedImages ? !node.ledIsOn : led.classList.toggle('on');
        node.ledIsOn = isOn;
        led.classList.toggle('lit', isOn);
        setLedImage(node, isOn);
        // Always the same manual-click cue, on or off alike -- the
        // pedal's own attached sound (a board pedal's eatfruit clip) lives
        // on renderSoundButton now, not here.
        playOffClick(node.id);
      });
    } else if (!node.url) {
      // No product page and no LED to toggle -- free to repurpose the
      // click instead, tracing the signal path outward from here (see
      // traceFrom). Every node happens to have a url except the guitar,
      // so this is guitar-only today without hardcoding its id -- a
      // future url-less, LED-less node would just become another valid
      // starting point, a reasonable reading of "nothing else to do with
      // a click here" rather than a special case to guard against.
      img.classList.add('node-traceable');
      img.title = `${node.name} — trace signal path (tap again to stop)`;
      TRACEABLE_NODE_ID = node.id; // lets the spacebar shortcut (see toggleCascade) start from here too
      // toggleCascade, not startCascade -- mobile has no spacebar, so
      // this tap is the only stop control touch users get. Without this,
      // a tap while the cascade is already running just no-ops (see
      // startCascade's own cascadeActive guard) and there's no way to cut
      // it short before it finishes on its own.
      img.addEventListener('click', () => toggleCascade());
    } else if (node.id === 'pedal_power') {
      // No LED of its own, but the power supply is the one image that
      // makes sense as a shortcut for the header's power-toggle checkbox
      // (see index.html) -- clicking it shows/hides every power connector
      // on the board, exactly as clicking that checkbox would.
      img.classList.add('node-power-toggle');
      img.title = 'Show/hide power-supply connectors';
      img.addEventListener('click', () => {
        document.getElementById('power-connectors-toggle').click();
      });
    }

    box.append(imgWrap);
  } else {
    box.classList.add('no-image');
  }
  const nameDiv = el('div', 'node-name', [document.createTextNode(node.name)]);
  if (node.url) {
    nameDiv.classList.add('linked');
    nameDiv.title = `${node.name} — product page`;
    nameDiv.tabIndex = 0;
    nameDiv.setAttribute('role', 'link');
    const openProductPage = () => window.open(node.url, '_blank', 'noopener,noreferrer');
    nameDiv.addEventListener('click', openProductPage);
    nameDiv.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openProductPage();
      }
    });
  }
  const bgColor = (node.spec && node.spec.dominantColor) || DEFAULT_NODE_COLOR;
  nameDiv.style.backgroundColor = bgColor;
  nameDiv.style.color = contrastingTextColor(bgColor);
  box.append(nameDiv);
  if (node.owner) {
    box.append(el('div', 'node-owner', [document.createTextNode(node.owner)]));
  }
  if (hasSound) {
    box.append(renderSoundButton(node));
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
const BOARD_LOWER_GAP_PX = 40; // gap between the row-stack and the sidebar -- keep in sync with .board-lower's base gap
const BOARD_PADDING_X_PX = 32; // .board left/right padding, base
const BOARD_PADDING_Y_PX = 28; // .board top/bottom padding, base
const COMPASS_GAP_PX = 30;  // gap between free items sharing a compass side, and between a side and the board
const MAX_ROWS_PER_RUN = 12; // row-count search cap -- one row per pedal, for any realistic pedal count

// Power edges get a much lower weight in the wire-length objective than
// signal/exp cables: nobody's judging this rig by how short its power
// leads are, and letting them compete equally with signal-path wire length
// would happily wreck a clean signal layout just to shave a few px off a
// power cable. Not zero -- a small weight still keeps the PSU from landing
// somewhere arbitrary when it's otherwise a tie -- just far from equal.
const WIRE_WEIGHT = { power: 0 };
function wireWeight(kind) { return WIRE_WEIGHT[kind] ?? 1; }

// No prior breakpoint existed anywhere in this file -- the whole layout
// already solves for whatever scale fits any given viewport (see
// applyScale), phone or desktop alike, so this isn't about making things
// smaller in general (that already happens on its own). It's specifically
// about *relative* proportions: on a narrow screen the guitar/amps/PSU
// (place="free", see the vocabulary comment near VALID_PLACES) can crowd
// out the actual pedalboard, which is the part anyone's really here to
// look at, so those get shrunk relative to the pedals instead of scaling
// down together with them. 600 is an arbitrary but common "phone-sized"
// cutoff -- nothing else in the layout depends on this exact number.
const SMALL_SCREEN_MAX_PX = 600;
const FREE_NODE_SMALL_SCREEN_SCALE = 2 / 3;
function isSmallScreen() {
  return window.innerWidth <= SMALL_SCREEN_MAX_PX;
}

// True real-world-scale width, before the solved `scale` is applied --
// every node renders at this. Read fresh on every relayout (a resize
// re-solves the whole layout from scratch, see relayout() in main()), so
// crossing SMALL_SCREEN_MAX_PX in either direction reliably reflows free
// nodes to the right size, not just whatever it happened to be on load.
function nodeRealWidthPx(node) {
  const w = node.spec ? node.spec.widthMm * PX_PER_MM : DEFAULT_WIDTH_PX;
  return (node.place === 'free' && isSmallScreen()) ? w * FREE_NODE_SMALL_SCREEN_SCALE : w;
}

// Real (photographed) aspect ratio, read once by preloadImages (see
// main()) before any layout math happens -- geometry needs actual height,
// not just width, and "height:auto" only exists once something is in the
// DOM, which is too late for a pre-render solve.
function nodeAspect(node) {
  return node.image ? (node.naturalH / node.naturalW) : (90 / 120); // no-image boxes: match .node-box.no-image's fixed footprint
}

// A node's base (scale=1) box size, at true real-world scale. `h` here is
// the node-box's *total* footprint (image + label block below it -- see
// measureLabelHeights), not just the image: every position in this file
// is now rendered literally (position:absolute, see renderPage), so a
// node's real footprint has to include everything CSS would otherwise
// have quietly wrapped around, or two boxes placed "just touching" by
// this math end up actually overlapping once each one's name/owner text
// renders for real. `w` stays image-only -- it's what sizedImage
// actually sets on the <img>, and nothing here reserves extra
// *horizontal* space for a label wider than its own image (a longstanding
// simplification, not new).
function nodeSizePx(node) {
  const aspect = nodeAspect(node);
  const labelH = node.labelH || 0;
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
// pedal ends up on, which a free node's own wire length (see
// placeFreeItems) very much cares about,
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
      const { w, h } = nodeSizePx(node);
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
// what makes the second pass able to anchor a free<->free edge -- even
// one between two free nodes that connect to nothing else -- that the
// first pass necessarily couldn't.
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
function assignEdges(freeNodes, links, resolvedPos, boardW, boardH) {
  const bySide = { above: [], left: [], right: [], below: [] };
  for (const node of freeNodes) {
    const { w, h } = nodeSizePx(node);
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
// preserving each item's own ideal position exactly where nothing else
// contends for it -- same principle as packRows but along a line instead
// of bin-packing by width. Unlike a plain greedy sweep (nudge each item
// just far enough forward to clear the one before, never revisit), this
// keeps the *whole line* as close as possible, in aggregate, to every
// item's own ideal coord: a collision between two neighbors no longer
// cascades forward through every item after them just because they
// happened to sort later -- only the items actually contending for the
// same stretch of the edge get pulled together, still centered on their
// shared compromise position, while anyone else keeps their own spot.
// Standard isotonic regression (PAVA, pool-adjacent-violators): shift
// each item's ideal coord left by the cumulative minimum gap every
// earlier item in the sort needs before it, so "respects every minimum
// gap" becomes plain "shifted values are non-decreasing" -- solve that
// with PAVA (repeatedly averaging together any adjacent pair that
// violates order), then shift back.
function layoutAlongEdge(items) {
  const sorted = [...items].sort((a, b) => a.coord - b.coord);
  if (!sorted.length) return new Map();

  let cumGap = 0;
  const shifted = sorted.map((it, i) => {
    if (i > 0) cumGap += (sorted[i - 1].size + it.size) / 2 + COMPASS_GAP_PX;
    return it.coord - cumGap;
  });

  const blocks = []; // each: { sum, count, items } -- mean = sum / count
  for (let i = 0; i < shifted.length; i++) {
    let block = { sum: shifted[i], count: 1, items: [sorted[i]] };
    while (blocks.length && blocks[blocks.length - 1].sum / blocks[blocks.length - 1].count > block.sum / block.count) {
      const prev = blocks.pop();
      block = { sum: prev.sum + block.sum, count: prev.count + block.count, items: prev.items.concat(block.items) };
    }
    blocks.push(block);
  }

  const starts = new Map();
  cumGap = 0;
  let prevItem = null;
  for (const block of blocks) {
    const mean = block.sum / block.count;
    for (const it of block.items) {
      if (prevItem) cumGap += (prevItem.size + it.size) / 2 + COMPASS_GAP_PX;
      starts.set(it.node, mean + cumGap - it.size / 2);
      prevItem = it;
    }
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
      // 'above'/'left' sit outside the rectangle, so each item's *near*
      // edge -- its bottom for 'above', its right for 'left' -- is what
      // should sit flush against the gap, not a shared reserve band sized
      // to the tallest/widest item on that side: a short pedal sharing
      // 'above' with a tall amp used to get stranded up near the amp's own
      // top, with dead space (and extra wire) between it and the board
      // it's actually wired into. 'below'/'right' never had this problem
      // -- boardH/boardW + the gap already *is* each item's own near edge,
      // nothing shared to misalign against.
      const x = side === 'left' ? -(it.w + COMPASS_GAP_PX) : side === 'right' ? boardW + COMPASS_GAP_PX : start;
      const y = side === 'above' ? -(it.h + COMPASS_GAP_PX) : side === 'below' ? boardH + COMPASS_GAP_PX : start;
      pos.set(it.node, { x, y, w: it.w, h: it.h });
    }
  }
  return { pos, extents };
}

// Deterministic clean-up pass, run once placeFreeItems is done -- its
// compass-side placement only ever *aims* for clear space along each
// item's assigned edge, it never actually verifies two items sharing a
// side (or a free item and the board rectangle itself) end up
// non-overlapping. Left alone, that's not just cosmetic: libavoid can't
// find a valid orthogonal corridor through two overlapping obstacles and
// falls back to a direct (diagonal) line between whatever pins are
// affected -- confirmed against a real diagonal connector, whose routed
// `d` turned out to be a bare 2-point line straight from libavoid's own
// displayRoute(). Board nodes are never moved here: the row-stack that
// placed them is already non-overlapping by construction (see
// measureRows), so only free-vs-free and free-vs-board pairs need
// separating.
const RESOLVE_OVERLAP_PASSES = 40;
function resolveFreeOverlaps(freePos, boardW, boardH) {
  const margin = COMPASS_GAP_PX / 2;
  const items = [...freePos.values()];
  for (let pass = 0; pass < RESOLVE_OVERLAP_PASSES; pass++) {
    let moved = false;
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        const pi = items[a], pj = items[b];
        const overlapX = Math.min(pi.x + pi.w + margin, pj.x + pj.w + margin) - Math.max(pi.x - margin, pj.x - margin);
        const overlapY = Math.min(pi.y + pi.h + margin, pj.y + pj.h + margin) - Math.max(pi.y - margin, pj.y - margin);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        // Push apart along whichever axis needs the smaller shift -- same
        // "cheapest separation" any AABB-overlap resolver uses.
        if (overlapX < overlapY) {
          const dir = pi.x < pj.x ? -1 : 1;
          pi.x += dir * overlapX / 2;
          pj.x -= dir * overlapX / 2;
        } else {
          const dir = pi.y < pj.y ? -1 : 1;
          pi.y += dir * overlapY / 2;
          pj.y -= dir * overlapY / 2;
        }
      }
    }
    // A free node overlapping the board rectangle itself -- boardW/boardH
    // already include BOARD_PADDING_X/Y_PX by the time placeFreeItems
    // runs (see solveLayout), so [0, 0, boardW, boardH] is the real
    // rendered rectangle, not just the tight bbox of the pedals in it.
    for (const p of items) {
      const overlapX = Math.min(p.x + p.w + margin, boardW + margin) - Math.max(p.x - margin, -margin);
      const overlapY = Math.min(p.y + p.h + margin, boardH + margin) - Math.max(p.y - margin, -margin);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      if (overlapX < overlapY) {
        const dir = (p.x + p.w / 2) < boardW / 2 ? -1 : 1;
        p.x += dir * overlapX;
      } else {
        const dir = (p.y + p.h / 2) < boardH / 2 ? -1 : 1;
        p.y += dir * overlapY;
      }
    }
    if (!moved) break;
  }
}

// Places every free node -- guitar, amps, the PSU, and so on -- around
// the rectangle at its own real (x, y), not bucketed into a fixed
// compass column/row the way a CSS grid would force it to be (a grid
// area's align-items:center throws away
// exactly the "how far along this edge" information the search computes
// -- see the plan/commit message for why that was the actual bug behind
// free items landing far from what they connect to). Two rounds: the
// first can only anchor a node via its connections to *board* nodes
// (nothing free has a position yet); the second re-resolves every node's
// anchor with the first round's free-node positions folded in too, so a
// free<->free edge between two nodes that connect to nothing else gets a
// real anchor on both ends instead of an arbitrary fallback.
function placeFreeItems(freeNodes, links, boardPos, boardW, boardH) {
  const round1 = layoutBySide(assignEdges(freeNodes, links, boardPos, boardW, boardH), boardW, boardH);

  const resolved2 = new Map(boardPos);
  for (const [n, p] of round1.pos) resolved2.set(n, p);
  return layoutBySide(assignEdges(freeNodes, links, resolved2, boardW, boardH), boardW, boardH);
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
// each candidate row plan, lay out the rectangle (+ the sidebar, if any
// node has one), place every free node (see placeFreeItems), find the true
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

    // A sidebar node (if present) sits beside the row-stack, top-aligned,
    // full board-lower height -- same structure as today's .board-sidebar.
    let boardW = rowGeom.width, boardH = rowGeom.height;
    const boardPos = new Map();
    for (const [n, p] of rowGeom.pos) boardPos.set(n, p);
    if (sidebarNodes.length) {
      let sx = rowGeom.width + BOARD_LOWER_GAP_PX;
      for (const n of sidebarNodes) {
        const { w, h } = nodeSizePx(n);
        boardPos.set(n, { x: sx, y: 0, w, h });
        boardH = Math.max(boardH, h);
      }
      boardW = sx + Math.max(...sidebarNodes.map(n => nodeSizePx(n).w));
    }
    for (const [, p] of boardPos) { p.x += BOARD_PADDING_X_PX; p.y += BOARD_PADDING_Y_PX; }
    boardW += 2 * BOARD_PADDING_X_PX;
    boardH += 2 * BOARD_PADDING_Y_PX;

    const { pos: freePos } = placeFreeItems(freeNodes, links, boardPos, boardW, boardH);
    resolveFreeOverlaps(freePos, boardW, boardH);

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
// (.board -- the packed rows solveLayout chose, plus the sidebar, if any
// node has one, full-height alongside them, both still plain flex layout
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
  // by side -- top-aligned (not stretched/centered) so a pedal at the near
  // end of the bottom row, right beside the sidebar, has clearance
  // underneath for its `in` jack to route into.
  const boardLower = el('div', 'board-lower');
  const rowStack = el('div', 'board-rows');
  solved.rows.forEach((rowNodes, rowIdx) => {
    const reversed = (rowIdx % 2 === 0) !== solved.flip; // must match measureRows' identical rule exactly, or rendering would disagree with what was actually solved for
    const rowEl = el('div', 'chain board-row' + (reversed ? ' row-reverse' : ''));
    rowNodes.forEach(n => rowEl.append(renderNodeBox(n, nodeSizePx(n).w)));
    rowStack.append(rowEl);
  });
  boardLower.append(rowStack);

  if (sidebarNodes.length) {
    const sidebar = el('div', 'board-sidebar');
    sidebarNodes.forEach(n => sidebar.append(renderNodeBox(n, nodeSizePx(n).w)));
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

// Which kinds render dashed (mirrors style.css's own .connector-KIND
// stroke-dasharray assignments -- kept in sync by hand, there being no
// single shared source for it). Used only to decide which connectors get
// the traveling hover bulge (see wireConnectors): a dashed wire already
// gets a hover cue via the marching-dash animation, so a solid one is
// the one that benefits from its own moving highlight.
const DASHED_KINDS = new Set(['power', 'loop-out', 'loop-in']);

// One straight run of a routed path, from `start` to `end` (already
// shortened for the rounded corners roundedPathD puts at either end),
// with a small semicircular detour spliced in for each crossing recorded
// on this run by findConnectorHops -- so two wires that cross read as
// "one passes over the other" instead of an ambiguous X/T junction.
// Always bulges "up" for a horizontal run, "left" for a vertical one: an
// arbitrary but fixed choice (which side reads better varies case by
// case and isn't worth a heuristic), derived via the standard
// cross(direction, desiredBulge)<0 test for which SVG sweep-flag curves
// toward a given side of the chord.
function segmentD(start, end, hops) {
  if (!hops || hops.length === 0) return `L ${end[0]} ${end[1]} `;
  const [sx, sy] = start, [ex, ey] = end;
  const total = Math.hypot(ex - sx, ey - sy);
  const [dx, dy] = unit(ex - sx, ey - sy);
  const perp = dy === 0 ? [0, -1] : [-1, 0];
  const sweep = (dx * perp[1] - dy * perp[0]) < 0 ? 1 : 0;

  // Ordered by distance from `start` so each hop's radius can be clamped
  // against its actual neighbors on this run (previous hop's exit, next
  // hop's own reserved space) rather than a fixed budget blind to where
  // on the run it falls.
  const sorted = hops
    .map(h => ({ t: (h.x - sx) * dx + (h.y - sy) * dy }))
    .sort((a, b) => a.t - b.t);

  let d = '';
  let cursor = 0; // distance from start already emitted
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i].t;
    const nextT = i + 1 < sorted.length ? sorted[i + 1].t : total;
    const r = Math.min(HOP_RADIUS_PX, t - cursor, nextT - t);
    if (r < MIN_HOP_RADIUS_PX) continue; // no room -- leave this one plain
    const inX = sx + dx * (t - r), inY = sy + dy * (t - r);
    const outX = sx + dx * (t + r), outY = sy + dy * (t + r);
    d += `L ${inX} ${inY} A ${r} ${r} 0 0 ${sweep} ${outX} ${outY} `;
    cursor = t + r;
  }
  return d + `L ${ex} ${ey} `;
}

// Turns a routed polyline into a path string with rounded elbows, for the
// same soft-corner look the old jsPlumb Flowchart connector had: each
// interior vertex is shortened on both sides by `radius` and bridged with
// a quadratic curve through the original corner point. `hops` (from
// findConnectorHops, keyed by segment index -- the same `points` index
// space, before any rounding) get spliced into their run by segmentD.
function roundedPathD(points, radius, hops = []) {
  const n = points.length;
  const roundIn = new Array(n), roundOut = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    roundIn[i] = [x - (x - px) / inLen * r, y - (y - py) / inLen * r];
    roundOut[i] = [x + (nx - x) / outLen * r, y + (ny - y) / outLen * r];
  }

  const hopsBySeg = new Map();
  for (const hop of hops) {
    if (!hopsBySeg.has(hop.seg)) hopsBySeg.set(hop.seg, []);
    hopsBySeg.get(hop.seg).push(hop);
  }

  let d = `M ${points[0][0]} ${points[0][1]} `;
  for (let i = 0; i < n - 1; i++) {
    const start = i === 0 ? points[0] : roundOut[i];
    const end = i === n - 2 ? points[n - 1] : roundIn[i + 1];
    d += segmentD(start, end, hopsBySeg.get(i));
    if (i < n - 2) {
      d += `Q ${points[i + 1][0]} ${points[i + 1][1]} ${roundOut[i + 1][0]} ${roundOut[i + 1][1]} `;
    }
  }
  return d;
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
const MIN_STUB_PX = 18;
// How much extra stub length each successive connector touching the same
// node gets, on top of MIN_STUB_PX -- see the lane-assignment comment on
// wireConnectors for why this is keyed per-node rather than per-kind.
const LANE_STEP_PX = 20;

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
const POWER_BOLT_SIZE_PX = 11;
// svg/flash-lightning-svgrepo-com.svg's own <path d> and viewBox, embedded
// directly rather than loaded at runtime -- it's one fixed glyph, not
// user content, so there's nothing to gain from fetching it separately.
const POWER_BOLT_D = 'M34.137 20.862c-.475-.761-1.307-1.232-2.204-1.232h-6.356l6.707-16.032c.335-.802.248-1.717-.234-2.44C31.567.435 30.757 0 29.888 0h-8.444c-1.15 0-2.163.761-2.49 1.863l-7.283 24.565c-.233.786-.082 1.627.409 2.284.49.657 1.261 1.035 2.081 1.035h6.807l-1.189 14.106c-.083.987.548 1.898 1.503 2.164.955.264 1.962-.187 2.399-1.076l10.582-21.56c.396-.803.347-1.758-.126-2.519';
const POWER_BOLT_VIEWBOX = 46.093;

// The hover bulge (see wireConnectors) rides CSS motion path
// (offset-path/offset-distance) along the connector's own routed `d`,
// facing its direction of travel (offset-rotate: auto, set in style.css)
// so it reads as something riding the wire rather than drifting sideways
// across it. BULGE_SPEED_PX_S is a constant *apparent* speed, not a fixed
// duration -- connectors range from short stubs to long runs, and a
// single duration would make short ones look frantic and long ones
// sluggish; per-connector animation-duration is derived from each one's
// own routed length instead (see polylineLength), clamped so a very
// short stub still gets a readable minimum travel time.
const BULGE_SPEED_PX_S = 140;
const BULGE_MIN_DURATION_S = 0.5;

// Pac-Man body radius -- roughly double the old plain ellipse's total
// width, per "at a larger size of course".
const PACMAN_R_PX = 15;
const PACMAN_MOUTH_DEG = 42; // half-angle of the open mouth

// Both `d`s below describe the shape in its own local space, centered on
// (0,0) with the mouth (when open) facing local +x -- offset-path/
// offset-distance/offset-rotate (set per element in wireConnectors, same
// as the old ellipse) handle translating+rotating that origin along the
// connector, so "+x" ends up facing the actual direction of travel for
// free, same as the old bulge's own elongated axis did.
function pacmanClosedD(r) {
  // A full circle, drawn as two semicircle arcs -- a single arc command
  // can't sweep a full 360 degrees (needs distinct start/end points).
  return `M${-r},0 A${r},${r} 0 1,0 ${r},0 A${r},${r} 0 1,0 ${-r},0 Z`;
}
function pacmanOpenD(r, mouthDeg) {
  const rad = mouthDeg * Math.PI / 180;
  const x = r * Math.cos(rad), y = r * Math.sin(rad);
  return `M0,0 L${x},${-y} A${r},${r} 0 1,0 ${x},${y} Z`;
}

// Chomps a bulge/trace element between the two `d`s above via a plain SVG
// SMIL <animate> on the path's own `d` attribute, rather than a CSS
// @keyframes -- CSS can't interpolate between differently-shaped `d`s,
// but a hard discrete flip (calcMode="discrete") is exactly the classic
// 2-frame Pac-Man sprite anyway, not something smooth interpolation would
// even improve.
function addChomp(path) {
  const anim = document.createElementNS(SVG_NS, 'animate');
  anim.setAttribute('attributeName', 'd');
  anim.setAttribute('calcMode', 'discrete');
  anim.setAttribute('values', `${pacmanOpenD(PACMAN_R_PX, PACMAN_MOUTH_DEG)};${pacmanClosedD(PACMAN_R_PX)}`);
  anim.setAttribute('dur', '0.2s');
  anim.setAttribute('repeatCount', 'indefinite');
  path.append(anim);
}

// Builds one Pac-Man <path> for wireConnectors -- shared by the hover
// bulge and the click-triggered trace, which differ only in how their
// travel along the connector is driven (a looping CSS animation vs. a
// one-shot .animate() call, both set on the returned element by the
// caller).
function makePacman(className) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', className);
  path.setAttribute('d', pacmanClosedD(PACMAN_R_PX));
  addChomp(path);
  return path;
}

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

// A rhombus ("losange") centered on `center`, elongated along `dir` --
// unlike trianglePointsStr's arrowhead, this reads the same regardless of
// which way `dir` points, which is the point: an exp cable's signal
// flows both ways, so its endpoint marker shouldn't claim a direction.
function diamondPointsStr(center, dir, halfLen, halfWidth) {
  const [cx, cy] = center, [dx, dy] = dir;
  const px = -dy, py = dx;
  return [
    [cx + dx * halfLen, cy + dy * halfLen],
    [cx + px * halfWidth, cy + py * halfWidth],
    [cx - dx * halfLen, cy - dy * halfLen],
    [cx - px * halfWidth, cy - py * halfWidth],
  ].map(([x, y]) => `${x},${y}`).join(' ');
}

// End-of-connector markers for one routed connector, shape picked by
// kind: a small triangle (arrowhead) at both ends for the 4 signal kinds,
// a diamond at both ends for exp, a lightning bolt at the target end only
// for power. Each is positioned just past its pin, pulled ARROW_GAP_PX off
// the pedal border so the marker doesn't sit right on top of it -- built
// from the polyline's own first/last segments, so they follow whatever
// libavoid actually routed, not an assumed straight line. The wire itself
// (drawn separately from `points`) still runs all the way to the actual
// pin.
//
// For a signal kind (SIGNAL_KINDS), the two arrowheads are classed by
// which end they're on -- .connector-arrow-out / -in, colored green/red
// in style.css -- rather than by kind, so a loop-out/loop-in pair (which
// would otherwise look identical) still reads as two opposite flows
// regardless of which of the 4 signal kinds it is. Power bolts and exp
// diamonds keep their own kind's class (and thus color) on both ends,
// same as the line itself -- neither shape claims a direction, so there's
// nothing for the two ends to disagree about.
function connectorArrows(points, kind) {
  const [sx, sy] = points[0], [sx2, sy2] = points[1];
  const startForward = unit(sx2 - sx, sy2 - sy);

  const [ex, ey] = points[points.length - 1], [ex2, ey2] = points[points.length - 2];
  const endForward = unit(ex - ex2, ey - ey2);

  const isPower = kind === 'power';

  let ends;
  if (kind === 'exp') {
    const mid = ARROW_GAP_PX + ARROW_LEN_PX / 2;
    const startCenter = [sx + startForward[0] * mid, sy + startForward[1] * mid];
    const endCenter = [ex - endForward[0] * mid, ey - endForward[1] * mid];
    ends = [
      { shape: 'diamond', pts: diamondPointsStr(startCenter, startForward, ARROW_LEN_PX / 2, ARROW_HALF_WIDTH_PX), cls: 'exp' },
      { shape: 'diamond', pts: diamondPointsStr(endCenter, endForward, ARROW_LEN_PX / 2, ARROW_HALF_WIDTH_PX), cls: 'exp' },
    ];
  } else if (isPower) {
    // A lightning bolt at the pedal end only -- reads as "power" at a
    // glance without claiming a flow direction. No marker at the PSU end:
    // that it supplies power is already obvious from what it is.
    const mid = ARROW_GAP_PX + POWER_BOLT_SIZE_PX / 2;
    const endCenter = [ex - endForward[0] * mid, ey - endForward[1] * mid];
    ends = [
      { shape: 'bolt', cx: endCenter[0], cy: endCenter[1], cls: kind },
    ];
  } else {
    const startBase = [sx + startForward[0] * ARROW_GAP_PX, sy + startForward[1] * ARROW_GAP_PX];
    const startTip = [sx + startForward[0] * (ARROW_GAP_PX + ARROW_LEN_PX), sy + startForward[1] * (ARROW_GAP_PX + ARROW_LEN_PX)];
    const endTip = [ex - endForward[0] * ARROW_GAP_PX, ey - endForward[1] * ARROW_GAP_PX];
    const endBase = [ex - endForward[0] * (ARROW_GAP_PX + ARROW_LEN_PX), ey - endForward[1] * (ARROW_GAP_PX + ARROW_LEN_PX)];
    const isSignal = SIGNAL_KINDS.has(kind);
    ends = [
      { shape: 'triangle', pts: trianglePointsStr(startBase, startTip, ARROW_HALF_WIDTH_PX), cls: isSignal ? 'out' : kind },
      { shape: 'triangle', pts: trianglePointsStr(endBase, endTip, ARROW_HALF_WIDTH_PX), cls: isSignal ? 'in' : kind },
    ];
  }
  return ends.map((end) => {
    if (end.shape === 'bolt') {
      // A nested <svg> reproduces the icon's own viewBox scaling instead
      // of hand-computing a transform from its path's bounding box.
      const nested = document.createElementNS(SVG_NS, 'svg');
      nested.setAttribute('x', end.cx - POWER_BOLT_SIZE_PX / 2);
      nested.setAttribute('y', end.cy - POWER_BOLT_SIZE_PX / 2);
      nested.setAttribute('width', POWER_BOLT_SIZE_PX);
      nested.setAttribute('height', POWER_BOLT_SIZE_PX);
      nested.setAttribute('viewBox', `0 0 ${POWER_BOLT_VIEWBOX} ${POWER_BOLT_VIEWBOX}`);
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', POWER_BOLT_D);
      path.setAttribute('class', 'connector-arrow-' + end.cls);
      nested.append(path);
      return nested;
    }
    const polygon = document.createElementNS(SVG_NS, 'polygon');
    polygon.setAttribute('points', end.pts);
    polygon.setAttribute('class', 'connector-arrow-' + end.cls);
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
const SHAPE_BUFFER_PX = 10;
// Extra clearance baked directly into each image's own obstacle
// rectangle (see shapeInfoFor) -- a fallback for where SHAPE_BUFFER_PX's
// router-level clearance doesn't hold (see its comment above). Same
// tight-corridor caveat applies: can't create room that isn't there.
const OBSTACLE_MARGIN_PX = 3;
const CORNER_RADIUS_PX = 4;
const HOP_RADIUS_PX = 6;
const MIN_HOP_RADIUS_PX = 2; // below this a hop would be too small to read as anything but noise -- skip it, leave the crossing plain
const SVG_NS = 'http://www.w3.org/2000/svg';

// True where a link's own segment can participate in a hop -- either as
// the one that gets the bump, or as the one crossed under. Power wires
// are dashed, already visually deprioritized, and fully hideable via the
// header toggle (see index.html/style.css), so they're left out of the
// feature entirely: a crossing where either side is power is just drawn
// plain, same as before this existed.
function isHoppableKind(kind) {
  return kind !== 'power';
}

// 'h' or 'v' for an axis-aligned segment, null otherwise -- every segment
// libavoid produces is one or the other (ORTHOGONAL_CONN, see
// wireConnectors), so null only guards against a genuinely degenerate
// (zero-length) segment.
function segOrientation(p0, p1) {
  if (p0[1] === p1[1]) return 'h';
  if (p0[0] === p1[0]) return 'v';
  return null;
}

// Where a horizontal and a vertical segment cross, or null if they don't
// -- strictly in both segments' interiors, so two connectors merely
// sharing an endpoint (the common case near a node with several jacks
// close together) never registers as a crossing.
function hvCrossing(hSeg, vSeg) {
  const [hx0, hx1] = [hSeg[0][0], hSeg[1][0]].sort((a, b) => a - b);
  const hy = hSeg[0][1];
  const [vy0, vy1] = [vSeg[0][1], vSeg[1][1]].sort((a, b) => a - b);
  const vx = vSeg[0][0];
  if (vx > hx0 && vx < hx1 && hy > vy0 && hy < vy1) return [vx, hy];
  return null;
}

// Finds every crossing between two *different* connectors' routed paths
// (each already-drawn connector's own elbows never "cross" themselves)
// and decides, for each, which one gets the hop: whichever is later in
// `entries` -- paint order, since that's also SVG append order, so the
// later wire is already the one rendered on top. Returns one hops array
// per entry, indexed the same way, ready for roundedPathD.
function findConnectorHops(entries) {
  const hopsByIndex = entries.map(() => []);
  for (let i = 0; i < entries.length; i++) {
    if (!isHoppableKind(entries[i].kind)) continue;
    for (let k = i + 1; k < entries.length; k++) {
      if (!isHoppableKind(entries[k].kind)) continue;
      const ptsI = entries[i].points, ptsK = entries[k].points;
      for (let si = 0; si < ptsI.length - 1; si++) {
        const oriI = segOrientation(ptsI[si], ptsI[si + 1]);
        if (!oriI) continue;
        for (let sk = 0; sk < ptsK.length - 1; sk++) {
          const oriK = segOrientation(ptsK[sk], ptsK[sk + 1]);
          if (!oriK || oriK === oriI) continue;
          const segI = [ptsI[si], ptsI[si + 1]];
          const segK = [ptsK[sk], ptsK[sk + 1]];
          const cross = oriI === 'h' ? hvCrossing(segI, segK) : hvCrossing(segK, segI);
          if (!cross) continue;
          hopsByIndex[k].push({ seg: sk, x: cross[0], y: cross[1] });
        }
      }
    }
  }
  return hopsByIndex;
}

// Straight-segment sum along a routed polyline -- doesn't account for
// roundedPathD's corner rounding (a small fixed radius shaves a little
// off each bend), close enough for driving the hover bulge's travel
// speed (see BULGE_SPEED_PX_S), which has no need to be exact.
function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return len;
}

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
  // A soft cost added to a route's own search for each other connector it
  // would cross, on top of the router's usual shortest-path cost -- so a
  // detour that avoids a crossing wins over the direct route only when
  // the detour isn't drastically longer, never forbidding a crossing
  // outright when there's truly no better path. Node positions stay
  // exactly where the board layout put them; only the wires move.
  // (libavoid's C++ side also has a router-wide setHateCrossings/
  // doesHateCrossings toggle -- confirmed absent from Router's actual JS
  // bindings here, every method the embind wrapper exposes checked
  // directly, so crossingPenalty is the only lever available from this
  // side.) Whatever crossings remain after this still get
  // findConnectorHops' visual hop treatment (see roundedPathD), which is
  // a separate concern: this tries to prevent crossings, that one just
  // makes the ones that do happen unambiguous.
  router.setRoutingParameter(Avoid.RoutingParameter.crossingPenalty.value, 200);
  // libavoid's nudging options (nudgeOrthogonal*, performUnifyingNudging-
  // PreprocessingStep, nudgeSharedPathsWithCommonEndPoint) were used here
  // to keep parallel connectors from overlapping, but they also nudge a
  // connector's own endpoint off its actual pin -- confirmed by disabling
  // them: Tim.loopOut -> Brig.in went from a collapsed, ~30px-mispositioned
  // straight line to a correctly-shaped, sub-pixel-accurate route once
  // nudging was off. A pin landing on the wrong jack is worse than two
  // wires running close together, so nudging is out; overlap prevention
  // uses crossingPenalty and findConnectorHops instead (see above).

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
      const fromFrac = jackFraction(link.from, link.fromPoint);
      const toFrac = jackFraction(link.to, link.toPoint);
      const fromEdge = jackEdge(fromFrac);
      const toEdge = jackEdge(toFrac);
      // nextLane() is still called for both ends even when its result
      // goes unused below (stub override present) -- it's what keeps
      // *other* connectors on the same node spaced past this one; only
      // the length this particular connector is held to changes.
      const fromLane = nextLane(link.from);
      const toLane = nextLane(link.to);
      // stub is a fraction of the jack's own device width now, not an
      // absolute px count (see the vocabulary comment above) -- resolved
      // against nodeRealWidthPx here, where the actual node (not just its
      // jack fraction object) is still in scope.
      const fromMinLen = fromFrac.stub == null ? (MIN_STUB_PX + fromLane * LANE_STEP_PX) : fromFrac.stub * nodeRealWidthPx(link.from);
      const toMinLen = toFrac.stub == null ? (MIN_STUB_PX + toLane * LANE_STEP_PX) : toFrac.stub * nodeRealWidthPx(link.to);
      const label = `${link.from.name}.${link.fromPoint} -> ${link.to.name}.${link.toPoint}`;
      drawList.push({ connRef, kind: link.kind, insideLoop: link.insideLoop, fromEdge, toEdge, fromMinLen, toMinLen, label, fromId: link.from.id, toId: link.to.id });
    }
  }

  router.processTransaction();

  // Pass 1: resolve every connector's actual routed polyline first, and
  // only that -- no drawing yet. findConnectorHops (pass 2) needs every
  // path available to compare, not just the ones routed so far, and which
  // wire hops over which is decided by drawList order (paint order), so
  // that order has to already be final before either pass runs.
  for (const entry of drawList) {
    const poly = entry.connRef.displayRoute();
    const points = [];
    for (let i = 0; i < poly.size(); i++) {
      const p = poly.at(i);
      points.push([p.x, p.y]);
    }
    ensureMinStubPair(points, entry.fromEdge, entry.toEdge, entry.fromMinLen, entry.toMinLen);
    entry.points = points;
  }

  const hopsByIndex = findConnectorHops(drawList);

  // Every signal-kind connector's own {el, durationMs, toId, kind}, grouped by
  // source node id -- what traceFrom() walks to animate the guitar's
  // whole signal path one connector at a time on click. Rebuilt fresh
  // every route() call (a resize reroutes everything, elements included)
  // and handed back for main() to stash where traceFrom() can reach it.
  const traceEdgesByFromId = new Map();

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'connector-overlay');
  // SVG paints strictly in document order -- there's no z-index to lean
  // on the way .connector-overlay itself does against pedal photos (see
  // its own comment in style.css). A bulge/trace living inside its own
  // connector's <g> only ever paints above *that* connector's own wire,
  // not every other one -- whichever connector-group happens to get
  // appended later below paints right over it. One shared layer, held
  // back and appended after every connector-group (see the bottom of
  // this function), guarantees every monster, on any connector, paints
  // above every wire regardless of routing/append order.
  const pacmanLayer = document.createElementNS(SVG_NS, 'g');
  pacmanLayer.setAttribute('class', 'pacman-layer');
  drawList.forEach(({ points, kind, insideLoop, label, fromId, toId }, index) => {
    if (points.length < 2) return;
    const d = roundedPathD(points, CORNER_RADIUS_PX, hopsByIndex[index]);
    // Shared by both the hover bulge and the click-triggered trace ellipse
    // below -- same "constant apparent speed over this connector's own
    // routed length" math either way (see BULGE_SPEED_PX_S).
    const durationS = Math.max(BULGE_MIN_DURATION_S, polylineLength(points) / BULGE_SPEED_PX_S);
    // Everything belonging to one connector -- hit target, visible line,
    // arrows, hover bulge, trace ellipse -- lives in its own <g>, so the
    // hover rules in style.css can just say ".connector-group:hover" and
    // reach every one of this connector's own elements without caring
    // how many arrows it has or what order they were appended in.
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'connector-group');
    // A wide, invisible stroke laid right under the visible one -- the
    // visible stroke itself (1.5-2px) is too thin a target to hover
    // reliably. Shares the kind class too, so the power-connectors
    // toggle hides it the same way it hides the real path (see
    // style.css) -- otherwise a "hidden" power connector would still
    // light up on hover.
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'connector-hit connector-' + kind);
    group.append(hit);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'connector-' + kind + (insideLoop ? ' connector-loop-inside' : ''));
    path.setAttribute('data-link', label);
    group.append(path);
    // Unlike audio (through/loop/fork, one-way source->target) or power
    // (PSU->pedal, also one-way), an expression jack is a two-way control
    // loop: the receiving pedal supplies a reference voltage out to the
    // pot, the wiper position comes back in on the same cable. So exp
    // gets a non-directional diamond marker at both ends instead of an
    // arrowhead -- connectorArrows() picks the shape by kind.
    for (const arrow of connectorArrows(points, kind)) group.append(arrow);
    // Dashed kinds already get a hover cue from the marching-dash
    // animation (see style.css) -- only solid ones get their own
    // traveling highlight instead, so a wire never gets both at once.
    // insideLoop connectors are dashed too (connector-loop-inside, see
    // style.css) despite being an ordinary kind, same reasoning.
    if (!DASHED_KINDS.has(kind) && !insideLoop) {
      const bulge = makePacman('connector-bulge');
      bulge.style.offsetPath = `path("${d}")`;
      bulge.style.animationDuration = durationS + 's';
      // The bulge lives in the shared pacmanLayer now (see above), not
      // this connector's own group, so plain CSS `.connector-group:hover
      // > .connector-bulge` can no longer reach it -- these two listeners
      // are its replacement, toggling a class on the bulge directly
      // (style.css keys its hover look off .hovering instead). They fire
      // on the same hover boundary CSS :hover already used (the group's
      // own wide .connector-hit stroke, the only interactive thing in
      // it), so the trigger area is unchanged, just the wiring.
      group.addEventListener('mouseenter', () => bulge.classList.add('hovering'));
      group.addEventListener('mouseleave', () => bulge.classList.remove('hovering'));
      pacmanLayer.append(bulge);
    }
    // The click-cascade only ever follows the actual audio path (see
    // SIGNAL_KINDS) -- power/exp connectors sit out, same reasoning as
    // the hover bulge's own kind split just above, just a different axis
    // (signal vs not, rather than dashed vs not: loop-out/loop-in are
    // dashed *and* signal, so they get a march on hover but a trace
    // ellipse of their own here too). Driven by the Web Animations API
    // in traceFrom() rather than a CSS @keyframes/class toggle -- a
    // one-shot, JS-sequenced animation is exactly what .animate()'s
    // .finished promise is for, and it needs no cleanup dance to be
    // safely re-triggerable on the next click.
    if (SIGNAL_KINDS.has(kind)) {
      const trace = makePacman('connector-trace');
      trace.style.offsetPath = `path("${d}")`;
      pacmanLayer.append(trace); // shared layer too -- see pacmanLayer's own comment above
      if (!traceEdgesByFromId.has(fromId)) traceEdgesByFromId.set(fromId, []);
      traceEdgesByFromId.get(fromId).push({ el: trace, durationMs: durationS * 1000, toId, kind, d }); // d: lets showStartPreview (see startCascade) draw its own stationary pose on the same routed path without re-deriving it
    }
    svg.append(group);
  });
  svg.append(pacmanLayer); // last -- see pacmanLayer's own comment above for why document order matters here
  root.append(svg);
  return traceEdgesByFromId;
}

// Module-level so traceFrom() (called from a click handler set up back in
// renderNodeBox, long before any routing exists) always reads whatever
// wireConnectors most recently returned, rather than a stale map from
// whenever the node's own box happened to render (see route() in main()).
let TRACE_EDGES = new Map();

// --- Sound ---------------------------------------------------------------
//
// Three cues, three different concurrency rules, because they mean three
// different things:
//  - beginning: a one-shot gate. Nothing else starts until it finishes.
//  - chomp: a *state* ("something is traveling right now"), so it's
//    reference-counted -- a fork or a live loop can have more than one
//    connector animating at once, and the loop should only actually stop
//    once the last of them has landed, not restart a second overlapping
//    copy per connector.
//  - eatfruit: a one-shot *event* ("a signal just landed on an LED"). An
//    FX loop can land on two LEDs close together (see traceFrom), or two
//    free nodes a second or so apart -- rather than muting the later
//    trigger while an earlier one's still playing, it gets its own
//    overlapping instance (see playEatFruit's cloneNode) so both are
//    actually heard, layered, instead of the second one going silent.
//  - eatghost: the same one-shot-event shape as eatfruit, but for the
//    signal reaching a place="free" node (amp, PSU, ...) instead of a
//    pedal's own LED -- those have no LED to land on and so no eatfruit
//    clip of their own (see blinkLed), but arrival there should still
//    announce itself. One shared clip for every such node (not keyed per
//    node the way eatfruit is, since there's only the one clip), same
//    overlapping-instance behavior as eatfruit otherwise.
// Every eatfruit/eatghost instance currently playing (see playEatFruit/
// playEatGhost's own cloneNode) -- not just the cached originals, since an
// overlapping trigger spawns its own untracked clone that nothing else
// holds a reference to. Exists so TRACK_MODE (see exportTracking) can tell
// when it's actually safe to trigger the monster-track-*.json download:
// doing that mid-sound would surface a save/download popup right in the
// middle of a screen recording. Event-driven, not polled: oneShotIdleWaiters
// holds whatever's currently awaiting whenOneShotsIdle() (a plain array, not
// just one slot -- a second cascade could in principle start, and want its
// own wait, before an earlier one's trailing sound has finished), and gets
// notified the instant the set actually drains to zero.
const playingOneShots = new Set();
const oneShotIdleWaiters = [];
function trackOneShot(instance) {
  playingOneShots.add(instance);
  instance.addEventListener('ended', () => {
    playingOneShots.delete(instance);
    if (playingOneShots.size === 0) {
      oneShotIdleWaiters.splice(0).forEach(resolve => resolve());
    }
  }, { once: true });
}
function whenOneShotsIdle() {
  if (playingOneShots.size === 0) return Promise.resolve();
  return new Promise(resolve => oneShotIdleWaiters.push(resolve));
}

const SOUND_BEGINNING = new Audio('/sounds/pacman_beginning.mp3');
const SOUND_DEATH = new Audio('/sounds/pacman_death.mp3');
// Same shape as playBeginning below: resolves once the cue has actually
// finished playing (or immediately, if the browser refused to play it at
// all) -- TRACK_MODE chains its export off this instead of polling
// .paused, same reasoning as whenOneShotsIdle above.
function playDeath() {
  return new Promise(resolve => {
    SOUND_DEATH.currentTime = 0;
    SOUND_DEATH.addEventListener('ended', resolve, { once: true });
    SOUND_DEATH.play().catch(resolve);
  });
}
// The cascade's own natural finish (traceFrom running the whole signal
// path to its end, see startCascade) gets the arcade's between-levels
// jingle rather than the death cue -- death is reserved for a stop cut
// short by the user instead (see stopCascade), the opposite pairing from
// the arcade original but the one that reads right here: finishing the
// board is a good thing, only an interrupted cascade should sound like
// dying.
const SOUND_INTERMISSION = new Audio('/sounds/pacman_intermission.mp3');
function playIntermission() {
  return new Promise(resolve => {
    SOUND_INTERMISSION.currentTime = 0;
    SOUND_INTERMISSION.addEventListener('ended', resolve, { once: true });
    SOUND_INTERMISSION.play().catch(resolve);
  });
}
const DEFAULT_EATFRUIT_URL = '/sounds/pacman_eatfruit.mp3';
const DEFAULT_EATGHOST_URL = '/sounds/pacman_eatghost.mp3';
// Same per-node override + shared-cache-by-URL shape as eatFruitAudioFor
// below: config.json's `eatghost` (a filename under /sounds/) picks a
// free node's own clip; nodes without an override share one cached Audio
// for DEFAULT_EATGHOST_URL instead of each getting a redundant copy.
const eatGhostAudioByUrl = new Map();
function eatGhostAudioFor(nodeId) {
  const spec = NODES_BY_ID.get(nodeId)?.spec;
  const url = spec?.eatghost ? `/sounds/${spec.eatghost}` : DEFAULT_EATGHOST_URL;
  let audio = eatGhostAudioByUrl.get(url);
  if (!audio) {
    audio = new Audio(url);
    eatGhostAudioByUrl.set(url, audio);
  }
  return audio;
}

// cloneNode() rather than reusing the cached element directly when it's
// still playing -- two free nodes reached close together (e.g. the Fender and
// the Engl a second apart) should both be heard, overlapping, not have
// the second one silently dropped for landing mid-clip of the first.
// Only clones when actually needed: the common case (nothing else
// playing) still reuses the one cached element.
function playEatGhost(nodeId) {
  const audio = eatGhostAudioFor(nodeId);
  const instance = audio.paused ? audio : audio.cloneNode();
  instance.currentTime = 0;
  instance.play().catch(() => {});
  trackOneShot(instance);
}

// Gates the very start of a trace cascade (see the telecaster's click
// handler in renderNodeBox) -- awaited before traceFrom() is even called,
// so nothing moves or makes another sound until this finishes. Resolves
// (doesn't reject) even if the browser refuses autoplay -- a refused
// jingle shouldn't hang the whole cascade forever.
function playBeginning() {
  return new Promise(resolve => {
    SOUND_BEGINNING.currentTime = 0;
    SOUND_BEGINNING.addEventListener('ended', resolve, { once: true });
    SOUND_BEGINNING.play().catch(resolve);
  });
}

// Same declicking idea as DECLICK_S below, but for a plain <audio>
// element instead of a Web Audio graph -- HTMLMediaElement has no gain
// node to schedule a sample-accurate ramp on, so this is a coarser
// rAF-driven fade of its own .volume, only needed when stopCascade()
// interrupts one mid-playback (left to finish naturally, a one-shot
// never needs this at all).
function fadeOutAndReset(audio, ms = 30) {
  if (audio.paused) return;
  const start = performance.now();
  const startVolume = audio.volume;
  function step(now) {
    const t = Math.min(1, (now - start) / ms);
    audio.volume = startVolume * (1 - t);
    if (t < 1 && !audio.paused) {
      requestAnimationFrame(step);
    } else {
      audio.pause();
      audio.currentTime = 0;
      audio.volume = startVolume; // restore for next play()
    }
  }
  requestAnimationFrame(step);
}

// The chomp loop is the one cue that actually has to be *gapless* --
// HTMLMediaElement's own `loop` isn't sample-accurate (restarting a short
// clip re-enters the decode pipeline each cycle), which is exactly the
// audible seam this was built to fix even before the file had any actual
// silence to blame. Web Audio's AudioBufferSourceNode decodes the whole
// clip into memory once and loops the raw samples directly, so there's
// nothing left to glitch at the seam.
let audioCtx = null;
let chompGain = null; // see DECLICK_S below -- routes the chomp source through a rampable gain instead of straight to destination
function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    chompGain = audioCtx.createGain();
    chompGain.connect(audioCtx.destination);
  }
  return audioCtx;
}

// The manual LED toggle's off cue -- each toggleable node gets its own
// randomly-assigned excerpt of sounds/16-button-press-sounds.mp3 (see
// assignPressSounds, kicked off once from main()) instead of every node
// sharing one identical clip, for a little variety across the board.
// Falls back to the single press-button.mp3 sample below for a node with
// no assigned excerpt (the wav is still loading, or PRESS_SOUND_COUNT ran
// out -- see assignPressSounds). Not trackOneShot'd either way: unlike
// eatfruit/eatghost this never fires as part of a cascade, so TRACK_MODE's
// export (see whenOneShotsIdle) has no reason to wait on it.
const SOUND_OFF_CLICK = new Audio('/sounds/press-button.mp3');
function playOffClick(nodeId) {
  const buffer = NODES_BY_ID.get(nodeId)?.pressSoundBuffer;
  if (buffer) {
    playBufferOnce(buffer);
    return;
  }
  // Same cloneNode-if-still-playing shape as playEatGhost -- a rapid
  // double-toggle should still be heard twice, overlapping, not have the
  // second click silently dropped for landing mid-clip of the first.
  const instance = SOUND_OFF_CLICK.paused ? SOUND_OFF_CLICK : SOUND_OFF_CLICK.cloneNode();
  instance.currentTime = 0;
  instance.play().catch(() => {});
}

// Fires a decoded buffer once via a fresh source node -- unlike the
// HTMLAudioElement clips above, no cloneNode dance is needed for
// overlapping re-triggers: every call gets its own AudioBufferSourceNode.
async function playBufferOnce(buffer) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
}

// Copies one decoded AudioBuffer's `n` equal-length spans out into `n`
// standalone AudioBuffers -- 16-button-press-sounds.wav (see
// scripts/crop_evenly.py; .mp3 below is that same cropped file, just
// transcoded down for a far smaller download) has already been cropped so
// its N clips are exactly N equal slots back-to-back, meaning a plain
// sample-count split lands each slice on its own clip with no per-clip
// onset lookup needed.
function sliceBufferIntoN(buffer, n) {
  const ctx = getAudioCtx();
  const slotLen = Math.floor(buffer.length / n);
  const slices = [];
  for (let i = 0; i < n; i++) {
    const slice = ctx.createBuffer(buffer.numberOfChannels, slotLen, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      slice.copyToChannel(buffer.getChannelData(c).subarray(i * slotLen, (i + 1) * slotLen), c);
    }
    slices.push(slice);
  }
  return slices;
}

// Plain Fisher-Yates, in place.
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// One randomly-assigned excerpt per toggleable node (every node with a
// calibrated `led`, board or free alike -- same set renderNodeBox wires a
// click handler onto), so no two pedals' manual-off click sounds the same
// -- called once from main(), fire-and-forget: nothing needs to wait on
// this, a node just falls back to the shared press-button.mp3 (see
// playOffClick) for however long it takes to land. More eligible nodes
// than clips would mean some nodes share one; there currently aren't.
// See README.md's Credits section for where the source recording is from.
const PRESS_SOUND_COUNT = 16;
async function assignPressSounds(nodeList) {
  const ctx = getAudioCtx();
  const bytes = await fetch('/sounds/16-button-press-sounds.mp3').then(res => res.arrayBuffer());
  const buffer = await ctx.decodeAudioData(bytes);
  const slices = shuffle(sliceBufferIntoN(buffer, PRESS_SOUND_COUNT));
  const eligible = nodeList.filter(n => n.spec && n.spec.led);
  eligible.forEach((node, i) => { node.pressSoundBuffer = slices[i % slices.length]; });
}

// The svg/ folder's 8 music-*.svg icons, each one's own <path d>(s) plus
// whatever viewBox/transform/fill-vs-stroke its source file needs to
// reproduce it -- see buildMusicIcon. Embedded directly rather than
// fetched at runtime, same reasoning as POWER_BOLT_D: eight fixed glyphs,
// not user content. A couple came out of the same Sketch/Dribbble export
// as music-1005 (nested <g transform="translate(...)">s) -- those two
// transforms are flattened into the one `transform` below, same trick as
// music-1005 itself used to.
const MUSIC_ICONS = [
  { // music-1005-svgrepo-com.svg
    viewBox: '0 0 20 20',
    mode: 'fill',
    transform: 'translate(-204,-3599)',
    paths: ['M224,3601.05129 L224,3610.55901 C224,3612.90979 222.17612,3614.95492 219.888035,3614.89646 C217.266519,3614.82877 215.248971,3612.1662 216.234285,3609.31593 C216.777356,3607.74464 218.297755,3606.71797 219.920978,3606.69233 C220.695653,3606.68105 220.976173,3606.88208 222.003416,3607.24105 L222.003416,3604.12822 C222.003416,3603.56207 221.556181,3603.10258 221.005124,3603.10258 L213.018786,3603.10258 C212.467729,3603.10258 212.020494,3603.56207 212.020494,3604.12822 L212.020494,3614.65851 C212.020494,3617.02057 210.179644,3619.07289 207.881575,3618.99801 C205.681339,3618.92622 203.914362,3617.02775 204.00321,3614.73031 C204.090061,3612.51594 205.989811,3610.84209 208.147121,3610.79081 C209.166377,3610.76619 209.352059,3610.92619 210.02391,3611.34363 L210.02391,3601.05129 C210.02391,3599.91795 210.91838,3599 212.020494,3599 L222.003416,3599 C223.106529,3599 224,3599.91795 224,3601.05129'],
  },
  { // music-995-svgrepo-com.svg
    viewBox: '0 0 20 20',
    mode: 'fill',
    fillRule: 'evenodd',
    transform: 'translate(-204,-3639)',
    paths: ['M211.987988,3643 L221.997998,3643 L221.997998,3641 L211.987988,3641 L211.987988,3643 Z M209.985986,3639 L209.985986,3651.535 C208.984985,3651.195 208.726727,3651 207.997998,3651 C205.785786,3651 204,3652.791 204,3655 C204,3657.209 205.782783,3659 207.993994,3659 C210.205205,3659 211.987988,3657.209 211.987988,3655 L211.987988,3645 L221.997998,3645 L221.997998,3651.535 C220.996997,3651.195 220.738739,3651 220.01001,3651 C217.797798,3651 216.012012,3652.791 216.012012,3655 C216.012012,3657.209 217.794795,3659 220.006006,3659 C222.217217,3659 224,3657.209 224,3655 L224,3639 L209.985986,3639 Z'],
  },
  { // music-note-01-svgrepo-com.svg
    viewBox: '0 0 24 24',
    mode: 'stroke',
    strokeWidth: 2,
    strokeLinecap: true,
    paths: ['M9 18V6.35537C9 5.87383 9 5.63306 9.0876 5.43778C9.16482 5.26565 9.28917 5.11887 9.44627 5.0144C9.62449 4.89588 9.86198 4.8563 10.337 4.77714L19.137 3.31047C19.7779 3.20364 20.0984 3.15023 20.3482 3.243C20.5674 3.32441 20.7511 3.48005 20.8674 3.68286C21 3.91398 21 4.23889 21 4.8887V16M9 18C9 19.6568 7.65685 21 6 21C4.34315 21 3 19.6568 3 18C3 16.3431 4.34315 15 6 15C7.65685 15 9 16.3431 9 18ZM21 16C21 17.6568 19.6569 19 18 19C16.3431 19 15 17.6568 15 16C15 14.3431 16.3431 13 18 13C19.6569 13 21 14.3431 21 16Z'],
  },
  { // music-note-double-svgrepo-com.svg
    viewBox: '0 0 24 24',
    mode: 'fill',
    fillRule: 'evenodd',
    paths: ['M19.4506 1.22841C20.7282 0.863369 22 1.8227 22 3.15145V16C22 18.2091 20.2091 20 18 20C15.7909 20 14 18.2091 14 16C14 13.7909 15.7909 12 18 12C18.7286 12 19.4117 12.1948 20 12.5351V7.07142L10 9.92857V19C10 21.2091 8.20914 23 6 23C3.79086 23 2 21.2091 2 19C2 16.7909 3.79086 15 6 15C6.72857 15 7.41165 15.1948 8 15.5351V6.0086C8 5.11564 8.59196 4.33086 9.45056 4.08555L19.4506 1.22841ZM18.7669 3.36991C19.3815 3.18555 20 3.64573 20 4.28734C20 4.71033 19.7225 5.08323 19.3174 5.20477L11.2331 7.63008C10.6185 7.81444 10 7.35426 10 6.71265C10 6.28966 10.2775 5.91676 10.6826 5.79522L18.7669 3.36991ZM16.0167 16C16.0167 17.0953 16.9047 17.9833 18 17.9833C19.0954 17.9833 19.9833 17.0953 19.9833 16C19.9833 14.9046 19.0954 14.0167 18 14.0167C16.9047 14.0167 16.0167 14.9046 16.0167 16ZM4.0167 19C4.0167 20.0953 4.90465 20.9833 6 20.9833C7.09535 20.9833 7.9833 20.0953 7.9833 19C7.9833 17.9046 7.09535 17.0167 6 17.0167C4.90465 17.0167 4.0167 17.9046 4.0167 19Z'],
  },
  { // music-note-svgrepo-com (1).svg
    viewBox: '-4.5 0 32 32',
    mode: 'fill',
    transform: 'translate(-470,-620)',
    paths: ['M492.293,627.364 L485.636,620.707 C485.245,620.316 484.634,620.339 484.222,620.707 C483.925,620.973 484,621.453 484,622 L484,639.327 C481.781,637.683 478.119,637.68 474.876,639.553 C470.844,641.88 468.991,646.219 470.736,649.243 C472.482,652.267 477.166,652.831 481.198,650.503 C484.33,648.695 486.138,645.676 485.976,643 L486,643 L486,623.971 L490.879,628.778 C491.27,629.169 491.902,629.169 492.293,628.778 C492.684,628.388 492.684,627.755 492.293,627.364'],
  },
  { // music-note-svgrepo-com (3).svg
    viewBox: '0 0 24 24',
    mode: 'fill',
    fillRule: 'evenodd',
    paths: ['M18.6731 3.66678C18.0356 3.78024 17.1965 4.05792 15.9723 4.466L11.9723 5.79934C11.2959 6.02481 10.8487 6.17507 10.5192 6.32833C10.2072 6.47345 10.0724 6.59025 9.98595 6.71015C9.89953 6.83005 9.83138 6.99494 9.79235 7.33679C9.75113 7.69779 9.75 8.16956 9.75 8.88256V10.959L20.25 7.45895C20.2499 6.21736 20.2459 5.35983 20.1541 4.7342C20.0627 4.11097 19.906 3.88657 19.7309 3.76032C19.5557 3.63407 19.2933 3.55641 18.6731 3.66678ZM21.7402 5.99952C21.7279 5.43502 21.7003 4.93995 21.6382 4.51655C21.522 3.72389 21.2634 3.01586 20.608 2.54346C19.9525 2.07106 19.1991 2.04961 18.4103 2.18999C17.6516 2.32502 16.7078 2.63965 15.5559 3.02365L11.4584 4.38947C10.8321 4.59824 10.3027 4.77466 9.88651 4.96829C9.44407 5.17412 9.06018 5.42921 8.76908 5.83309C8.47799 6.23696 8.35738 6.68182 8.30203 7.16664C8.27376 7.41423 8.26085 7.69183 8.25495 7.99952H8.25V8.7587C8.25 8.78594 8.25 8.81336 8.25 8.84095L8.25 15.9992C7.62325 15.5285 6.8442 15.2495 6 15.2495C3.92893 15.2495 2.25 16.9285 2.25 18.9995C2.25 21.0706 3.92893 22.7495 6 22.7495C8.07107 22.7495 9.75 21.0706 9.75 18.9995V12.5401L20.25 9.04009V13.9992C19.6233 13.5285 18.8442 13.2495 18 13.2495C15.9289 13.2495 14.25 14.9285 14.25 16.9995C14.25 19.0706 15.9289 20.7495 18 20.7495C20.0711 20.7495 21.75 19.0706 21.75 16.9995V7.4881C21.75 7.45241 21.75 7.41692 21.75 7.38161V5.99952H21.7402ZM20.25 16.9995C20.25 15.7569 19.2426 14.7495 18 14.7495C16.7574 14.7495 15.75 15.7569 15.75 16.9995C15.75 18.2422 16.7574 19.2495 18 19.2495C19.2426 19.2495 20.25 18.2422 20.25 16.9995ZM8.25 18.9995C8.25 17.7569 7.24264 16.7495 6 16.7495C4.75736 16.7495 3.75 17.7569 3.75 18.9995C3.75 20.2422 4.75736 21.2495 6 21.2495C7.24264 21.2495 8.25 20.2422 8.25 18.9995Z'],
  },
  { // music-note-svgrepo-com copy.svg
    viewBox: '0 0 24 24',
    mode: 'stroke',
    strokeWidth: 1.91,
    paths: [
      'M11.4,21c-1.68,1.7-4.08,2.06-5.32.8s-.9-3.63.8-5.32,4.07-2,5.32-.8S13.1,19.31,11.4,21Z',
      'M18.67,11v-1C18.67,5.31,13,6.26,13,.54L13,18',
    ],
  },
  { // music-note-svgrepo-com.svg
    viewBox: '0 0 24 24',
    mode: 'fill',
    paths: ['M10.0909 11.9629L19.3636 8.63087V14.1707C18.8126 13.8538 18.1574 13.67 17.4545 13.67C15.4964 13.67 13.9091 15.096 13.9091 16.855C13.9091 18.614 15.4964 20.04 17.4545 20.04C19.4126 20.04 21 18.614 21 16.855C21 16.855 21 16.8551 21 16.855L21 7.49236C21 6.37238 21 5.4331 20.9123 4.68472C20.8999 4.57895 20.8852 4.4738 20.869 4.37569C20.7845 3.86441 20.6352 3.38745 20.347 2.98917C20.2028 2.79002 20.024 2.61055 19.8012 2.45628C19.7594 2.42736 19.716 2.39932 19.6711 2.3722L19.6621 2.36679C18.8906 1.90553 18.0233 1.93852 17.1298 2.14305C16.2657 2.34086 15.1944 2.74368 13.8808 3.23763L11.5963 4.09656C10.9806 4.32806 10.4589 4.52419 10.0494 4.72734C9.61376 4.94348 9.23849 5.1984 8.95707 5.57828C8.67564 5.95817 8.55876 6.36756 8.50501 6.81203C8.4545 7.22978 8.45452 7.7378 8.45455 8.33743V16.1307C7.90347 15.8138 7.24835 15.63 6.54545 15.63C4.58735 15.63 3 17.056 3 18.815C3 20.574 4.58735 22 6.54545 22C8.50355 22 10.0909 20.574 10.0909 18.815C10.0909 18.815 10.0909 18.8151 10.0909 18.815L10.0909 11.9629Z'],
  },
];

// One randomly-assigned glyph per node with its own attached sound (see
// renderSoundButton) -- board pedal or place="free" alike, anything with
// an LED. MUSIC_ICONS has fewer entries than today's eligible nodes, so
// icons.length wraps via i % icons.length -- some glyphs end up shared,
// which is fine, just no two *adjacent* assignments (thanks to the
// shuffle) look alike. Same idea as assignPressSounds' one-clip-per-node
// shuffle just above. Unlike that one, this runs synchronously (no audio
// to decode first) and must finish before renderNodeBox runs -- called
// right alongside it from main(), not fire-and-forget.
function assignSoundIcons(nodeList) {
  const eligible = nodeList.filter(n => n.spec && n.spec.led);
  const icons = shuffle(MUSIC_ICONS.slice());
  eligible.forEach((node, i) => { node.soundIcon = icons[i % icons.length]; });
}

// A hard stop/start on a raw AudioBufferSourceNode cuts the waveform at
// whatever sample it happens to be sitting on -- almost never zero -- and
// that instantaneous jump is exactly what a "click" *is* (a speaker being
// asked to move somewhere instantly instead of continuously). Every
// chomp start/stop below ramps chompGain across this many seconds first
// so there's nothing left to jump.
const DECLICK_S = 0.012;
const CHOMP_GAIN = 0.5; // chomp runs the whole cascade now (see startChompLoop) -- turned down so it sits behind eatfruit instead of dominating
// With more than one trace ellipse animating at once (a fork, e.g.
// P-Split, firing several outgoing edges in parallel -- see traceFrom),
// the same single shared loop is standing in for several simultaneous
// chomps at once, so it's let through less attenuated than the
// one-monster case above instead of sounding no different from it.
const CHOMP_GAIN_MULTI = 0.85;

// The gain the loop should currently be at, given how many trace
// ellipses (see activeAnimations) are animating right now.
function targetChompGain() {
  return activeAnimations.size > 1 ? CHOMP_GAIN_MULTI : CHOMP_GAIN;
}

// Re-ramps the already-running loop to whatever targetChompGain() says
// now -- called whenever activeAnimations' size changes (see
// fireTraceEdge), not just at start/stop, so the loop swells and settles
// as monsters join/leave a fork instead of staying fixed at whatever
// gain happened to apply when it started. A no-op while nothing's
// playing: startChompLoop reads targetChompGain() itself when it starts.
function updateChompGain() {
  if (!chompSource) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  chompGain.gain.cancelScheduledValues(now);
  chompGain.gain.setValueAtTime(chompGain.gain.value, now);
  chompGain.gain.linearRampToValueAtTime(targetChompGain(), now + DECLICK_S);
}

let chompBufferPromise = null;
function getChompBuffer() {
  if (!chompBufferPromise) {
    chompBufferPromise = fetch('/sounds/pacman_chomp-edited.mp3')
      .then(res => res.arrayBuffer())
      .then(bytes => getAudioCtx().decodeAudioData(bytes));
  }
  return chompBufferPromise;
}

let chompSource = null;
let chompGeneration = 0; // bumped on every stop, so a start still loading when the cascade ends doesn't outlive it

// One continuous loop for the *whole* cascade -- started once in
// startCascade, stopped once when it ends (naturally or via spacebar) --
// not restarted per connector the way it used to be. Besides being what
// was actually asked for (eatfruit cues now superpose on an unbroken
// chomp instead of interrupting it), it also means the declicked
// start/stop in DECLICK_S below only ever fires twice per cascade instead
// of once per connector, which was the bigger source of any residual
// click risk even after declicking each individual transition.
async function startChompLoop() {
  const myGeneration = ++chompGeneration;
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  const buffer = await getChompBuffer();
  if (myGeneration !== chompGeneration) return; // cascade already ended while this loaded
  chompSource = ctx.createBufferSource();
  chompSource.buffer = buffer;
  chompSource.loop = true;
  chompSource.connect(chompGain);
  const now = ctx.currentTime;
  chompGain.gain.cancelScheduledValues(now);
  chompGain.gain.setValueAtTime(0, now);
  chompGain.gain.linearRampToValueAtTime(targetChompGain(), now + DECLICK_S);
  chompSource.start();
}

// Fades chompGain to 0 before actually stopping the source, then schedules
// the stop itself for right after the ramp finishes -- by then it's
// already silent, so the cut lands on zero instead of mid-waveform.
// Shared by the cascade's own natural end (startCascade) and stopCascade
// (spacebar abort, mid-cascade).
function stopChompSource() {
  if (!chompSource) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  chompGain.gain.cancelScheduledValues(now);
  chompGain.gain.setValueAtTime(chompGain.gain.value, now);
  chompGain.gain.linearRampToValueAtTime(0, now + DECLICK_S);
  try { chompSource.stop(now + DECLICK_S); } catch { /* already stopped */ }
  chompSource = null;
}

// Every pedal's own eatfruit clip (config.json's `eatfruit`, a filename
// under /sounds/) gets one cached Audio, reused across calls the same
// way a pedal's own image is one file regardless of how many times it's
// drawn; pedals without an override all share one cached Audio for
// DEFAULT_EATFRUIT_URL instead of each getting their own redundant copy
// of the same clip. Keyed by URL rather than node id so that sharing
// falls out for free either way -- no separate "has an override or not"
// branch to keep in sync.
const eatFruitAudioByUrl = new Map();
function eatFruitAudioFor(nodeId) {
  const spec = NODES_BY_ID.get(nodeId)?.spec;
  const url = spec?.eatfruit ? `/sounds/${spec.eatfruit}` : DEFAULT_EATFRUIT_URL;
  let audio = eatFruitAudioByUrl.get(url);
  if (!audio) {
    audio = new Audio(url);
    eatFruitAudioByUrl.set(url, audio);
  }
  return audio;
}

// cloneNode() rather than reusing the cached element directly when it's
// still playing -- two pedals landing close together (an FX loop, see
// traceFrom, or just two arrivals a second or so apart) should both be
// heard, overlapping, rather than the later one going silent for landing
// mid-clip of the earlier. Only clones when actually needed: the common
// case (this clip not already playing) still reuses the cached element,
// so repeat triggers don't pile up new Audio objects for no reason.
function playEatFruit(nodeId) {
  const audio = eatFruitAudioFor(nodeId);
  const instance = audio.paused ? audio : audio.cloneNode();
  instance.currentTime = 0;
  instance.play().catch(() => {});
  trackOneShot(instance);
}

// The one arrival cue for any node the cascade reaches, regardless of
// whether it's a plain stop or a loop's own master (see traceFrom) --
// there used to be a "no sound on entering a loop master" rule, on the
// theory that the signal hasn't really left it yet, but that just read
// as a mysteriously silent pedal to anyone watching, so every node now
// announces itself the same way the moment it's reached. eatghost for a
// place="free" node (no LED to land on), eatfruit for one that has an
// LED, nothing for a board node with neither.
function playArrivalSound(nodeId) {
  if (NODES_BY_ID.get(nodeId)?.place === 'free') playEatGhost(nodeId);
  else if (ledElFor(nodeId)) playEatFruit(nodeId);
}

// id -> node object, so fireTraceEdge (below) can find a just-arrived-at
// node's LED without threading node references through the whole
// TRACE_EDGES/traceFrom cascade. Set once in main() -- unlike TRACE_EDGES
// this doesn't need rebuilding on resize: node objects (and node.ledEl,
// kept current by renderNodeBox on every relayout) are the same ones the
// whole run, only their DOM/geometry changes.
let NODES_BY_ID = new Map();

// Flicker rate itself lives in style.css's `led-blink` keyframes
// (animation-duration: 160ms per full on/off cycle, `infinite` -- so it's
// equally happy running for a fixed timeout below or for however long an
// FX loop's round trip takes, see traceFrom) -- LED_BLINK_DURATION_MS
// below only bounds the fixed-timeout case.
const LED_BLINK_DURATION_MS = 800; // 5 full on/off cycles before settling off

function ledElFor(nodeId) {
  return NODES_BY_ID.get(nodeId)?.ledEl;
}

// Swaps a node's own photo between its calibrated -off/-on variants (a
// config.json `file: [off, on]` pair, see makeNode) -- a node with a plain
// `file` string is untouched, still just its one static image. Callers
// below each already know which state applies
// for their own reason, so this takes it as a plain flag rather than
// reading it back off the .led-dot's own classList -- during a blink the
// dot can (see settleLedOn's comment) still be mid-transition between
// classes, which isn't a fact this should ever have to untangle.
function setLedImage(node, on) {
  if (!node || !node.hasLedImages) return;
  node.el.src = on ? node.ledOnSrc : node.ledOffSrc;
}

// Purely the visual -- callers wanting the arrival sound too call
// playArrivalSound themselves (see traceFrom and blinkLed below), since
// a loop's own master pedal wants its LED handled differently (lit for
// the whole round trip, not this fixed flicker) but the same sound. The
// flicker's own marching-dot animation (see style.css) plays out over the
// *on* photo, if this node has one (see setLedImage) -- same photo
// settleLedOn's permanently-lit end state switches to and stays on.
function startLedBlink(nodeId) {
  const led = ledElFor(nodeId);
  if (!led) return;
  led.classList.add('blinking');
  setLedImage(NODES_BY_ID.get(nodeId), true);
}

// Forces the LED fully off -- used to blank a node whose flicker got cut
// short by a manual stop (see stopCascade/cancelBlinkingLeds), or every
// node at once for a fresh run (see resetAllLeds) -- not by a natural
// arrival cue running to completion (see settleLedOn below for that case).
function stopLedBlink(nodeId) {
  const node = NODES_BY_ID.get(nodeId);
  node?.ledEl?.classList.remove('blinking', 'on', 'lit');
  if (node) node.ledIsOn = false;
  setLedImage(node, false);
}

// Every node's LED, forced off -- blanks the board back to its start-of-run
// look. Used by startCascade, so a repeat run's "everything lights up
// along the way" progression is visible again, rather than starting from
// last run's already-lit board; and by initPowerToggle, since no power
// means no device on the board can have a lit LED, pedals and free nodes
// alike. NOT used by a manual stop (see cancelBlinkingLeds below) -- a
// cut-short run should keep showing whatever it actually got through, not
// erase that progress.
function resetAllLeds() {
  for (const node of NODES_BY_ID.values()) stopLedBlink(node.id);
}

// A manual stop's version of the above: cancels only whatever's still
// mid-flicker (the signal never actually finished arriving there, so
// there's nothing to call "visited" yet -- same as if the cascade had
// never reached it) and leaves every already-settled-on node exactly as
// lit as it was. This sweep is what makes settleLedOn's own cascadeActive
// guard correct: once stopCascade flips that flag, a still-in-flight
// blinkLed/enterNode's later settleLedOn call becomes a no-op, so without
// this running synchronously right here, a node caught mid-blink would be
// left stuck showing 'blinking' forever instead of settling anywhere.
function cancelBlinkingLeds() {
  for (const node of NODES_BY_ID.values()) {
    if (node.ledEl?.classList.contains('blinking')) stopLedBlink(node.id);
  }
}

// A node's arrival flicker settling into a steady, permanently-lit state
// once the signal has actually passed through it -- unlike stopLedBlink,
// this is what "visited" looks like from here on, not "idle": the board
// fills in as the cascade runs, and the fully-lit end state is deliberate
// (see blinkLed/enterNode). Guarded by cascadeActive because a manual stop
// mid-flicker races this: cancelBlinkingLeds() may already have turned
// this same LED off by the time the awaited flicker/round-trip resolves,
// and that off should win, not be undone back to lit.
function settleLedOn(nodeId) {
  if (!cascadeActive) return;
  const node = NODES_BY_ID.get(nodeId);
  const led = node?.ledEl;
  if (!led) return;
  led.classList.remove('blinking');
  node.ledIsOn = true;
  // A hasLedImages node's own -on photo already shows it lit for real --
  // the synthetic dot glow this class draws would just double it up, so
  // it's skipped for exactly the nodes where setLedImage below isn't a
  // no-op (see ledIsOn's own comment, in makeNode, for why the toggle
  // handler tracks state explicitly instead of reading this class back).
  // 'lit' is added either way -- see its own comment in the manual-toggle
  // handler above.
  if (!node.hasLedImages) led.classList.add('on');
  led.classList.add('lit');
  setLedImage(node, true);
}

// --- Cascade control (spacebar toggle) ------------------------------------
//
// Space starts a cascade the same way clicking the traceable node does, or
// stops a running one dead -- so nobody's stuck sitting through a whole
// path's worth of chomping just because they clicked. `cascadeActive`
// gates every recursive step below (fireTraceEdge bails instead of
// recursing on, traceFrom bails before doing any work); `stopSignal` is
// what lets stopCascade() cut short a `setTimeout`-based wait (blinkLed's
// fixed flicker window) the same instant it cancels every in-flight
// Animation -- an Animation's own .finished promise settles the moment
// .cancel() is called, but a plain timer needs its own race to interrupt.
let cascadeActive = false;

// index.html?track=1 -- a recording aid (like ?config=NAME), not a
// visitor-facing feature: records the monster's own position throughout
// one cascade run and exports it as a JSON timeline, for cropping a
// vertical Reel out of a separately-recorded wide capture in post (see
// scripts/crop_to_reel.py). This replaces an earlier live in-browser
// panning camera that turned out fundamentally broken -- it panned
// .board-canvas directly via CSS transform, but .connector-overlay (every
// wire/arrow/monster) is a *sibling* of .board-canvas, not a child, so the
// two desynced the instant the camera moved. Recording this data instead
// of acting on it live sidesteps that whole problem: nothing on screen
// ever moves because of this.
const TRACK_MODE = new URLSearchParams(location.search).has('track');
let trackedPositions = [];
let trackStartTime = 0;
let trackLast = null;
let trackRafId = null;

// The point being tracked, in viewport coordinates, or null if nothing's
// currently traveling -- activeAnimations (the existing Set from
// fireTraceEdge) going empty does NOT mean the cascade is idle: it also
// happens for the ~800ms LED-flicker window at *every* plain pedal (see
// blinkLed/LED_BLINK_DURATION_MS), in the gap between one edge finishing
// and the next one firing. trackFrame below holds the last real position
// through those gaps rather than substituting a fixed point (e.g. the
// guitar) -- falling back to a fixed point would ping-pong the recorded
// position at every single hop in the chain, not just at the real start
// and end.
function sampleTrackTarget() {
  const rects = [...activeAnimations].map(anim => anim.effect.target.getBoundingClientRect());
  if (!rects.length) return null;
  const x = rects.reduce((sum, r) => sum + r.left + r.width / 2, 0) / rects.length;
  const y = rects.reduce((sum, r) => sum + r.top + r.height / 2, 0) / rects.length;
  return { x, y };
}

// Fractions (0-1) of #app's own box, not raw pixels -- keeps the export
// independent of whatever window size/DPI the recording actually happens
// at. Requires the recording itself to capture #app's content only (no
// browser chrome/DevTools panel around it), or the fractions won't line
// up with the video frame in scripts/crop_to_reel.py.
function toAppFraction(point) {
  const appRect = document.getElementById('app').getBoundingClientRect();
  return { x: (point.x - appRect.left) / appRect.width, y: (point.y - appRect.top) / appRect.height };
}

function trackFrame() {
  const target = sampleTrackTarget();
  if (target) trackLast = target;
  const { x, y } = toAppFraction(trackLast);
  trackedPositions.push({ t: performance.now() - trackStartTime, x, y });
  trackRafId = requestAnimationFrame(trackFrame);
}

// trackLast starts at the guitar's own position -- the same spot
// showStartPreview poses its stationary monster at during the opening
// jingle, which is exactly the window before any real edge has fired yet
// (see the gap comment above).
function startTracking() {
  const guitarImg = NODES_BY_ID.get(TRACEABLE_NODE_ID)?.el;
  if (!guitarImg) return;
  const r = guitarImg.getBoundingClientRect();
  trackLast = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  trackedPositions = [];
  trackStartTime = performance.now();
  trackRafId = requestAnimationFrame(trackFrame);
}

// Just the rAF loop -- called from setCascadeActive(false), immediately,
// same as every other piece of cascade-end bookkeeping there. The actual
// export is deliberately NOT triggered from here: see exportTracking's
// own comment for why it has to wait for startCascade/stopCascade's own
// final sound instead.
function stopTracking() {
  if (trackRafId != null) cancelAnimationFrame(trackRafId);
  trackRafId = null;
}

// Triggers the monster-track-*.json download -- callers (startCascade/
// stopCascade) are the ones responsible for not calling this until it's
// actually safe to: downloading mid-sound pops a save/download
// notification right in the middle of a screen recording, audibly and
// visibly interrupting it. They chain this off their own ending cue's
// promise (playIntermission()/playDeath()) and whenOneShotsIdle()
// together, rather than this function polling anything itself.
function exportTracking(positions) {
  const blob = new Blob([JSON.stringify(positions)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `monster-track-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// Single write site for cascadeActive -- every place that used to assign
// it directly goes through this instead, so the header's play/stop
// button (see index.html) and the power-wire march (see style.css) can
// never drift out of sync with the actual state, no matter which of the
// cascade's several triggers (this button, the guitar, spacebar) caused
// the change.
function setCascadeActive(active) {
  cascadeActive = active;
  document.body.classList.toggle('cascade-active', active);
  const button = document.getElementById('cascade-toggle');
  if (button) {
    button.classList.toggle('playing', active);
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? 'Stop the signal-path animation' : 'Play the signal-path animation';
  }
  if (TRACK_MODE) {
    if (active) startTracking();
    else stopTracking(); // export is triggered separately, by startCascade/stopCascade themselves -- see exportTracking's own comment
  }
}
let TRACEABLE_NODE_ID = null; // set once in renderNodeBox -- see its own comment on why there's exactly one
const activeAnimations = new Set();
let stopSignal = { promise: null, resolve: null };
function resetStopSignal() {
  stopSignal = { promise: null, resolve: null };
  stopSignal.promise = new Promise(res => { stopSignal.resolve = res; });
}
resetStopSignal();

// A one-off "get ready" pose, mouth open and holding still (no addChomp
// SMIL child, unlike every other Pac-Man makePacman builds -- nothing's
// actually moving yet), planted at offset-distance 0% on each of the
// guitar's own outgoing connectors while playBeginning()'s jingle plays.
// A plain new <path> per edge rather than reusing that edge's own
// .connector-trace: the trace's chomp animation runs continuously and
// indefinitely from the moment it's built (see addChomp), so there's no
// clean way to freeze it open on demand -- easier to draw a separate,
// throwaway shape on the same routed `d` (see wireConnectors) and just
// remove it once the real cascade takes over.
let startPreviewEls = [];
function showStartPreview() {
  const svg = document.querySelector('.connector-overlay');
  if (!svg) return;
  const edges = TRACE_EDGES.get(TRACEABLE_NODE_ID) || [];
  startPreviewEls = edges.map(({ d }) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'pacman-preview');
    path.setAttribute('d', pacmanOpenD(PACMAN_R_PX, PACMAN_MOUTH_DEG));
    path.style.offsetPath = `path("${d}")`;
    svg.append(path);
    return path;
  });
}
function hideStartPreview() {
  for (const path of startPreviewEls) path.remove();
  startPreviewEls = [];
}

async function startCascade() {
  if (cascadeActive || !TRACEABLE_NODE_ID) return;
  setCascadeActive(true);
  resetStopSignal();
  resetAllLeds(); // blank the board so a repeat run's LEDs-fill-in-as-it-goes progression is visible again, not starting from last run's already-lit state
  showStartPreview();
  await playBeginning(); // gates the whole cascade -- see playBeginning
  hideStartPreview(); // whether the jingle ran to completion or startCascade is about to bail below -- either way, the real cascade (or nothing) takes over from here
  if (!cascadeActive) return; // stopped while the jingle was still playing
  await startChompLoop(); // one continuous loop for the whole cascade -- see startChompLoop
  if (!cascadeActive) return; // stopped while the loop was still loading
  // propagateFrom, not traceFrom -- the guitar is where the signal
  // starts, not somewhere it's arrived at, so it skips enterNode's
  // arrival cue entirely (see traceFrom) rather than needing to suppress
  // it after the fact. Its own id still has to go into `dispatched` up
  // front, same as traceFrom would do for any other node, so a cycle
  // leading back to the guitar (were one ever wired up) can't retrigger it.
  await propagateFrom(TRACEABLE_NODE_ID, new Set([TRACEABLE_NODE_ID]));
  if (!cascadeActive) return; // aborted mid-flight -- stopCascade() already handled the chomp stop + its own death cue
  setCascadeActive(false);
  chompGeneration++;
  stopChompSource();
  // only reached when traceFrom ran the whole path to its own natural
  // end, not when stopCascade cut it short. TRACK_MODE's export chains
  // off this cue's own promise, then whenOneShotsIdle -- not called until
  // both the jingle and any still-finishing eatfruit/eatghost tail are
  // done; positions is snapshotted now, synchronously, since trackedPositions
  // itself could be reassigned by a new cascade before this chain resolves.
  const introFinished = playIntermission();
  if (TRACK_MODE) {
    const positions = trackedPositions;
    introFinished.then(whenOneShotsIdle).then(() => exportTracking(positions));
  }
}

// Resets every moving/sounding piece back to its idle state, synchronously
// -- the in-flight recursion unwinds in the background (each fireTraceEdge
// call sees cascadeActive go false and returns instead of continuing), but
// nothing should visibly wait on that: this makes the stop read as instant.
function stopCascade() {
  if (!cascadeActive) return;
  setCascadeActive(false);
  stopSignal.resolve();
  for (const anim of activeAnimations) anim.cancel();
  activeAnimations.clear();
  cancelBlinkingLeds();
  document.querySelectorAll('.connector-trace').forEach(trace => { trace.style.opacity = 0; });
  // Also covers a stop mid-jingle: fadeOutAndReset below only pauses
  // SOUND_BEGINNING, which never fires the 'ended' event playBeginning()
  // is awaiting in startCascade -- that await could sit unresolved far
  // longer than this stop takes, so the preview can't just wait for it.
  hideStartPreview();
  fadeOutAndReset(SOUND_BEGINNING);
  chompGeneration++; // invalidates any startChompLoop() still awaiting its buffer
  stopChompSource();
  // a stop cut short by the user is what death means here -- the
  // intermission jingle (see startCascade) is reserved for the cascade
  // finishing on its own
  const deathFinished = playDeath();
  // Deliberately not touched here: an eatfruit one-shot already playing
  // (e.g. Brig's own long delay tail) is short enough to just let finish
  // on its own rather than cut off mid-clip -- even across a stop and
  // later restart, not just while this one stays "active". The LEDs above
  // still reset visually right away; only the *sound* outlives it -- and
  // TRACK_MODE's export (below) waits out that tail too, same as it waits
  // for death itself, rather than exporting mid-clip.
  if (TRACK_MODE) {
    const positions = trackedPositions;
    deathFinished.then(whenOneShotsIdle).then(() => exportTracking(positions));
  }
}

function toggleCascade() {
  if (cascadeActive) stopCascade();
  else startCascade();
}

// Announces a just-reached node (see playArrivalSound) and, if it has an
// LED, flickers it for a fixed window before settling permanently lit (see
// settleLedOn) as the cascade pushes the bulge on out -- see traceFrom.
// Nodes with their own FX loop don't use this: their LED instead stays lit
// for the whole loop round trip (traceFrom handles that directly), same
// arrival sound either way.
//
// A node with no `led` calibrated in config.json has nothing to blink at
// all -- true of most place="free" nodes (amp, PSU, ...), though not all
// (see e.g. ironball/twin_reverb) -- so the sound alone is its whole cue,
// and traceFrom moves on right after.
async function blinkLed(nodeId) {
  playArrivalSound(nodeId);
  if (!ledElFor(nodeId)) return;
  startLedBlink(nodeId);
  await Promise.race([
    new Promise(res => setTimeout(res, LED_BLINK_DURATION_MS)),
    stopSignal.promise,
  ]);
  settleLedOn(nodeId);
}

// Plays one connector's own trace ellipse, then continues the cascade
// from its target -- see traceFrom.
async function fireTraceEdge({ el, durationMs, toId }, dispatched) {
  if (!cascadeActive) return;
  el.style.opacity = 1;
  const anim = el.animate(
    [{ offsetDistance: '0%' }, { offsetDistance: '100%' }],
    { duration: durationMs, easing: 'linear' }
  );
  activeAnimations.add(anim);
  updateChompGain(); // one more monster chomping at once -- see CHOMP_GAIN_MULTI
  await anim.finished.catch(() => {}); // a mid-flight resize reroutes and detaches this element, or stopCascade() cancels it -- either way, just stop, nothing to recover
  activeAnimations.delete(anim);
  updateChompGain(); // back down if that was the last of a fork's parallel monsters
  el.style.opacity = 0;
  if (!cascadeActive) return; // stopped mid-flight -- don't push the cascade on any further
  await traceFrom(toId, dispatched);
}

// Everything that happens on actually *arriving* at nodeId: the arrival
// sound (see playArrivalSound) and its LED's behavior, whichever fits --
// a plain fixed-duration flicker, or (for a node with its own loop) held
// lit for the entire loop round trip instead, since visually the signal
// really hasn't come back out yet (see propagateFrom below for what
// "come back out" fires). There used to be a "no sound here, the signal
// hasn't left yet" rule for a loop's own master pedal, but a pedal that
// just sits there silent while everything around it chomps away read as
// a bug rather than a deliberate loop, so every node's arrival sounds
// the same now regardless of what it does afterward -- only the LED
// still tells a loop apart from a plain stop. Whatever's patched into
// the loop (e.g. Brig) still gets its own independent arrival flicker as
// the bulge passes through *it* -- so more than one LED can be lit at
// once while a loop is live. Only ever called from traceFrom below, on
// a node the signal has actually just reached via some connector.
async function enterNode(nodeId, dispatched) {
  const loopOutEdges = (TRACE_EDGES.get(nodeId) || []).filter(e => e.kind === 'loop-out');
  if (loopOutEdges.length) {
    playArrivalSound(nodeId);
    startLedBlink(nodeId);
    await Promise.all(loopOutEdges.map(e => fireTraceEdge(e, dispatched)));
    settleLedOn(nodeId);
  } else {
    await blinkLed(nodeId);
  }
}

// Fires nodeId's own outgoing edges that aren't a loop-out (those are
// already handled, and awaited, inside enterNode above, *before* these --
// an insert's main `out` doesn't carry anything real until whatever's
// patched into its loop has actually returned it, so firing both at once
// would race the loop) -- every diverging branch at a fork (e.g.
// P-Split) fires in parallel. Shared by every node the cascade reaches,
// the guitar included (see startCascade): unlike enterNode, propagating
// onward isn't tied to "arriving" anywhere, it's just what happens next
// regardless of whether this node itself was entered or is where the
// whole cascade began.
async function propagateFrom(nodeId, dispatched) {
  const otherEdges = (TRACE_EDGES.get(nodeId) || []).filter(e => e.kind !== 'loop-out');
  await Promise.all(otherEdges.map(e => fireTraceEdge(e, dispatched)));
}

// Follows the signal path outward from `startId`: enterNode's arrival
// cue, then propagateFrom's fan-out. `dispatched` is what makes a cycle
// (Tim V3's send/return loop through Brig) terminate instead of
// re-triggering forever: a node sends its own outgoing edges at most
// once no matter how many different edges later lead back to it. This is
// only ever reached via an actual connector (see fireTraceEdge) -- the
// guitar's own start (see startCascade) calls propagateFrom directly
// instead, skipping enterNode entirely, since the guitar is where the
// signal *starts*, not somewhere it's arrived at.
async function traceFrom(startId, dispatched = new Set()) {
  if (!cascadeActive || dispatched.has(startId)) return;
  dispatched.add(startId);
  await enterNode(startId, dispatched);
  await propagateFrom(startId, dispatched);
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
// A real DOM measurement, not a formula: a long device name can wrap 2-3
// lines depending on width, which no constant could get right for every
// node. Built inside a `section.config` host so
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
    // renders. Every node's width is fixed, so this is exact.
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
  // cache: 'no-cache' -- not "don't cache", but "always revalidate with the
  // server first" (a conditional If-None-Match/If-Modified-Since request)
  // -- so an edit to config.dot/config.json shows up on next load without
  // needing a manual cache-buster the way style.css/app.js do (see
  // index.html): these are the files editing this app is actually meant
  // to involve.
  const [text, specs] = await Promise.all([
    fetch(`${configName}.dot`, { cache: 'no-cache' }).then(res => res.text()),
    fetch(`${configName}.json`, { cache: 'no-cache' }).then(res => res.json()),
  ]);
  PEDAL_SPECS = specs;
  // dotparser.min.js is a UMD build (global `dotParser`, not an ES
  // export), loaded via a classic <script> tag in index.html before this
  // one, so it's already on window here.
  const ast = window.dotParser.parse(text);
  const { nodeList, links, rowGroups } = buildModel(ast);
  NODES_BY_ID = new Map(nodeList.map(n => [n.id, n]));
  assignPressSounds(nodeList); // fire-and-forget -- see its own comment
  assignSoundIcons(nodeList); // synchronous, must finish before renderNodeBox runs below -- see its own comment
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
    TRACE_EDGES = wireConnectors(avoid, root, sections);
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

  // The static #loading spinner (see index.html) comes down once the
  // diagram is actually fully displayed -- rendered *and* routed, not
  // just rendered, so it doesn't disappear a beat before the wires
  // actually appear. `finally`, not just after the `await`: a failure
  // partway through (a bad config.dot, a network hiccup) should still
  // clear it rather than leave it spinning forever over a blank board.
  try {
    await relayoutAndRoute();
  } finally {
    document.getElementById('loading')?.remove();
  }

  // Self-heal for a rare first-load-only misrouting seen on real (slow,
  // uncached) network conditions -- never reproduced locally or with a
  // warm cache, so the actual race inside this first relayoutAndRoute()
  // isn't pinned down. What is confirmed: a *second* route() against the
  // exact same (by-then-settled) DOM always fixes it -- it's what a tiny
  // window resize already does by accident whenever this happens live.
  // Node positions from the first pass are already correct (only the
  // wires are ever wrong), so this only needs a fresh route(), not a
  // full relayout. Harmless if nothing was actually wrong: route() just
  // rebuilds the same overlay from the same geometry a second time.
  setTimeout(route, 1000);

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

  // Space starts/stops the trace cascade (see toggleCascade) -- the page
  // has no text inputs, but the hidden power-connectors-toggle checkbox
  // (index.html) is a real focusable control, so this steps aside for
  // any actual form control rather than assuming it always owns Space.
  window.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
    e.preventDefault(); // Space's default is page-scroll -- this isn't that
    toggleCascade();
  });
}

// Wires up the header's light/dark toggle (see index.html) -- independent
// of main()'s own async config/routing work below, and doesn't need to
// wait on it, since the checkbox is static markup already in the DOM by
// the time this script runs.
//
// "Resolved theme" is whichever of light/dark is actually painted right
// now: an explicit stored choice (already applied to <html> by the
// anti-flash inline script in index.html's <head>, before this file even
// loads) if there is one, otherwise whatever prefers-color-scheme says.
// The checkbox's own initial :checked state is set to match that, rather
// than hardcoded in the markup, so it never opens already disagreeing
// with what's on screen.
function resolvedThemeIsDark() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function initTheme() {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;
  toggle.checked = resolvedThemeIsDark();
  toggle.addEventListener('change', () => {
    const theme = toggle.checked ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch {}
  });
  // Keeps the checkbox (and thus the icon) honest if the OS theme changes
  // while this page has no explicit choice of its own stored yet -- once
  // one is stored, dataset.theme is always set and resolvedThemeIsDark
  // stops consulting this media query at all, so a system change no
  // longer has anything to do here.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) toggle.checked = resolvedThemeIsDark();
  });
}
initTheme();

// The header's power-toggle checkbox (see index.html) already hides the
// power wires on its own, purely in CSS -- but a device's LED isn't a wire,
// so nothing there ever touches it. Flipping power off is the one direction
// that needs JS: every node's LED goes dark, board and free nodes alike
// (resetAllLeds doesn't distinguish between them), same as if the whole
// board had just lost power. Flipping it back on deliberately does nothing
// here -- relighting LEDs on its own would be inventing a "cascade
// finished" moment nobody asked for; a real run (or a manual per-node
// click) is the only way an LED gets lit.
function initPowerToggle() {
  const toggle = document.getElementById('power-connectors-toggle');
  if (!toggle) return;
  toggle.addEventListener('change', () => {
    if (!toggle.checked) resetAllLeds();
  });
}
initPowerToggle();

// The header's third control (see index.html) -- a plain button, not a
// checkbox like the other two, since it doesn't hold a setting of its
// own: it just calls the same toggleCascade() the spacebar and the
// guitar's own click already do (see main()'s keydown listener and
// renderNodeBox), and setCascadeActive keeps its look in sync with
// cascadeActive regardless of which of those three actually changed it.
function initCascadeToggle() {
  const button = document.getElementById('cascade-toggle');
  if (!button) return;
  button.addEventListener('click', () => toggleCascade());
}
initCascadeToggle();

main();
